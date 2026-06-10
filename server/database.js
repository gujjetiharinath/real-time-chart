const initSqlJs = require('sql.js');
const fs = require('fs');
const path = require('path');

const DB_PATH = path.join(__dirname, '..', 'chat.db');

let db = null;
let saveTimeout = null;

// ─── Initialization ──────────────────────────────────────────

async function initDatabase() {
  const SQL = await initSqlJs();

  if (fs.existsSync(DB_PATH)) {
    const buffer = fs.readFileSync(DB_PATH);
    db = new SQL.Database(buffer);
  } else {
    db = new SQL.Database();
  }

  db.run('PRAGMA foreign_keys = ON;');
  initTables();
  return db;
}

function getDb() {
  return db;
}

function saveToDisk() {
  if (!db) return;
  clearTimeout(saveTimeout);
  saveTimeout = setTimeout(() => {
    try {
      const data = db.export();
      const buffer = Buffer.from(data);
      fs.writeFileSync(DB_PATH, buffer);
    } catch (err) {
      console.error('DB save error:', err);
    }
  }, 200);
}

// ─── Query Helpers ───────────────────────────────────────────

function queryOne(sql, params = []) {
  const stmt = db.prepare(sql);
  stmt.bind(params);
  let result = null;
  if (stmt.step()) {
    result = stmt.getAsObject();
  }
  stmt.free();
  return result;
}

function queryAll(sql, params = []) {
  const stmt = db.prepare(sql);
  stmt.bind(params);
  const results = [];
  while (stmt.step()) {
    results.push(stmt.getAsObject());
  }
  stmt.free();
  return results;
}

function execute(sql, params = []) {
  db.run(sql, params);
  const row = queryOne('SELECT last_insert_rowid() as id');
  saveToDisk();
  return { lastInsertRowid: row ? row.id : 0 };
}

// ─── Table Setup ─────────────────────────────────────────────

function initTables() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      avatar_color TEXT NOT NULL DEFAULT '#6c5ce7',
      status TEXT NOT NULL DEFAULT 'offline',
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS rooms (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT UNIQUE NOT NULL,
      description TEXT DEFAULT '',
      created_by INTEGER NOT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (created_by) REFERENCES users(id)
    );

    CREATE TABLE IF NOT EXISTS room_members (
      room_id INTEGER NOT NULL,
      user_id INTEGER NOT NULL,
      joined_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (room_id, user_id),
      FOREIGN KEY (room_id) REFERENCES rooms(id) ON DELETE CASCADE,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      sender_id INTEGER NOT NULL,
      room_id INTEGER,
      recipient_id INTEGER,
      content TEXT,
      message_type TEXT NOT NULL DEFAULT 'text',
      file_url TEXT,
      file_name TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (sender_id) REFERENCES users(id),
      FOREIGN KEY (room_id) REFERENCES rooms(id) ON DELETE CASCADE,
      FOREIGN KEY (recipient_id) REFERENCES users(id)
    );
  `);

  // Create indexes if they don't exist (exec separately to avoid errors)
  try { db.exec('CREATE INDEX IF NOT EXISTS idx_messages_room ON messages(room_id, created_at);'); } catch {}
  try { db.exec('CREATE INDEX IF NOT EXISTS idx_messages_dm ON messages(sender_id, recipient_id, created_at);'); } catch {}

  // Seed default rooms if none exist
  const roomCount = queryOne('SELECT COUNT(*) as count FROM rooms');
  if (roomCount && roomCount.count === 0) {
    const bcrypt = require('bcryptjs');
    const hash = bcrypt.hashSync('system-no-login', 10);

    const systemUser = queryOne('SELECT id FROM users WHERE username = ?', ['system']);
    let systemUserId;
    if (!systemUser) {
      const result = execute('INSERT INTO users (username, password_hash, avatar_color) VALUES (?, ?, ?)', ['system', hash, '#636e72']);
      systemUserId = result.lastInsertRowid;
    } else {
      systemUserId = systemUser.id;
    }

    execute('INSERT INTO rooms (name, description, created_by) VALUES (?, ?, ?)', ['General', 'Welcome! This is the general chat room for everyone.', systemUserId]);
    execute('INSERT INTO rooms (name, description, created_by) VALUES (?, ?, ?)', ['Random', 'Off-topic conversations and fun stuff.', systemUserId]);
    execute('INSERT INTO rooms (name, description, created_by) VALUES (?, ?, ?)', ['Tech Talk', 'Discuss technology, programming, and more.', systemUserId]);
  }

  saveToDisk();
}

// ─── User Queries ────────────────────────────────────────────

function createUser(username, passwordHash, avatarColor) {
  return execute('INSERT INTO users (username, password_hash, avatar_color) VALUES (?, ?, ?)', [username, passwordHash, avatarColor]);
}

function getUserByUsername(username) {
  return queryOne('SELECT * FROM users WHERE username = ?', [username]);
}

function getUserById(id) {
  return queryOne('SELECT id, username, avatar_color, status, created_at FROM users WHERE id = ?', [id]);
}

function getAllUsers() {
  return queryAll('SELECT id, username, avatar_color, status, created_at FROM users WHERE username != ?', ['system']);
}

function updateUserStatus(userId, status) {
  db.run('UPDATE users SET status = ? WHERE id = ?', [status, userId]);
  saveToDisk();
}

// ─── Room Queries ────────────────────────────────────────────

function createRoom(name, description, createdBy) {
  return execute('INSERT INTO rooms (name, description, created_by) VALUES (?, ?, ?)', [name, description, createdBy]);
}

function getAllRooms() {
  return queryAll(`
    SELECT r.*, u.username as creator_name,
    (SELECT COUNT(*) FROM room_members rm WHERE rm.room_id = r.id) as member_count
    FROM rooms r
    LEFT JOIN users u ON r.created_by = u.id
    ORDER BY r.created_at ASC
  `);
}

function getRoomById(id) {
  return queryOne('SELECT * FROM rooms WHERE id = ?', [id]);
}

function joinRoom(roomId, userId) {
  const existing = queryOne('SELECT * FROM room_members WHERE room_id = ? AND user_id = ?', [roomId, userId]);
  if (!existing) {
    execute('INSERT INTO room_members (room_id, user_id) VALUES (?, ?)', [roomId, userId]);
  }
}

function leaveRoom(roomId, userId) {
  db.run('DELETE FROM room_members WHERE room_id = ? AND user_id = ?', [roomId, userId]);
  saveToDisk();
}

function getRoomMembers(roomId) {
  return queryAll(`
    SELECT u.id, u.username, u.avatar_color, u.status
    FROM room_members rm
    JOIN users u ON rm.user_id = u.id
    WHERE rm.room_id = ?
    ORDER BY u.username ASC
  `, [roomId]);
}

function isRoomMember(roomId, userId) {
  return !!queryOne('SELECT 1 FROM room_members WHERE room_id = ? AND user_id = ?', [roomId, userId]);
}

// ─── Message Queries ─────────────────────────────────────────

function saveMessage(senderId, roomId, recipientId, content, messageType, fileUrl, fileName) {
  return execute(`
    INSERT INTO messages (sender_id, room_id, recipient_id, content, message_type, file_url, file_name)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `, [senderId, roomId, recipientId, content, messageType, fileUrl, fileName]);
}

function getRoomMessages(roomId, limit = 50, before = null) {
  if (before) {
    return queryAll(`
      SELECT m.*, u.username as sender_name, u.avatar_color as sender_color
      FROM messages m
      JOIN users u ON m.sender_id = u.id
      WHERE m.room_id = ? AND m.id < ?
      ORDER BY m.created_at DESC
      LIMIT ?
    `, [roomId, before, limit]).reverse();
  }
  return queryAll(`
    SELECT m.*, u.username as sender_name, u.avatar_color as sender_color
    FROM messages m
    JOIN users u ON m.sender_id = u.id
    WHERE m.room_id = ?
    ORDER BY m.created_at DESC
    LIMIT ?
  `, [roomId, limit]).reverse();
}

function getPrivateMessages(userId1, userId2, limit = 50, before = null) {
  if (before) {
    return queryAll(`
      SELECT m.*, u.username as sender_name, u.avatar_color as sender_color
      FROM messages m
      JOIN users u ON m.sender_id = u.id
      WHERE m.room_id IS NULL
        AND ((m.sender_id = ? AND m.recipient_id = ?) OR (m.sender_id = ? AND m.recipient_id = ?))
        AND m.id < ?
      ORDER BY m.created_at DESC
      LIMIT ?
    `, [userId1, userId2, userId2, userId1, before, limit]).reverse();
  }
  return queryAll(`
    SELECT m.*, u.username as sender_name, u.avatar_color as sender_color
    FROM messages m
    JOIN users u ON m.sender_id = u.id
    WHERE m.room_id IS NULL
      AND ((m.sender_id = ? AND m.recipient_id = ?) OR (m.sender_id = ? AND m.recipient_id = ?))
    ORDER BY m.created_at DESC
    LIMIT ?
  `, [userId1, userId2, userId2, userId1, limit]).reverse();
}

function getRecentDMContacts(userId) {
  return queryAll(`
    SELECT DISTINCT
      CASE WHEN m.sender_id = ? THEN m.recipient_id ELSE m.sender_id END as contact_id,
      u.username, u.avatar_color, u.status,
      MAX(m.created_at) as last_message_at
    FROM messages m
    JOIN users u ON u.id = CASE WHEN m.sender_id = ? THEN m.recipient_id ELSE m.sender_id END
    WHERE m.room_id IS NULL AND (m.sender_id = ? OR m.recipient_id = ?)
    GROUP BY contact_id
    ORDER BY last_message_at DESC
  `, [userId, userId, userId, userId]);
}

module.exports = {
  initDatabase, getDb,
  createUser, getUserByUsername, getUserById, getAllUsers, updateUserStatus,
  createRoom, getAllRooms, getRoomById, joinRoom, leaveRoom, getRoomMembers, isRoomMember,
  saveMessage, getRoomMessages, getPrivateMessages, getRecentDMContacts
};
