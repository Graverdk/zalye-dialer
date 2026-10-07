const fs = require('fs');
const path = require('path');
const Anthropic = require('@anthropic-ai/sdk');
const config = require('../config');

const anthropic = new Anthropic({ apiKey: config.anthropic.apiKey });

// ============================================================
// Salgscoaching efter hvert kald.
// Kører i dialeren, fordi det fulde transskript kun må ligge her
// (GDPR-beslutning 11/6 + 24/9 2026). Til Pipedrive sendes kun
// coaching-blokken med FASTE labels, så Salgscoach-appen og agenterne
// kan tælle mønstre på tværs af kald. Ændres labels/skema: hæv
// COACHING_SCHEMA_VERSION og ret parseren i zalye-salgscoach (insights.js).
// ============================================================
const COACHING_SCHEMA_VERSION = 1;

const PLAYBOOK_PATH = path.join(__dirname, '..', 'coaching', 'playbook.md');
function loadPlaybook() {
  try { return fs.readFileSync(PLAYBOOK_PATH, 'utf8'); } catch { return ''; }
}

const BLOKKE = ['anledning', 'situation', 'smerte', 'konsekvens', 'beslutning', 'naeste_skridt'];
const BLOK_LABEL = {
  anledning: 'Anledning', situation: 'Situation', smerte: 'Smerte',
  konsekvens: 'Konsekvens', beslutning: 'Beslutning', naeste_skridt: 'Næste skridt',
};
const BLOK_STATUS = ['dækket', 'delvist', 'mangler', 'ikke relevant'];
const VOSS = ['spejling', 'labeling', 'kalibreret spørgsmål', 'nej-spørgsmål', 'anklage-audit', 'opsummering', 'taktisk pause'];

// ------------------------------------------------------------
// Talefordeling — beregnes af koden ud fra det diariserede transskript
// ("Sælger: …" / "Kunde: …"-linjer), så tallet er objektivt.
// ------------------------------------------------------------
function talkStats(diarized) {
  if (!diarized) return null;
  let seller = 0, customer = 0, sellerQuestions = 0, longestSellerTurn = 0;
  for (const line of String(diarized).split('\n')) {
    const m = line.match(/^(Sælger|Kunde):\s*(.*)$/);
    if (!m) continue;
    const words = m[2].replace(/\([^)]*\)/g, ' ').split(/\s+/).filter(Boolean).length;
    if (m[1] === 'Sælger') {
      seller += words;
      sellerQuestions += (m[2].match(/\?/g) || []).length;
      if (words > longestSellerTurn) longestSellerTurn = words;
    } else {
      customer += words;
    }
  }
  const total = seller + customer;
  if (total < 20) return null;
  return {
    saelgerPct: Math.round((seller / total) * 100),
    kundePct: Math.round((customer / total) * 100),
    saelgerSpoergsmaal: sellerQuestions,
    laengsteSaelgerReplikOrd: longestSellerTurn,
  };
}

const strList = (description, maxItems) => ({ type: 'array', items: { type: 'string' }, description, ...(maxItems ? { maxItems } : {}) });

const COACHING_TOOL = {
  name: 'registrer_coaching',
  description: 'Registrér coachingen af sælgeren efter kaldet. Konkret, ærlig og med citater fra transskriptet.',
  input_schema: {
    type: 'object',
    properties: {
      moedetype: {
        type: 'string',
        enum: ['Første kald', 'Genopkald', 'Demo', 'Opfølgning', 'Opstart', 'Support', 'Partner', 'Omstilling'],
        description: '"Omstilling" når Jeppe ikke fik fat i beslutningstageren (fx en kollega tog telefonen).',
      },
      formaal: { type: 'string', description: 'Det rigtige formål og exit-kriterie for netop dette kald ifølge playbooken, i én sætning.' },
      exit_naaet: { type: 'string', enum: ['ja', 'delvist', 'nej'] },
      exit_begrundelse: { type: 'string', description: 'Kort: hvorfor exit blev nået eller ikke.' },
      udfald: { type: 'string', enum: ['booket', 'tabt med årsag', 'parkeret med dato', 'uafklaret', 'ingen kontakt'] },
      blokke: {
        type: 'object',
        description: 'De 6 blokke. "ikke relevant" kun når kaldets formål gør blokken irrelevant (fx omstilling).',
        properties: Object.fromEntries(BLOKKE.map((b) => [b, { type: 'string', enum: BLOK_STATUS }])),
        required: BLOKKE,
      },
      voss_brugt: { type: 'array', items: { type: 'string', enum: VOSS }, description: 'Teknikker Jeppe faktisk brugte. Tom liste hvis ingen.' },
      styrker: strList('1-3 ting der virkede, hver med et kort ordret citat fra Jeppe.', 3),
      mere_vaegt_paa: {
        type: 'array',
        maxItems: 3,
        description: 'De 1-3 vigtigste ting at lægge mere vægt på. Vigtigste først.',
        items: {
          type: 'object',
          properties: {
            hvad: { type: 'string', description: 'Hvad han skal gøre mere/anderledes. Kort.' },
            hvorfor: { type: 'string', description: 'Hvorfor det betyder noget for netop denne målgruppe/kunde. Én sætning.' },
            sig_fx: { type: 'string', description: 'En konkret replik han kan bruge næste gang, på naturligt dansk håndværker-sprog.' },
          },
          required: ['hvad', 'hvorfor', 'sig_fx'],
        },
      },
      vendepunkt: {
        type: ['string', 'null'],
        description: 'Det ene øjeblik hvor kaldet kunne være gået længere: kort citat af hvad der blev sagt + hvad han kunne have sagt i stedet. null hvis intet.',
      },
      bedste_replik: { type: ['string', 'null'], description: 'Jeppes bedste replik ordret, hvis en er værd at gemme i playbooken. Ellers null.' },
      oevelse: { type: 'string', description: 'ÉN konkret ting at øve i næste kald. Kort og målbar.' },
      moenster: { type: ['string', 'null'], description: 'Hvis historikken viser at det samme hul går igen, sig det direkte med antal. Ellers null.' },
      karakter: { type: 'integer', minimum: 1, maximum: 10, description: 'Samlet karakter for kaldet ift. dets formål.' },
    },
    required: ['moedetype', 'formaal', 'exit_naaet', 'exit_begrundelse', 'udfald', 'blokke', 'voss_brugt', 'styrker',
      'mere_vaegt_paa', 'vendepunkt', 'bedste_replik', 'oevelse', 'moenster', 'karakter'],
  },
};

// Kort sammendrag af de seneste coachede kald, så coachen følger udviklingen
function summarizeHistory(rows) {
  const items = (rows || []).map((r) => {
    try { return { at: r.started_at, c: JSON.parse(r.coaching_json) }; } catch { return null; }
  }).filter((x) => x && x.c && x.c.moedetype !== 'Omstilling');
  if (!items.length) return 'Ingen tidligere coachede kald endnu.';
  const n = items.length;
  const lines = [`De seneste ${n} coachede kald (nyeste først):`];
  for (const b of BLOKKE) {
    const covered = items.filter((i) => i.c.blokke && i.c.blokke[b] === 'dækket').length;
    lines.push(`- ${BLOK_LABEL[b]} dækket: ${covered} af ${n}`);
  }
  lines.push(`- Exit nået: ${items.filter((i) => i.c.exit_naaet === 'ja').length} af ${n}`);
  const talk = items.map((i) => i.c.tale && i.c.tale.saelgerPct).filter((x) => Number.isFinite(x));
  if (talk.length) lines.push(`- Jeppes taleandel i snit: ${Math.round(talk.reduce((a, b) => a + b, 0) / talk.length)} %`);
  lines.push('- Seneste øvelser: ' + items.slice(0, 5).map((i) => `"${i.c.oevelse}"`).join(' · '));
  return lines.join('\n');
}

async function coachCall({ transcription, direction = 'outgoing', durationSec, analysis, history }) {
  const talk = talkStats(transcription);
  const playbook = loadPlaybook();
  const dirText = direction === 'outgoing' ? 'udgående' : 'indgående';

  const prompt = `Du er Danmarks bedste B2B-telefonsælger og salgscoach. Du har selv solgt til danske håndværksmestre og ejendomsservice-virksomheder i årevis, og du coacher Jeppe fra Zalye efter hvert kald.

Din coaching er ærlig, konkret og kort. Du roser kun det, der faktisk virkede, og du siger direkte, hvad der kostede kaldet noget. Alt skal kunne bruges i næste kald: brug citater fra transskriptet og giv replikker på naturligt dansk, som en håndværker ville sige dem. Ingen floskler, ingen engelske salgsord.

Mål kaldet på: playbookens regler, de 6 blokke og exit-kriteriet for netop denne type kald, Voss-teknikkerne og målgruppens måde at købe på. Vurdér kaldet ud fra dets formål: et genopkald til en vundet kunde skal give en opstartsdato, ikke en ny behovsafdækning; et kald hvor en kollega tog telefonen ("Omstilling") vurderes kun på at komme igennem til beslutningstageren.

Registrér med værktøjet registrer_coaching. Regler:
- Kun det der står i transskriptet. Diariseringen (Sælger/Kunde) kan være upræcis — tag højde for det.
- "mere_vaegt_paa": de 1-3 ting der ville have flyttet kaldet mest. Vigtigste først.
- "moenster": brug historikken. Går det samme hul igen, så sig det med antal.
- Skriv på korrekt dansk med æ, ø, å. Tal til Jeppe i du-form.

PLAYBOOK:
${playbook}

KALDET: ${dirText}, varighed ${durationSec || '?'} sek.
${talk ? `Talefordeling (beregnet): Jeppe ${talk.saelgerPct} %, kunden ${talk.kundePct} %. Jeppe stillede ${talk.saelgerSpoergsmaal} spørgsmål. Længste replik fra Jeppe: ${talk.laengsteSaelgerReplikOrd} ord.` : 'Talefordeling: kunne ikke beregnes.'}
${analysis ? `Analytikerens resumé: ${analysis.summary || ''}\nAnalytikerens udfald: ${analysis.callOutcome || '?'} · næste skridt: ${(analysis.nextSteps || []).join('; ') || 'ingen'}` : ''}

HISTORIK:
${summarizeHistory(history)}

TRANSSKRIPTION:
${transcription}`;

  const message = await anthropic.messages.create({
    model: config.anthropic.model,
    max_tokens: 3000,
    tools: [COACHING_TOOL],
    tool_choice: { type: 'tool', name: COACHING_TOOL.name },
    messages: [{ role: 'user', content: prompt }],
  });
  const toolUse = message.content.find((b) => b.type === 'tool_use' && b.name === COACHING_TOOL.name);
  if (!toolUse) throw new Error('Claude returnerede ingen coaching (stop_reason: ' + message.stop_reason + ')');
  return { schemaVersion: COACHING_SCHEMA_VERSION, ...toolUse.input, tale: talk };
}

// ------------------------------------------------------------
// Coaching-blokken i Pipedrive-aktiviteten. FASTE labels og rækkefølge —
// Salgscoach-appen parser dem (insights.js: parseCoachingBlock).
// ------------------------------------------------------------
function buildCoachingBlock(c) {
  if (!c) return '';
  const clean = (s) => String(s || '').replace(/\s*[;\n]+\s*/g, ', ').trim();
  const none = 'ingen';
  const blokke = BLOKKE.map((b) => `${BLOK_LABEL[b]} ${(c.blokke && c.blokke[b]) || 'mangler'}`).join('; ');
  const vægt = (c.mere_vaegt_paa || []).map((m) => `${clean(m.hvad)} — ${clean(m.hvorfor)} Sig fx: "${clean(m.sig_fx).replace(/^"|"$/g, '')}"`);
  const lines = [
    `Mødetype: ${clean(c.moedetype)}  ·  Udfald: ${clean(c.udfald)}  ·  Exit nået: ${clean(c.exit_naaet)}  ·  Karakter: ${c.karakter || '?'}/10`,
    `Formål: ${clean(c.formaal)}`,
    `Exit: ${clean(c.exit_begrundelse)}`,
    `Blokke: ${blokke}`,
    c.tale ? `Tale: Jeppe ${c.tale.saelgerPct} %  ·  Kunde ${c.tale.kundePct} %  ·  Spørgsmål ${c.tale.saelgerSpoergsmaal}` : 'Tale: ukendt',
    `Voss brugt: ${(c.voss_brugt || []).length ? c.voss_brugt.join('; ') : none}`,
    `Styrker: ${(c.styrker || []).length ? c.styrker.map(clean).join('; ') : none}`,
    `Mere vægt på: ${vægt.length ? vægt.join('; ') : none}`,
    `Vendepunkt: ${c.vendepunkt ? clean(c.vendepunkt) : none}`,
    `Øvelse: ${clean(c.oevelse)}`,
    `Mønster: ${c.moenster ? clean(c.moenster) : none}`,
    `Bedste replik: ${c.bedste_replik ? clean(c.bedste_replik) : none}`,
  ];
  return `### Coaching (skema v${c.schemaVersion || COACHING_SCHEMA_VERSION})\n${lines.map((l) => `- ${l}`).join('\n')}\n\n`;
}

module.exports = { coachCall, buildCoachingBlock, talkStats, summarizeHistory, COACHING_SCHEMA_VERSION };
