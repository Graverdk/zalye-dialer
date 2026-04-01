const express = require('express');
const cors = require('cors');
const path = require('path');
const config = require('./config');

const app = express();

// Request logging
app.use((req, res, next) => {
  console.log(`[HTTP] ${req.method} ${req.url} from ${req.headers.referer || "direct"}`);
  next();
});

// ============================================================
// Middleware
// ============================================================
app.use(cors({
  // Tillad Pipedrive at loade vores iframe
  origin: ['https://*.pipedrive.com', 'http://localhost:*'],
  credentials: true,
}));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// ============================================================
// Statiske frontend-filer
// ============================================================
// Sidebar panel: GET /panel
app.use('/panel', express.static(path.join(__dirname, '../frontend/panel')));

// ============================================================
// Auth Routes (Pipedrive OAuth)
// ============================================================
app.use('/auth', require('./routes/auth'));

// ============================================================
// API Routes
// ============================================================
app.use('/api/calls', require('./routes/calls'));
app.use('/api/messages', require('./routes/messages'));

// ============================================================
// Health check
// ============================================================
app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    version: '1.0.0',
    timestamp: new Date().toISOString(),
  });
});

// ============================================================
// Pipedrive App Manifest
// Pipedrive henter dette for at konfigurere appen
// ============================================================
app.get('/manifest.json', (req, res) => {
  res.json({
    appId: process.env.PIPEDRIVE_APP_ID || 'zalye-connect',
    name: 'Zalye Connect',
    description: 'Synkroniser opkald, SMS og noter fra Relatel til Pipedrive',
    version: '2.0.0',
    extensions: [
      {
        // Sidebar panel paa deals og kontakter
        type: 'panel',
        identifier: 'kommunikation-panel',
        src: `${config.appUrl}/panel`,
        targets: ['deal', 'person'],
        name: 'Kommunikation',
      },
    ],
  });
});

// ============================================================
// Error handler
// ============================================================
app.use((err, req, res, _next) => {
  console.error('Uhandteret fejl:', err);
  res.status(500).json({ error: 'Intern serverfejl', message: err.message });
});

// ============================================================
// Start server
// ============================================================
app.listen(config.port, () => {
  console.log(`\n Zalye Connect koerer paa port ${config.port}`);
  console.log(`  Panel:    ${config.appUrl}/panel`);
  console.log(`  Auth:     ${config.appUrl}/auth/callback`);
  console.log(`  API:      ${config.appUrl}/api/calls`);
  console.log(`  Messages: ${config.appUrl}/api/messages\n`);

  // Start polling jobs
  require('./jobs/pollCalls').start();
});

module.exports = app;
