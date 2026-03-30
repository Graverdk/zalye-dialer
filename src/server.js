const express = require('express');
const cors = require('cors');
const path = require('path');
const config = require('./config');

const app = express();

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
// Dialer floating window: GET /dialer
app.use('/dialer', express.static(path.join(__dirname, '../frontend/dialer')));
// Sidebar panel: GET /panel
app.use('/panel', express.static(path.join(__dirname, '../frontend/panel')));

// ============================================================
// API Routes
// ============================================================
app.use('/api/calls', require('./routes/calls'));

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
    appId: process.env.PIPEDRIVE_APP_ID || 'zalye-dialer',
    name: 'Zalye Dialer',
    description: 'Ring direkte fra Pipedrive via Relatel med automatisk transskription',
    version: '1.0.0',
    extensions: [
      {
        // Floating window: åbnes når bruger klikker telefonnummer
        type: 'floating-window',
        identifier: 'dialer',
        src: `${config.appUrl}/dialer`,
        size: { width: 340, height: 440 },
      },
      {
        // Custom sidebar panel på deals og kontakter
        type: 'panel',
        identifier: 'opkald-panel',
        src: `${config.appUrl}/panel`,
        targets: ['deal', 'person'],
        name: 'Opkald',
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
  console.log(`\n🚀 Zalye Dialer kører på port ${config.port}`);
  console.log(`   Dialer:  ${config.appUrl}/dialer`);
  console.log(`   Panel:   ${config.appUrl}/panel`);
  console.log(`   API:     ${config.appUrl}/api/calls\n`);

  // Start polling jobs
  require('./jobs/pollCalls').start();
});

module.exports = app;
