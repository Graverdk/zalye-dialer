// ============================================================
// Vagt foran alle Pipedrive-kald (pipedrive.js og autofill.js).
// Selve logikken ligger nu i src/crm/guard.js (én vagt pr. CRM), så
// Twenty får sin egen pause. Adfærden for Pipedrive er uændret:
// - 401 og 429 giver pause for ALLE Pipedrive-kald: 2, 4, 8 og derefter
//   15 min. Ved 429 respekteres Retry-After.
// - Ved 401 rører resten af kørslen ikke Pipedrive (ingen løkke).
// - Et OK-svar ophæver pausen.
// Loftet deles med lead-hubben og Claudes Pipedrive-forbindelse, så vi
// skal hellere vente for længe end hamre løs.
// ============================================================
const { createGuard } = require('../crm/guard');

module.exports = createGuard({ name: 'pipedrive', label: 'Pipedrive' });
