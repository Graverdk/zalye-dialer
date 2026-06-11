// ============================================================
// Adgangskontrol
//
// To niveauer:
// 1) requirePanelAuth — panel-/data-endpoints. Kræver et gyldigt JWT:
//    enten Pipedrives panel-token (?token=... på iframe-URL'en, signeret
//    med app'ens JWT secret / client secret) eller et session-token vi
//    selv har udstedt via POST /auth/session.
// 2) requireAdmin — debug-/vedligeholdelses-endpoints. Kræver ADMIN_SECRET.
//    Er ADMIN_SECRET ikke sat, er disse endpoints helt deaktiverede.
// ============================================================

const jwt = require('jsonwebtoken');
const config = require('../config');

const JWT_SECRET = config.security.panelJwtSecret || config.pipedrive.clientSecret;
const SESSION_TTL_HOURS = 12;

function extractToken(req) {
  const header = req.headers.authorization || '';
  if (header.startsWith('Bearer ')) return header.slice(7);
  if (req.query && req.query.token) return String(req.query.token);
  return null;
}

function isAdminRequest(req) {
  const secret = config.security.adminSecret;
  if (!secret) return false;
  return req.headers['x-admin-secret'] === secret
    || (req.query && req.query.admin_secret === secret);
}

function verifyToken(token) {
  return jwt.verify(token, JWT_SECRET, { algorithms: ['HS256'] });
}

function signSessionToken() {
  return jwt.sign({ scope: 'panel' }, JWT_SECRET, { expiresIn: SESSION_TTL_HOURS + 'h' });
}

function requirePanelAuth(req, res, next) {
  // Admin-nøglen giver også adgang (praktisk til curl/test)
  if (isAdminRequest(req)) return next();

  const token = extractToken(req);
  if (!token) {
    return res.status(401).json({ error: 'Manglende adgangstoken — åbn panelet via Pipedrive' });
  }
  try {
    req.auth = verifyToken(token);
    return next();
  } catch (e) {
    return res.status(401).json({ error: 'Ugyldigt eller udløbet adgangstoken' });
  }
}

function requireAdmin(req, res, next) {
  if (!config.security.adminSecret) {
    return res.status(503).json({ error: 'ADMIN_SECRET er ikke konfigureret — endpoint deaktiveret' });
  }
  if (!isAdminRequest(req)) {
    return res.status(401).json({ error: 'Ugyldig admin-nøgle' });
  }
  return next();
}

module.exports = { requirePanelAuth, requireAdmin, verifyToken, signSessionToken, SESSION_TTL_HOURS };
