const express = require('express');
const db = require('./database');
const { authenticateToken } = require('./auth');

const router = express.Router();

// Get all rooms
router.get('/', authenticateToken, (req, res) => {
  try {
    const rooms = db.getAllRooms();
    // Add membership info for current user
    const roomsWithMembership = rooms.map(room => ({
      ...room,
      is_member: db.isRoomMember(room.id, req.user.id)
    }));
    res.json({ rooms: roomsWithMembership });
  } catch (err) {
    console.error('Get rooms error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// Create a room
router.post('/', authenticateToken, (req, res) => {
  try {
    const { name, description } = req.body;

    if (!name || name.trim().length === 0) {
      return res.status(400).json({ error: 'Room name is required' });
    }

    if (name.length > 30) {
      return res.status(400).json({ error: 'Room name must be 30 characters or less' });
    }

    const existing = db.getAllRooms().find(r => r.name.toLowerCase() === name.trim().toLowerCase());
    if (existing) {
      return res.status(409).json({ error: 'A room with that name already exists' });
    }

    const result = db.createRoom(name.trim(), description || '', req.user.id);
    const roomId = result.lastInsertRowid;

    // Auto-join the creator
    db.joinRoom(roomId, req.user.id);

    const room = db.getRoomById(roomId);
    res.status(201).json({ room: { ...room, is_member: true, member_count: 1 } });
  } catch (err) {
    console.error('Create room error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// Join a room
router.post('/:id/join', authenticateToken, (req, res) => {
  try {
    const roomId = parseInt(req.params.id);
    const room = db.getRoomById(roomId);
    if (!room) {
      return res.status(404).json({ error: 'Room not found' });
    }
    db.joinRoom(roomId, req.user.id);
    res.json({ message: 'Joined room successfully' });
  } catch (err) {
    console.error('Join room error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// Leave a room
router.post('/:id/leave', authenticateToken, (req, res) => {
  try {
    const roomId = parseInt(req.params.id);
    db.leaveRoom(roomId, req.user.id);
    res.json({ message: 'Left room successfully' });
  } catch (err) {
    console.error('Leave room error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// Get room messages (with pagination)
router.get('/:id/messages', authenticateToken, (req, res) => {
  try {
    const roomId = parseInt(req.params.id);
    const limit = Math.min(parseInt(req.query.limit) || 50, 100);
    const before = req.query.before ? parseInt(req.query.before) : null;

    const messages = db.getRoomMessages(roomId, limit, before);
    res.json({ messages });
  } catch (err) {
    console.error('Get messages error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// Get room members
router.get('/:id/members', authenticateToken, (req, res) => {
  try {
    const roomId = parseInt(req.params.id);
    const members = db.getRoomMembers(roomId);
    res.json({ members });
  } catch (err) {
    console.error('Get members error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// Get all users (for DM)
router.get('/users', authenticateToken, (req, res) => {
  try {
    const users = db.getAllUsers().filter(u => u.id !== req.user.id);
    res.json({ users });
  } catch (err) {
    console.error('Get users error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// Get private messages
router.get('/dm/:userId/messages', authenticateToken, (req, res) => {
  try {
    const otherUserId = parseInt(req.params.userId);
    const limit = Math.min(parseInt(req.query.limit) || 50, 100);
    const before = req.query.before ? parseInt(req.query.before) : null;

    const messages = db.getPrivateMessages(req.user.id, otherUserId, limit, before);
    res.json({ messages });
  } catch (err) {
    console.error('Get DM error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// Get recent DM contacts
router.get('/dm/contacts', authenticateToken, (req, res) => {
  try {
    const contacts = db.getRecentDMContacts(req.user.id);
    res.json({ contacts });
  } catch (err) {
    console.error('Get contacts error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

module.exports = router;
