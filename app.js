// ═══════════════════════════════════════════════════════════════
//  Real-Time Chat — Client Application
// ═══════════════════════════════════════════════════════════════

(() => {
  'use strict';

  // ─── State ──────────────────────────────────────────────────
  const state = {
    token: localStorage.getItem('chat_token'),
    user: JSON.parse(localStorage.getItem('chat_user') || 'null'),
    ws: null,
    rooms: [],
    onlineUsers: new Set(),
    currentChat: null,       // { type: 'room'|'dm', id: number }
    typingTimeouts: {},
    unreadCounts: {},        // key -> count  (room_1, dm_5, etc.)
    pendingFile: null,
    reconnectAttempts: 0,
    maxReconnect: 10,
    dmContacts: []
  };

  // ─── DOM References ─────────────────────────────────────────
  const $ = (sel) => document.querySelector(sel);
  const $$ = (sel) => document.querySelectorAll(sel);

  const dom = {
    authView: $('#auth-view'),
    chatView: $('#chat-view'),
    loginForm: $('#login-form'),
    registerForm: $('#register-form'),
    loginUsername: $('#login-username'),
    loginPassword: $('#login-password'),
    regUsername: $('#reg-username'),
    regPassword: $('#reg-password'),
    authError: $('#auth-error'),
    showRegister: $('#show-register'),
    showLogin: $('#show-login'),
    logoutBtn: $('#logout-btn'),
    userProfile: $('#current-user-profile'),
    roomList: $('#room-list'),
    dmList: $('#dm-list'),
    createRoomBtn: $('#create-room-btn'),
    createRoomModal: $('#create-room-modal'),
    createRoomForm: $('#create-room-form'),
    closeModalBtn: $('#close-modal-btn'),
    cancelRoomBtn: $('#cancel-room-btn'),
    newRoomName: $('#new-room-name'),
    newRoomDesc: $('#new-room-desc'),
    emptyState: $('#empty-state'),
    activeChat: $('#active-chat'),
    chatTitle: $('#chat-title'),
    chatSubtitle: $('#chat-subtitle'),
    messageList: $('#message-list'),
    messageForm: $('#message-form'),
    messageInput: $('#message-input'),
    sendBtn: $('#send-btn'),
    attachBtn: $('#attach-btn'),
    fileInput: $('#file-input'),
    uploadPreview: $('#upload-preview'),
    previewIcon: $('#preview-icon'),
    previewFilename: $('#preview-filename'),
    cancelUpload: $('#cancel-upload'),
    typingIndicator: $('#typing-indicator'),
    toastContainer: $('#toast-container'),
    rightSidebar: $('#right-sidebar'),
    toggleRightSidebar: $('#toggle-right-sidebar'),
    closeRightSidebar: $('#close-right-sidebar'),
    detailsTitle: $('#details-title'),
    detailsDesc: $('#details-desc'),
    memberList: $('#member-list'),
    mobileMenuBtn: $('#mobile-menu-btn')
  };

  // ─── API Helpers ────────────────────────────────────────────
  async function api(method, path, body = null) {
    const headers = { 'Content-Type': 'application/json' };
    if (state.token) headers['Authorization'] = `Bearer ${state.token}`;
    const opts = { method, headers };
    if (body) opts.body = JSON.stringify(body);
    const res = await fetch(`/api${path}`, opts);
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Request failed');
    return data;
  }

  // ─── Auth ───────────────────────────────────────────────────
  function initAuth() {
    dom.showRegister.addEventListener('click', (e) => {
      e.preventDefault();
      dom.loginForm.classList.add('hidden');
      dom.registerForm.classList.remove('hidden');
      dom.authError.style.display = 'none';
      $('.auth-header h1').textContent = 'Create Account';
      $('.auth-header p').textContent = 'Join Real-Time Chat today';
    });

    dom.showLogin.addEventListener('click', (e) => {
      e.preventDefault();
      dom.registerForm.classList.add('hidden');
      dom.loginForm.classList.remove('hidden');
      dom.authError.style.display = 'none';
      $('.auth-header h1').textContent = 'Welcome Back';
      $('.auth-header p').textContent = 'Sign in to continue to Real-Time Chat';
    });

    dom.loginForm.addEventListener('submit', async (e) => {
      e.preventDefault();
      try {
        const data = await api('POST', '/auth/login', {
          username: dom.loginUsername.value.trim(),
          password: dom.loginPassword.value
        });
        saveSession(data.token, data.user);
        enterChat();
      } catch (err) {
        showAuthError(err.message);
      }
    });

    dom.registerForm.addEventListener('submit', async (e) => {
      e.preventDefault();
      try {
        const data = await api('POST', '/auth/register', {
          username: dom.regUsername.value.trim(),
          password: dom.regPassword.value
        });
        saveSession(data.token, data.user);
        enterChat();
      } catch (err) {
        showAuthError(err.message);
      }
    });

    dom.logoutBtn.addEventListener('click', () => {
      logout();
    });
  }

  function showAuthError(msg) {
    dom.authError.textContent = msg;
    dom.authError.style.display = 'block';
  }

  function saveSession(token, user) {
    state.token = token;
    state.user = user;
    localStorage.setItem('chat_token', token);
    localStorage.setItem('chat_user', JSON.stringify(user));
  }

  function logout() {
    state.token = null;
    state.user = null;
    localStorage.removeItem('chat_token');
    localStorage.removeItem('chat_user');
    if (state.ws) state.ws.close();
    state.ws = null;
    state.currentChat = null;
    state.unreadCounts = {};
    dom.authView.classList.add('active');
    dom.chatView.classList.remove('active');
  }

  // ─── Enter Chat ─────────────────────────────────────────────
  async function enterChat() {
    dom.authView.classList.remove('active');
    dom.chatView.classList.add('active');

    renderUserProfile();
    connectWebSocket();
    await loadRooms();
    await loadDMContacts();
  }

  function renderUserProfile() {
    const initial = state.user.username.charAt(0).toUpperCase();
    dom.userProfile.innerHTML = `
      <div class="avatar" style="background:${state.user.avatar_color}">
        ${initial}
        <span class="status-dot online"></span>
      </div>
      <div class="item-info">
        <div class="item-name">${escapeHtml(state.user.username)}</div>
        <div class="item-meta">Online</div>
      </div>
    `;
  }

  // ─── WebSocket ──────────────────────────────────────────────
  function connectWebSocket() {
    if (state.ws && state.ws.readyState === WebSocket.OPEN) return;

    const protocol = location.protocol === 'https:' ? 'wss' : 'ws';
    state.ws = new WebSocket(`${protocol}://${location.host}?token=${state.token}`);

    state.ws.onopen = () => {
      console.log('WebSocket connected');
      state.reconnectAttempts = 0;
      // Rejoin current room if any
      if (state.currentChat?.type === 'room') {
        wsSend({ type: 'join_room', roomId: state.currentChat.id });
      }
    };

    state.ws.onmessage = (event) => {
      try {
        const msg = JSON.parse(event.data);
        handleWSMessage(msg);
      } catch (err) {
        console.error('WS message parse error:', err);
      }
    };

    state.ws.onclose = (event) => {
      if (event.code === 4001) {
        logout();
        return;
      }
      // Reconnect with exponential backoff
      if (state.token && state.reconnectAttempts < state.maxReconnect) {
        const delay = Math.min(1000 * Math.pow(2, state.reconnectAttempts), 30000);
        state.reconnectAttempts++;
        console.log(`Reconnecting in ${delay}ms (attempt ${state.reconnectAttempts})...`);
        setTimeout(connectWebSocket, delay);
      }
    };

    state.ws.onerror = () => {};
  }

  function wsSend(data) {
    if (state.ws && state.ws.readyState === WebSocket.OPEN) {
      state.ws.send(JSON.stringify(data));
    }
  }

  // ─── WebSocket Message Router ───────────────────────────────
  function handleWSMessage(msg) {
    switch (msg.type) {
      case 'connected':
        state.onlineUsers = new Set(msg.onlineUsers);
        updatePresenceUI();
        break;

      case 'room_message':
        handleIncomingRoomMessage(msg);
        break;

      case 'private_message':
        handleIncomingPrivateMessage(msg);
        break;

      case 'typing':
        handleTypingEvent(msg);
        break;

      case 'presence':
        state.onlineUsers = new Set(msg.onlineUsers);
        updatePresenceUI();
        break;

      case 'notification':
        handleNotification(msg);
        break;

      case 'user_joined':
        if (state.currentChat?.type === 'room' && state.currentChat.id === msg.roomId) {
          loadRoomMembers(msg.roomId);
        }
        break;

      case 'user_left':
        if (state.currentChat?.type === 'room' && state.currentChat.id === msg.roomId) {
          loadRoomMembers(msg.roomId);
        }
        break;

      case 'room_members':
        if (state.currentChat?.type === 'room' && state.currentChat.id === msg.roomId) {
          renderMemberList(msg.members);
        }
        break;

      case 'error':
        console.error('Server error:', msg.message);
        break;
    }
  }

  // ─── Room Management ────────────────────────────────────────
  async function loadRooms() {
    try {
      const data = await api('GET', '/rooms');
      state.rooms = data.rooms;
      renderRoomList();
    } catch (err) {
      console.error('Load rooms error:', err);
    }
  }

  function renderRoomList() {
    dom.roomList.innerHTML = state.rooms.map(room => {
      const isActive = state.currentChat?.type === 'room' && state.currentChat.id === room.id;
      const unreadKey = `room_${room.id}`;
      const unread = state.unreadCounts[unreadKey] || 0;
      return `
        <li class="nav-item ${isActive ? 'active' : ''}" data-room-id="${room.id}">
          <div class="avatar small" style="background: linear-gradient(135deg, #6c5ce7, #00cec9)">
            <span style="font-size:14px">#</span>
          </div>
          <div class="item-info">
            <div class="item-name">${escapeHtml(room.name)}</div>
            <div class="item-meta">${room.member_count || 0} members</div>
          </div>
          ${unread > 0 ? `<span class="badge">${unread}</span>` : ''}
        </li>
      `;
    }).join('');

    dom.roomList.querySelectorAll('.nav-item').forEach(item => {
      item.addEventListener('click', () => {
        const roomId = parseInt(item.dataset.roomId);
        openRoom(roomId);
      });
    });
  }

  async function openRoom(roomId) {
    // Leave previous room
    if (state.currentChat?.type === 'room' && state.currentChat.id !== roomId) {
      wsSend({ type: 'leave_room', roomId: state.currentChat.id });
    }

    const room = state.rooms.find(r => r.id === roomId);
    if (!room) return;

    // Join room if not a member
    if (!room.is_member) {
      try {
        await api('POST', `/rooms/${roomId}/join`);
        room.is_member = true;
      } catch (err) {
        console.error('Join room error:', err);
      }
    }

    state.currentChat = { type: 'room', id: roomId };
    clearUnread(`room_${roomId}`);

    // Update UI
    dom.emptyState.classList.remove('active');
    dom.emptyState.classList.add('hidden');
    dom.activeChat.classList.remove('hidden');
    dom.chatTitle.textContent = `# ${room.name}`;
    dom.chatSubtitle.textContent = room.description || `${room.member_count || 0} members`;
    dom.detailsTitle.textContent = room.name;
    dom.detailsDesc.textContent = room.description || 'No description';

    renderRoomList();
    renderDMList();

    // Join via WebSocket
    wsSend({ type: 'join_room', roomId });

    // Load history
    await loadRoomHistory(roomId);
    loadRoomMembers(roomId);

    // Focus input
    dom.messageInput.focus();
  }

  async function loadRoomHistory(roomId) {
    try {
      const data = await api('GET', `/rooms/${roomId}/messages?limit=50`);
      dom.messageList.innerHTML = '';
      data.messages.forEach(msg => appendMessage(msg));
      scrollToBottom();
    } catch (err) {
      console.error('Load history error:', err);
    }
  }

  async function loadRoomMembers(roomId) {
    try {
      const data = await api('GET', `/rooms/${roomId}/members`);
      renderMemberList(data.members);
    } catch (err) {
      console.error('Load members error:', err);
    }
  }

  function renderMemberList(members) {
    dom.memberList.innerHTML = members.map(m => {
      const isOnline = state.onlineUsers.has(m.id);
      const initial = m.username.charAt(0).toUpperCase();
      return `
        <li class="nav-item" data-user-id="${m.id}">
          <div class="avatar small" style="background:${m.avatar_color}">
            ${initial}
            <span class="status-dot ${isOnline ? 'online' : ''}"></span>
          </div>
          <div class="item-info">
            <div class="item-name">${escapeHtml(m.username)}${m.id === state.user.id ? ' (you)' : ''}</div>
            <div class="item-meta">${isOnline ? 'Online' : 'Offline'}</div>
          </div>
        </li>
      `;
    }).join('');
  }

  // ─── Direct Messages ────────────────────────────────────────
  async function loadDMContacts() {
    try {
      const data = await api('GET', '/rooms/dm/contacts');
      state.dmContacts = data.contacts || [];

      // Also load all users for potential new DMs
      const usersData = await api('GET', '/rooms/users');
      const allUsers = usersData.users || [];

      // Merge: existing contacts first, then remaining users
      const contactIds = new Set(state.dmContacts.map(c => c.contact_id));
      allUsers.forEach(u => {
        if (!contactIds.has(u.id)) {
          state.dmContacts.push({
            contact_id: u.id,
            username: u.username,
            avatar_color: u.avatar_color,
            status: u.status
          });
        }
      });

      renderDMList();
    } catch (err) {
      console.error('Load DM contacts error:', err);
    }
  }

  function renderDMList() {
    dom.dmList.innerHTML = state.dmContacts.map(contact => {
      const isActive = state.currentChat?.type === 'dm' && state.currentChat.id === contact.contact_id;
      const isOnline = state.onlineUsers.has(contact.contact_id);
      const initial = contact.username.charAt(0).toUpperCase();
      const unreadKey = `dm_${contact.contact_id}`;
      const unread = state.unreadCounts[unreadKey] || 0;
      return `
        <li class="nav-item ${isActive ? 'active' : ''}" data-dm-id="${contact.contact_id}">
          <div class="avatar small" style="background:${contact.avatar_color}">
            ${initial}
            <span class="status-dot ${isOnline ? 'online' : ''}"></span>
          </div>
          <div class="item-info">
            <div class="item-name">${escapeHtml(contact.username)}</div>
            <div class="item-meta">${isOnline ? 'Online' : 'Offline'}</div>
          </div>
          ${unread > 0 ? `<span class="badge">${unread}</span>` : ''}
        </li>
      `;
    }).join('');

    dom.dmList.querySelectorAll('.nav-item').forEach(item => {
      item.addEventListener('click', () => {
        const userId = parseInt(item.dataset.dmId);
        openDM(userId);
      });
    });
  }

  async function openDM(userId) {
    // Leave room if in one
    if (state.currentChat?.type === 'room') {
      wsSend({ type: 'leave_room', roomId: state.currentChat.id });
    }

    const contact = state.dmContacts.find(c => c.contact_id === userId);
    if (!contact) return;

    state.currentChat = { type: 'dm', id: userId };
    clearUnread(`dm_${userId}`);

    const isOnline = state.onlineUsers.has(userId);

    dom.emptyState.classList.remove('active');
    dom.emptyState.classList.add('hidden');
    dom.activeChat.classList.remove('hidden');
    dom.chatTitle.textContent = contact.username;
    dom.chatSubtitle.textContent = isOnline ? 'Online' : 'Offline';
    dom.detailsTitle.textContent = contact.username;
    dom.detailsDesc.textContent = 'Direct message';
    dom.memberList.innerHTML = '';

    renderRoomList();
    renderDMList();

    // Load DM history
    try {
      const data = await api('GET', `/rooms/dm/${userId}/messages?limit=50`);
      dom.messageList.innerHTML = '';
      data.messages.forEach(msg => appendMessage(msg));
      scrollToBottom();
    } catch (err) {
      console.error('Load DM history error:', err);
    }

    dom.messageInput.focus();
  }

  // ─── Message Handling ───────────────────────────────────────
  function handleIncomingRoomMessage(msg) {
    if (state.currentChat?.type === 'room' && state.currentChat.id === msg.roomId) {
      appendMessage(msg);
      scrollToBottom();
    } else {
      incrementUnread(`room_${msg.roomId}`);
      renderRoomList();
    }
  }

  function handleIncomingPrivateMessage(msg) {
    const otherUserId = msg.sender_id === state.user.id ? msg.recipient_id : msg.sender_id;

    if (state.currentChat?.type === 'dm' && state.currentChat.id === otherUserId) {
      // Avoid duplicate: only append if not already rendered (same ID)
      if (!document.querySelector(`[data-msg-id="${msg.id}"]`)) {
        appendMessage(msg);
        scrollToBottom();
      }
    } else if (msg.sender_id !== state.user.id) {
      incrementUnread(`dm_${msg.sender_id}`);
      // Add contact if new
      if (!state.dmContacts.find(c => c.contact_id === msg.sender_id)) {
        state.dmContacts.unshift({
          contact_id: msg.sender_id,
          username: msg.sender_name,
          avatar_color: msg.sender_color,
          status: 'online'
        });
      }
      renderDMList();
    }
  }

  function appendMessage(msg) {
    const isSent = msg.sender_id === state.user.id;
    const initial = (msg.sender_name || '?').charAt(0).toUpperCase();
    const time = formatTime(msg.created_at);

    const group = document.createElement('div');
    group.className = `message-group ${isSent ? 'sent' : 'received'}`;
    group.dataset.msgId = msg.id;

    let contentHtml = '';

    if (msg.message_type === 'image' && msg.file_url) {
      contentHtml += `<img src="${escapeHtml(msg.file_url)}" alt="shared image" class="msg-image" onclick="window.open('${escapeHtml(msg.file_url)}','_blank')">`;
      if (msg.content) contentHtml += `<div>${escapeHtml(msg.content)}</div>`;
    } else if (msg.message_type === 'video' && msg.file_url) {
      contentHtml += `<video controls class="msg-video"><source src="${escapeHtml(msg.file_url)}"></video>`;
      if (msg.content) contentHtml += `<div>${escapeHtml(msg.content)}</div>`;
    } else if (msg.message_type === 'audio' && msg.file_url) {
      contentHtml += `<audio controls class="msg-audio"><source src="${escapeHtml(msg.file_url)}"></audio>`;
      if (msg.content) contentHtml += `<div>${escapeHtml(msg.content)}</div>`;
    } else if (msg.message_type === 'file' && msg.file_url) {
      contentHtml += `
        <a href="${escapeHtml(msg.file_url)}" target="_blank" download class="msg-file">
          <span class="material-symbols-rounded msg-file-icon">description</span>
          <div class="msg-file-info">
            <span class="msg-file-name">${escapeHtml(msg.file_name || 'File')}</span>
            <span class="msg-file-download">Click to download</span>
          </div>
        </a>`;
      if (msg.content) contentHtml += `<div>${escapeHtml(msg.content)}</div>`;
    } else {
      contentHtml = formatMessageText(msg.content || '');
    }

    group.innerHTML = `
      ${!isSent ? `<div class="avatar small" style="background:${msg.sender_color || '#6c5ce7'}">${initial}</div>` : ''}
      <div class="message-content-wrapper">
        <div class="message-meta">
          <span class="message-sender">${escapeHtml(msg.sender_name || 'Unknown')}</span>
          <span class="message-time">${time}</span>
        </div>
        <div class="message-bubble">${contentHtml}</div>
      </div>
    `;

    dom.messageList.appendChild(group);
  }

  function formatMessageText(text) {
    // Basic link detection
    const urlPattern = /(https?:\/\/[^\s]+)/g;
    let escaped = escapeHtml(text);
    escaped = escaped.replace(urlPattern, '<a href="$1" target="_blank" rel="noopener">$1</a>');
    return escaped;
  }

  function scrollToBottom() {
    requestAnimationFrame(() => {
      dom.messageList.scrollTop = dom.messageList.scrollHeight;
    });
  }

  // ─── Send Message ───────────────────────────────────────────
  function initMessageForm() {
    dom.messageForm.addEventListener('submit', async (e) => {
      e.preventDefault();
      const text = dom.messageInput.value.trim();

      if (!state.currentChat) return;

      // Handle file upload
      if (state.pendingFile) {
        await sendFileMessage(text);
        return;
      }

      if (!text) return;

      if (state.currentChat.type === 'room') {
        wsSend({
          type: 'room_message',
          roomId: state.currentChat.id,
          content: text,
          messageType: 'text'
        });
      } else if (state.currentChat.type === 'dm') {
        wsSend({
          type: 'private_message',
          recipientId: state.currentChat.id,
          content: text,
          messageType: 'text'
        });
      }

      dom.messageInput.value = '';
      stopTyping();
    });

    // Typing indicator
    let typingTimer = null;
    dom.messageInput.addEventListener('input', () => {
      if (!state.currentChat) return;

      if (!typingTimer) {
        const payload = { type: 'typing', isTyping: true };
        if (state.currentChat.type === 'room') payload.roomId = state.currentChat.id;
        else payload.recipientId = state.currentChat.id;
        wsSend(payload);
      }

      clearTimeout(typingTimer);
      typingTimer = setTimeout(() => {
        stopTyping();
        typingTimer = null;
      }, 2000);
    });

    function stopTyping() {
      if (!state.currentChat) return;
      const payload = { type: 'typing', isTyping: false };
      if (state.currentChat.type === 'room') payload.roomId = state.currentChat.id;
      else payload.recipientId = state.currentChat.id;
      wsSend(payload);
    }
  }

  // ─── File Upload ────────────────────────────────────────────
  function initFileUpload() {
    dom.attachBtn.addEventListener('click', () => dom.fileInput.click());

    dom.fileInput.addEventListener('change', () => {
      const file = dom.fileInput.files[0];
      if (!file) return;

      state.pendingFile = file;

      // Show preview
      let icon = 'description';
      if (file.type.startsWith('image/')) icon = 'image';
      else if (file.type.startsWith('video/')) icon = 'videocam';
      else if (file.type.startsWith('audio/')) icon = 'audiotrack';

      dom.previewIcon.textContent = icon;
      dom.previewFilename.textContent = file.name;
      dom.uploadPreview.classList.remove('hidden');
      dom.messageInput.focus();
    });

    dom.cancelUpload.addEventListener('click', () => {
      state.pendingFile = null;
      dom.fileInput.value = '';
      dom.uploadPreview.classList.add('hidden');
    });
  }

  async function sendFileMessage(text) {
    if (!state.pendingFile) return;

    const formData = new FormData();
    formData.append('file', state.pendingFile);

    try {
      dom.sendBtn.disabled = true;
      const res = await fetch('https://real-time-chart-n689.onrender.com/api/upload', {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${state.token}` },
        body: formData
      });

      if (!res.ok) {
        const err = await res.json();
        throw new Error(err.error || 'Upload failed');
      }

      const data = await res.json();

      const payload = {
        content: text || null,
        messageType: data.message_type,
        fileUrl: data.file_url,
        fileName: data.file_name
      };

      if (state.currentChat.type === 'room') {
        wsSend({ type: 'room_message', roomId: state.currentChat.id, ...payload });
      } else if (state.currentChat.type === 'dm') {
        wsSend({ type: 'private_message', recipientId: state.currentChat.id, ...payload });
      }
    } catch (err) {
      showToast('Upload Error', err.message);
    } finally {
      state.pendingFile = null;
      dom.fileInput.value = '';
      dom.uploadPreview.classList.add('hidden');
      dom.messageInput.value = '';
      dom.sendBtn.disabled = false;
    }
  }

  // ─── Typing Indicator ──────────────────────────────────────
  function handleTypingEvent(msg) {
    if (msg.userId === state.user.id) return;

    const isRelevant =
      (state.currentChat?.type === 'room' && msg.roomId === state.currentChat.id) ||
      (state.currentChat?.type === 'dm' && msg.userId === state.currentChat.id);

    if (!isRelevant) return;

    if (msg.isTyping) {
      dom.typingIndicator.querySelector('span').textContent = `${msg.username} is typing`;
      dom.typingIndicator.classList.remove('hidden');

      // Auto-hide after 3s
      clearTimeout(state.typingTimeouts[msg.userId]);
      state.typingTimeouts[msg.userId] = setTimeout(() => {
        dom.typingIndicator.classList.add('hidden');
      }, 3000);
    } else {
      dom.typingIndicator.classList.add('hidden');
      clearTimeout(state.typingTimeouts[msg.userId]);
    }
  }

  // ─── Notifications & Unread ─────────────────────────────────
  function handleNotification(msg) {
    if (msg.source === 'room') {
      const isViewing = state.currentChat?.type === 'room' && state.currentChat.id === msg.roomId;
      if (!isViewing) {
        showToast(`# ${msg.roomName || 'Room'}`, `${msg.senderName}: ${msg.preview}`);
      }
    } else if (msg.source === 'dm') {
      const isViewing = state.currentChat?.type === 'dm' && state.currentChat.id === msg.senderId;
      if (!isViewing) {
        showToast(`${msg.senderName}`, msg.preview);
      }
    }
  }

  function incrementUnread(key) {
    state.unreadCounts[key] = (state.unreadCounts[key] || 0) + 1;
  }

  function clearUnread(key) {
    delete state.unreadCounts[key];
  }

  // ─── Presence Updates ───────────────────────────────────────
  function updatePresenceUI() {
    // Update DM list online status
    renderDMList();

    // Update member list if viewing a room
    if (state.currentChat?.type === 'room') {
      dom.memberList.querySelectorAll('.nav-item').forEach(item => {
        const userId = parseInt(item.dataset.userId);
        const dot = item.querySelector('.status-dot');
        const meta = item.querySelector('.item-meta');
        if (dot) {
          if (state.onlineUsers.has(userId)) {
            dot.classList.add('online');
            if (meta) meta.textContent = 'Online';
          } else {
            dot.classList.remove('online');
            if (meta) meta.textContent = 'Offline';
          }
        }
      });
    }

    // Update DM header if viewing
    if (state.currentChat?.type === 'dm') {
      const isOnline = state.onlineUsers.has(state.currentChat.id);
      dom.chatSubtitle.textContent = isOnline ? 'Online' : 'Offline';
    }
  }

  // ─── Toasts ─────────────────────────────────────────────────
  function showToast(title, body) {
    const toast = document.createElement('div');
    toast.className = 'toast';
    toast.innerHTML = `
      <span class="material-symbols-rounded toast-icon">notifications</span>
      <div class="toast-content">
        <h4>${escapeHtml(title)}</h4>
        <p>${escapeHtml(body)}</p>
      </div>
    `;
    dom.toastContainer.appendChild(toast);

    setTimeout(() => {
      toast.classList.add('hiding');
      setTimeout(() => toast.remove(), 400);
    }, 4000);
  }

  // ─── Create Room Modal ──────────────────────────────────────
  function initCreateRoom() {
    dom.createRoomBtn.addEventListener('click', () => {
      dom.createRoomModal.classList.remove('hidden');
      dom.createRoomModal.classList.add('active');
      dom.newRoomName.focus();
    });

    const closeModal = () => {
      dom.createRoomModal.classList.add('hidden');
      dom.createRoomModal.classList.remove('active');
      dom.createRoomForm.reset();
    };
    dom.closeModalBtn.addEventListener('click', closeModal);
    dom.cancelRoomBtn.addEventListener('click', closeModal);
    dom.createRoomModal.addEventListener('click', (e) => {
      if (e.target === dom.createRoomModal) closeModal();
    });

    dom.createRoomForm.addEventListener('submit', async (e) => {
      e.preventDefault();
      try {
        const data = await api('POST', '/rooms', {
          name: dom.newRoomName.value.trim(),
          description: dom.newRoomDesc.value.trim()
        });
        closeModal();
        await loadRooms();
        openRoom(data.room.id);
      } catch (err) {
        showToast('Error', err.message);
      }
    });
  }

  // ─── Sidebar Toggles ───────────────────────────────────────
  function initSidebars() {
    dom.toggleRightSidebar.addEventListener('click', () => {
      dom.rightSidebar.classList.toggle('open');
    });
    dom.closeRightSidebar.addEventListener('click', () => {
      dom.rightSidebar.classList.remove('open');
    });
    if (dom.mobileMenuBtn) {
      dom.mobileMenuBtn.addEventListener('click', () => {
        document.querySelector('.chat-view')?.classList.toggle('chat-active');
      });
    }
  }

  // ─── Utilities ──────────────────────────────────────────────
  function escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
  }

  function formatTime(dateStr) {
    if (!dateStr) return '';
    const date = new Date(dateStr);
    const now = new Date();
    const isToday = date.toDateString() === now.toDateString();

    if (isToday) {
      return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    }
    return date.toLocaleDateString([], { month: 'short', day: 'numeric' }) + ' ' +
           date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  }

  // ─── Init ───────────────────────────────────────────────────
  function init() {
    initAuth();
    initMessageForm();
    initFileUpload();
    initCreateRoom();
    initSidebars();

    // Auto-login if token exists
    if (state.token && state.user) {
      enterChat();
    }
  }

  init();
})();
