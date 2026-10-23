# zalye-dialer
## Salgscoaching efter hvert kald (7/10/2026)
- Efter analysen coacher `services/coaching.js` kaldet ud fra det fulde transskript (som bliver her,
  GDPR-beslutning 24/9). Grundlaget er `src/coaching/playbook.md` + de seneste 10 coachede kald.
- Talefordelingen beregnes af koden ud fra Sælger/Kunde-linjerne, ikke af Claude.
- Resultatet gemmes i `calls.coaching_json` og skrives som blokken "Coaching (skema v1)" i
  Pipedrive-aktiviteten. Salgscoach-appen læser blokken — labels skal matche dens `insights.js`.
- Coachingen er best effort: fejler den, lander analysen i Pipedrive alligevel.
- Playbooken opdateres om fredagen ud fra ugens kald (det, der virkede).
- Analyse-skema v2: Kontaktens rolle, Anledning, Primær smerte, Konsekvens, Beslutning, Kundens ord.
- Deal-kobling: åben deal først, ellers nyeste vundne deal (Onboarding). Findes dealen først efter kaldet, flyttes aktiviteten derhen.
- Tomme felter udfyldes automatisk (`services/autofill.js`): antal ansatte, fag, drifts-/regnskabs-/lønprogram,
  rolle, anledning og indvending. Eksisterende værdier overskrives aldrig. Hvad der blev gjort, står i blokken
  "Pipedrive (skema v1)" på aktiviteten. Næste aktivitet og trinskift kræver Jeppes ja (Salgscoach-appen).

## Færre Pipedrive-kald og fejlalarm (23/10/2026)
- Alle Pipedrive-kald går gennem `services/pipedriveGuard.js`. 401 og 429 giver pause for alle kald
  (2, 4, 8 og derefter 15 min, Retry-After respekteres), og efter en 401 rører resten af kørslen ikke Pipedrive.
- Telefonopslag caches i SQLite (`phone_lookups`, `services/phoneLookupCache.js`). "Ingen match" gælder i
  24 timer, et match i 10 min. 401/429 og andre fejl caches aldrig. Højst 25 opslag pr. kørsel.
- Opkald, der ikke kunne kobles, fordi Pipedrive holdt pause, holder `last_call_check` tilbage, så de hentes
  igen næste gang. Relatel hentes med op til 200 opkald pr. kørsel.
- Én logline pr. kørsel: `[Kørsel AI] Pipedrive-kald: 3 · Cache: ingen match: 2 · udskudt: 0 · …` (ingen nøgler).
- 401 fra Pipedrive eller Relatel i to kørsler i træk giver én alarm pr. time til `ALERT_WEBHOOK_URL`
  (`services/alerts.js`). Uden URL står alarmen kun i loggen som `[Alarm] …`.
- Tests: `npm test` (node:test). Dækker TTL, at 401/429 ikke caches, genstart, loftet, alarmen og markøren.
