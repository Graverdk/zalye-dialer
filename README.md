# zalye-dialer
## Twenty bag et feature-flag (11/2026)
`CRM_MODE` styrer hvor opkald, SMS og Relatel-noter skrives hen. Standard er `pipedrive`, så en merge
ændrer intet i drift.

| CRM_MODE | Primær | Skygge | Bemærk |
|---|---|---|---|
| `pipedrive` | Pipedrive | — | Som før. Twenty røres ikke. |
| `dual` | Pipedrive | Twenty | Twenty skrives *efter* Pipedrive og i en fejl-isoleret blok: 4xx/5xx, 429, timeout eller en undtagelse i Twenty blokerer aldrig Pipedrive, holder aldrig opkalds-markøren tilbage og pauser ikke Pipedrive-vagten. GDPR-reglen følger Pipedrive. |
| `twenty` | Twenty | — | Pipedrive røres ikke (`PIPEDRIVE_API_TOKEN` valgfri). GDPR: kun opkald med Twenty-match transskriberes. Navnesynken til Relatel læser fra Twenty-personen. |

- Koden: `src/crm/` — `index.js` (valg af adapter, dual, isolation), `pipedrive.js` (de gamle
  `services/pipedrive.js` + `services/autofill.js` bag grænsefladen, uændret adfærd), `twenty.js` (REST),
  `twentyClient.js` (vagt + timeout), `twentyMeta.js` (tjek mod Twentys metadata), `twentyMapping.js`
  (**alle** Twenty-felt- og option-navne ét sted, verificeret live 9/11 2026), `guard.js` (én rate limit-vagt pr. CRM).
- Hvert opkald, hver SMS og hver Relatel-note bliver en **Samtale** med `eksterntId`
  `relatel-call:<uuid>` / `relatel-sms:<id>` / `relatel-note:<id>` — samme hændelse oprettes aldrig to gange.
  Analysen opdaterer samtalen med udfald, mødetype, temperatur, blokke, resumé, coachVurdering og transskript.
- Telefonopslag: `telefon8` (de sidste 8 cifre), ellers `phones.primaryPhoneNumber` + tjek af
  `additionalPhones` i koden. `telefon8` sættes på personen ved match. Cachen `phone_lookups` er nu nøglet
  på `(crm, sidste8)` med id'er som TEXT (gamle rækker flyttes automatisk som `pipedrive`). "Ingen match"
  gælder 15 min i den første time efter første miss og derefter 24 timer (gælder både Pipedrive og Twenty).
- Autofill udfylder kun tomme felter på virksomhed, person og salgsmulighed; andre værdier bliver forslag.
  Signaler (anledning, smerte, indvending, konkurrent, kundens ord) oprettes i ét batch-kald med
  `status=FORESLAAET`. Ved "booket" flyttes salgsmuligheden til `DEMO_BOOKET` — kun fra NY_LEAD,
  KVALIFICERET eller VENTER_PAA_DEMO_BOOKING — og `booketAf` sættes ud fra `moedebooker.relatelBruger`.
- Ukendt nummer (Twenty svarer "ingen match") på et opkald over `TWENTY_UNKNOWN_NUMBER_MIN_SEC` giver én
  opgave pr. nummer pr. dag til `TWENTY_UNKNOWN_NUMBER_ASSIGNEE_ID` (standard Jeppe). **Under dual:** sæt
  `TWENTY_UNKNOWN_NUMBER_MIN_SEC=-1`, ellers kommer der opgaver på numre, der findes i Pipedrive, men endnu
  ikke i Twenty. Slå dem til igen (fjern variablen) ved skiftet til `twenty`.
- GDPR: kl. 03:50 tømmes `transskript` på samtaler med `kilde=DIALER` ældre end 12 mdr.
- Rate limit: Twenty har sin egen vagt (pause ved 401/429) og et loft på `TWENTY_MAX_CALLS_PER_RUN` kald pr.
  kørsel. Loglinjen viser `Twenty-kald: n · Twenty udskudt: n …`, når kørslen rørte Twenty. 401 fra Twenty
  i to kørsler i træk giver alarm som for Pipedrive.
- Backfill: `node scripts/backfill-twenty.js --dry-run` (tæller), derefter uden `--dry-run`. Kan genoptages.
- Fjernet: de døde admin-ruter `/api/calls/unpin-notes` og `/api/calls/debug/pipedrive-note/:id`.
- Tests: `npm test`. Twenty er mocket (`test/mockTwenty.js`), og netværket er slået fra i tests.

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

## Pipedrive-appen er fjernet (23/10/2026)
- Jeppe har slettet dialer-appen i Pipedrive Developer Hub. `PIPEDRIVE_CLIENT_ID` og `PIPEDRIVE_CLIENT_SECRET`
  er derfor valgfrie og kan slettes i Railway. Dataflowet (Relatel → Pipedrive) bruger kun `PIPEDRIVE_API_TOKEN`.
- Uden dem er panel-adgangen (`/api/calls`, `/api/messages`, `/auth/session`) kun åben med `ADMIN_SECRET`,
  og `/auth/callback` svarer 410.
