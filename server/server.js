const express = require('express');
const http = require('http');
const path = require('path');
const fs = require('fs');

// Ensure uploads directory exists
const uploadsDir = path.join(__dirname, '..', 'uploads');
if (!fs.existsSync(uploadsDir)) {
  fs.mkdirSync(uploadsDir, { recursive: true });
}

const app = express();
const server = http.createServer(app);

// Middleware
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Serve static files
app.use(express.static(path.join(__dirname, '..')));
app.use('/uploads', express.static(uploadsDir));

// Boot sequence: init DB first (async), then mount routes and start
(async () => {
  // Initialize database (creates tables + seeds data)
  const db = require('./database');
  await db.initDatabase();

  const { router: authRouter } = require('./auth');
  const roomsRouter = require('./rooms');
  const uploadsRouter = require('./uploads');
  const { setupWebSocket } = require('./websocket');

  // API Routes
  app.use('/api/auth', authRouter);
  app.use('/api/rooms', roomsRouter);
  app.use('/api/upload', uploadsRouter);

  // SPA fallback
  app.get('*', (req, res) => {
    res.sendFile(path.join(__dirname, '..', 'index.html'));
  });

  // Setup WebSocket
  setupWebSocket(server);

  // Start server
  const PORT = process.env.PORT || 3000;
  server.listen(PORT, () => {
    console.log(`\n🚀 Chat server running on http://localhost:${PORT}\n`);
  });
})();
