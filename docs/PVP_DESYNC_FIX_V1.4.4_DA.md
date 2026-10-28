# v1.4.4 — Falske desync-stop i Player vs Friend (audit)

Alle tre fejl i produktion ("Online match desynchronized and was stopped") er
fundet i server-loggene og reproducéret logisk:

1. `Timed out waiting for popup choice (2:51:host:turn:popup:0)`
2. `Timed out waiting for continuation destination (1:10:guest:faction:wild_hunt:turnEnd:destination:0)`
3. `Timed out waiting for carousel choice (2:13:guest:card:mo_gaunter_odimm_darkness:placed:carousel:0)`

## Rodårsager og rettelser

### 1. Popup-svar blev aldrig sendt ved rundens afslutning (EHNZF)

**Symptom:** Gæsten åbnede fire popup-waitere (`turn:popup:0..3`), værten
besvarede kun `popup:2`, hvorefter popup 0 fik timeout og matchet blev stoppet.

**Årsag:** v5's `endRound()` rydder brættet via
`Promise.all(board.row.map(...))`. Hver række ryddes parallelt, og hver
`board.toGrave()` kan åbne en Comrade "Save it?"-popup. `Popup`-klassen har
kun én samtidig slot (`Popup.curr`), så kun den sidst oprettede popup kunne
besvares; de øvrige hang og ventede for evigt på en `popup-choice`, der
aldri kom. Beslutnings-id'et forsvandt derved, og den ventende peer fik
timeout.

**Rettelse:** `gwent.js` — rundens oprydning er nu serialiseret
(`for (const row of board.row)`), så destruction/popups afvikles én ad
gangen og hvert svar kan sendes og matches mod det korrekte decision-id.

**Ekstra rettelse:** `online.js` — remote popup-replay returnerede altid
`fake.choice` (null). V5-popupcallbacks som Comrade's "Save it" returnerer
deres resultat som returværdi i stedet for at sætte `popup.choice`, så et
fjern "yes" blev eksekveret korrekt men evaluéret som "no" hos replay-peeren.
Replay returnerer nu callback-værdien (`fake.choice ?? returned`).

### 2. Wild Hunt Dimensional Door destination timeout (CPKJ8)

**Symptom:** Zirael (wh_cirilla) blev spillet og valgte 2 kort; umiddelbart
efter åbnede værten en `faction:wild_hunt:turnEnd:destination` decision, som
gæsten aldrig åbnede, og værten fik timeout.

**Årsag:** Zirael shuffler de ikke-valgte kort tilbage i dækket via
`Deck.addCard → addCardRandom → randomInt()`. Opening-mulliganen kørte
`withDeckRng(role, ...)`, der forbruger den seededede `deckRng`-strøm — men
mulliganen kører kun lokalt (resultatet synkroniseres via snapshot). De to
peers' `deckRng`-tilstande divergerede derfor fra start, så den seedede
shuffle gav forskellig dækorden på de to browsere. Wild Hunt's
turnEnd-dør-effekt læser `player.deck.cards[0]` og forgrener sig efter
korttypen: på den ene browser var der en unit, der skulle placeres
(destination), på den anden et specialkort (popup) — protokollerne
uulgik, og matchet stoppede.

**Rettelse:** `online.js` — mulligan-shuffles bruger nu
`withLocalShuffleRng()`, der slet ikke rører de seedede strømme
(`gameRng`/`deckRng`). Dækorden efter mulligan er i forvejen autoritativt
udvekslet via `mulligan-state`-snapshottet, så alle senere seedede shuffles
(fx Zirael) er deterministisk ens på begge peers.

### 3. Gaunter O'Dimm Darkness carousel timeout (XR37G)

**Symptom:** Gæsten fik en carousel med 20 kort (Goetia: vælg 1 at trække),
værten ventede 30 sekunder og erklærede desync, mens gæsten stadig bladrede.

**Årsag:** 30 sekunder er designet til AI-relaterede fail-fast-scenarier,
ikke til et menneske, der skal bladre 20 kort. Andre menneskelige
beslutninger (number, deck-sort, ability-target) bruger allerede 120 sekunder.

**Rettelse:** `online.js` — popup/carousel/destination decision-timeouts er
hævet fra 30s til 120s, konsistent med de øvrige human-beslutningstyper.
Timeouts forbliver, så en reelt død peer stadig stopper matchet.

## Øvrige

- `tests/static-audit.js`: seks nye regressionstchecks for rettelserne.
- Pre-existing static-audit fejl rettet: `previewOnlyLeader`-checken
  matchede aldrig (`localPreview` er det rigtige symbol), og tre audit-dok-
  referencer manglede i repoet (`docs/FULL_MULTIPLAYER_AUDIT_V1.3.0.md`,
  `docs/PASSED_STATE_AUDIT_V1.3.1.md`, `docs/CONTINUATION_AUDIT_V1.3.9.md`).
- `package.json`/`online.js` banner: v1.4.4.

## Verifikation

- `node tests/static-audit.js` — ALLE statiske kontroller består.
- `node tests/e2e-online.js` — fuldt online multiplayer-forløb (lobby,
  mulligan, spil kort, turn-overførsel, give up, rematch) består i to
  Chromium-kontekster.
- Genindlæs siden hos begge spillere efter opdateringen; begge peers skal
  køre v1.4.4, ellers vil nye 120s-timeouts slå igennem ved blandet version.
