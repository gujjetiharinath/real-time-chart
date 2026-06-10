const WebSocket = require('ws');
const url = require('url');
const { verifyToken } = require('./auth');
const db = require('./database');

// Connection tracking: userId -> Set<WebSocket>
const clients = new Map();
// Track which rooms each connection is "watching"
const connectionRooms = new WeakMap();

function setupWebSocket(server) {
  const wss = new WebSocket.Server({ server });

  // ─── Heartbeat ───────────────────────────────────────────

  const HEARTBEAT_INTERVAL = 30000;

  function heartbeat() {
    this.isAlive = true;
  }

  const interval = setInterval(() => {
    wss.clients.forEach(ws => {
      if (ws.isAlive === false) {
        return ws.terminate();
      }
      ws.isAlive = false;
      ws.ping();
    });
  }, HEARTBEAT_INTERVAL);

  wss.on('close', () => clearInterval(interval));

  // ─── Connection Handler ──────────────────────────────────

  wss.on('connection', (ws, req) => {
    // Authenticate via query string token
    const params = url.parse(req.url, true).query;
    const user = verifyToken(params.token);

    if (!user) {
      ws.close(4001, 'Authentication failed');
      return;
    }

    ws.isAlive = true;
    ws.userId = user.id;
    ws.username = user.username;
    ws.on('pong', heartbeat);

    // Add to clients map
    if (!clients.has(user.id)) {
      clients.set(user.id, new Set());
    }
    clients.get(user.id).add(ws);
    connectionRooms.set(ws, new Set());

    // Update user status to online
    db.updateUserStatus(user.id, 'online');
    broadcastPresence(user.id, 'online');

    // Send initial data
    sendToSocket(ws, {
      type: 'connected',
      user: { id: user.id, username: user.username },
      onlineUsers: getOnlineUserIds()
    });

    // ─── Message Handler ─────────────────────────────────

    ws.on('message', (data) => {
      try {
        const message = JSON.parse(data.toString());
        handleMessage(ws, user, message);
      } catch (err) {
        console.error('Message parse error:', err);
        sendToSocket(ws, { type: 'error', message: 'Invalid message format' });
      }
    });

    // ─── Disconnect Handler ──────────────────────────────

    ws.on('close', () => {
      const userSockets = clients.get(user.id);
      if (userSockets) {
        userSockets.delete(ws);
        if (userSockets.size === 0) {
          clients.delete(user.id);
          db.updateUserStatus(user.id, 'offline');
          broadcastPresence(user.id, 'offline');
        }
      }
    });

    ws.on('error', (err) => {
      console.error('WebSocket error for user', user.username, ':', err.message);
    });
  });

  return wss;
}

// ─── Message Router ────────────────────────────────────────────

function handleMessage(ws, user, message) {
  switch (message.type) {
    case 'join_room':
      handleJoinRoom(ws, user, message);
      break;
    case 'leave_room':
      handleLeaveRoom(ws, user, message);
      break;
    case 'room_message':
      handleRoomMessage(ws, user, message);
      break;
    case 'private_message':
      handlePrivateMessage(ws, user, message);
      break;
    case 'typing':
      handleTyping(ws, user, message);
      break;
    case 'mark_read':
      // Acknowledge - used client-side to clear notifications
      break;
    default:
      sendToSocket(ws, { type: 'error', message: 'Unknown message type' });
  }
}

// ─── Room Handlers ─────────────────────────────────────────────

function handleJoinRoom(ws, user, message) {
  const { roomId } = message;
  if (!roomId) return;

  // Add to room tracking
  const rooms = connectionRooms.get(ws);
  if (rooms) rooms.add(roomId);

  // Ensure user is a member in DB
  db.joinRoom(roomId, user.id);

  // Notify room members
  broadcastToRoom(roomId, {
    type: 'user_joined',
    roomId,
    user: { id: user.id, username: user.username }
  }, user.id);

  // Send room members list
  const members = db.getRoomMembers(roomId);
  sendToSocket(ws, {
    type: 'room_members',
    roomId,
    members
  });
}

function handleLeaveRoom(ws, user, message) {
  const { roomId } = message;
  if (!roomId) return;

  const rooms = connectionRooms.get(ws);
  if (rooms) rooms.delete(roomId);

  db.leaveRoom(roomId, user.id);

  broadcastToRoom(roomId, {
    type: 'user_left',
    roomId,
    user: { id: user.id, username: user.username }
  });
}

function handleRoomMessage(ws, user, message) {
  const { roomId, content, messageType, fileUrl, fileName } = message;
  if (!roomId) return;
  if (!content && !fileUrl) return;

  // Save to database
  const result = db.saveMessage(
    user.id, roomId, null,
    content || null,
    messageType || 'text',
    fileUrl || null,
    fileName || null
  );

  const userInfo = db.getUserById(user.id);

  const outgoing = {
    type: 'room_message',
    id: result.lastInsertRowid,
    roomId,
    sender_id: user.id,
    sender_name: user.username,
    sender_color: userInfo ? userInfo.avatar_color : '#6c5ce7',
    content: content || null,
    message_type: messageType || 'text',
    file_url: fileUrl || null,
    file_name: fileName || null,
    created_at: new Date().toISOString()
  };

  // Broadcast to all members in the room
  broadcastToRoom(roomId, outgoing);

  // Send notification to room members who aren't watching this room
  const members = db.getRoomMembers(roomId);
  members.forEach(member => {
    if (member.id === user.id) return;
    const memberSockets = clients.get(member.id);
    if (memberSockets) {
      memberSockets.forEach(sock => {
        const watchingRooms = connectionRooms.get(sock);
        if (!watchingRooms || !watchingRooms.has(roomId)) {
          sendToSocket(sock, {
            type: 'notification',
            source: 'room',
            roomId,
            roomName: db.getRoomById(roomId)?.name,
            senderName: user.username,
            preview: content ? content.substring(0, 50) : `Shared a ${messageType || 'file'}`
          });
        }
      });
    }
  });
}

// ─── Private Message Handlers ──────────────────────────────────

function handlePrivateMessage(ws, user, message) {
  const { recipientId, content, messageType, fileUrl, fileName } = message;
  if (!recipientId) return;
  if (!content && !fileUrl) return;

  const recipient = db.getUserById(recipientId);
  if (!recipient) {
    sendToSocket(ws, { type: 'error', message: 'Recipient not found' });
    return;
  }

  // Save to database
  const result = db.saveMessage(
    user.id, null, recipientId,
    content || null,
    messageType || 'text',
    fileUrl || null,
    fileName || null
  );

  const userInfo = db.getUserById(user.id);

  const outgoing = {
    type: 'private_message',
    id: result.lastInsertRowid,
    sender_id: user.id,
    sender_name: user.username,
    sender_color: userInfo ? userInfo.avatar_color : '#6c5ce7',
    recipient_id: recipientId,
    content: content || null,
    message_type: messageType || 'text',
    file_url: fileUrl || null,
    file_name: fileName || null,
    created_at: new Date().toISOString()
  };

  // Send to recipient
  sendToUser(recipientId, outgoing);
  // Echo back to sender
  sendToUser(user.id, outgoing);

  // Notification if recipient has no active DM view with sender
  sendToUser(recipientId, {
    type: 'notification',
    source: 'dm',
    senderId: user.id,
    senderName: user.username,
    preview: content ? content.substring(0, 50) : `Shared a ${messageType || 'file'}`
  });
}

// ─── Typing Indicator ──────────────────────────────────────────

function handleTyping(ws, user, message) {
  const { roomId, recipientId, isTyping } = message;

  const payload = {
    type: 'typing',
    userId: user.id,
    username: user.username,
    isTyping: !!isTyping
  };

  if (roomId) {
    payload.roomId = roomId;
    broadcastToRoom(roomId, payload, user.id);
  } else if (recipientId) {
    payload.recipientId = recipientId;
    sendToUser(recipientId, payload);
  }
}

// ─── Utility Functions ─────────────────────────────────────────

function sendToSocket(ws, data) {
  if (ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(data));
  }
}

function sendToUser(userId, data) {
  const sockets = clients.get(userId);
  if (sockets) {
    sockets.forEach(ws => sendToSocket(ws, data));
  }
}

function broadcastToRoom(roomId, data, excludeUserId = null) {
  const members = db.getRoomMembers(roomId);
  members.forEach(member => {
    if (excludeUserId && member.id === excludeUserId) return;
    sendToUser(member.id, data);
  });
}

function broadcastPresence(userId, status) {
  const user = db.getUserById(userId);
  if (!user) return;

  const payload = {
    type: 'presence',
    userId,
    username: user.username,
    status,
    onlineUsers: getOnlineUserIds()
  };

  // Broadcast to all connected clients
  clients.forEach((sockets, uid) => {
    sockets.forEach(ws => sendToSocket(ws, payload));
  });
}

function getOnlineUserIds() {
  return Array.from(clients.keys());
}

module.exports = { setupWebSocket };
