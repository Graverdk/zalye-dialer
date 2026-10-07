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
