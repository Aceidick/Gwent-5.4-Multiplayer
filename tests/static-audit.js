"use strict";
const fs = require("fs");
const path = require("path");
const cp = require("child_process");
const root = path.resolve(__dirname, "..");
let failed = false;
function ok(cond, msg) { console.log(`${cond ? "PASS" : "FAIL"} ${msg}`); if (!cond) failed = true; }

// Syntax-check every browser/server JS file (sim.js included for regression safety).
for (const name of fs.readdirSync(root).filter(x => x.endsWith('.js')).concat(['server/server.js'])) {
  const f = path.join(root, name);
  const r = cp.spawnSync(process.execPath, ['--check', f], {encoding:'utf8'});
  ok(r.status === 0, `syntax ${name}`);
}

const online = fs.readFileSync(path.join(root, 'online.js'), 'utf8');
const gwent = fs.readFileSync(path.join(root, 'gwent.js'), 'utf8');
const abilities = fs.readFileSync(path.join(root, 'abilities.js'), 'utf8');
const factions = fs.readFileSync(path.join(root, 'factions.js'), 'utf8');
const server = fs.readFileSync(path.join(root, 'server', 'server.js'), 'utf8');

const requiredHooks = [
  'mulligan-state', 'reconcilePrivateZones', 'oldInitPlayers', 'turn-state',
  'containerCardRef', 'popup-choice', 'number-choice', 'deck-sort',
  'destination', 'rearrange-card', 'rearrange-row', 'power-card',
  'ControllerRemoteV5', 'HandRemoteV5'
];
for (const h of requiredHooks) ok(online.includes(h), `online primitive ${h}`);

// All gameplay Math.random calls outside simulation/server must be routed through online RNG.
for (const [name, text] of [['gwent.js',gwent],['abilities.js',abilities],['factions.js',factions]]) {
  const lines = text.split(/\r?\n/);
  lines.forEach((line,i) => {
    if (line.includes('Math.random') && !line.includes('GwentOnline')) {
      const prev = lines[Math.max(0,i-1)] || '';
      const routedFallback = name === 'gwent.js' && line.includes('return Math.floor(Math.random() * n)') && prev.includes('GwentOnline.randomInt');
      if (!routedFallback) ok(false, `${name}:${i+1} raw Math.random in gameplay`);
    }
  });
}

// Ensure the online PvP semantics and input isolation are present.
ok(online.includes("Game.prototype.isPvP"), 'online treated as PvP for game logic');
ok(online.includes("oldEnablePlayer"), 'online input gating overrides hotseat behavior');
ok(online.includes("stopImmediatePropagation"), 'lobby keyboard isolated from game shortcuts');
ok(online.includes('syncState()'), 'blocking checksum uses canonical gameplay state');
ok(online.includes('non-blocking full-state audit difference'), 'full audit mismatch is diagnostic only');
ok(online.includes('firstStateDifference'), 'desync reports first differing state path');

// End-screen Customize must undo online match mode and restore the deck builder.
ok(online.includes('oldReturnToCustomization'), 'online Customize transition is patched');
ok(online.includes("self.active = false"), 'Customize deactivates online match runtime');
ok(online.includes("deckCustomization.style.display = ''"), 'Customize clears persistent inline deck-builder hiding');
ok(online.includes('deckCustomization.classList.add("hide")'), 'online match start uses native hide class');
ok(online.includes("lobby-customizing"), 'Customize state is announced to peer');


// A fresh/replayed online match must not retain the Player object chosen in the prior match.
ok(gwent.includes('this.firstPlayer = null;'), 'Game.reset clears stale firstPlayer');
ok(online.includes('game.reset();'), 'online startMatch resets firstPlayer through full Game.reset');
ok(online.includes('oldRestartGame'), 'online Replay overrides local-only restart');
ok(online.includes('Starting rematch'), 'online Replay exposes synchronized rematch state');

// Give up must be a match-level network event, not v5's local-only reset path.
ok(online.includes('match-forfeit'), 'online Give up has a network protocol event');
ok(online.includes('handleRemoteForfeit'), 'remote forfeit is handled immediately');
ok(online.includes('finishForfeit'), 'both peers share one forfeit finalizer');
ok(online.includes('stopImmediatePropagation'), 'online Give up intercepts the stock local-only handler');
ok(online.includes('await game.endGame()'), 'forfeit reaches the standard end screen');


// Every online match/rematch has a hard reset and one authoritative opening role.
ok(online.includes('game.reset();'), 'online startMatch hard-resets prior game state');
ok(online.includes('firstRole'), 'lobby handshake carries authoritative first-player role');
ok(online.includes('self._openingRole'), 'coin toss consumes handshake opening role');
ok(online.includes('authoritative first player'), 'opening role is logged for both peers');


// v1.1 play-mode UX: single-player is clean, friend mode reuses Start game as Ready.
const indexHtml = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
ok(indexHtml.includes('button_start_computer') && indexHtml.includes('Play vs Computer'), 'landing offers Play vs Computer');
ok(indexHtml.includes('button_start_friend') && indexHtml.includes('Player vs Friend'), 'landing offers Player vs Friend');
ok(!indexHtml.includes('id="start-ai-game"'), 'legacy Start AI game button removed');
ok(!indexHtml.includes('id="start-online-game"'), 'duplicate Online Multiplayer button removed');
ok(indexHtml.includes('id="start-pvp-game"') && indexHtml.includes('>Online Multiplayer</button>'), 'PvP button repurposed as Online Multiplayer');
ok(online.includes('toggleReadyFromDeckBuilder'), 'friend Start game uses online Ready flow');
ok(online.includes('canReadyFromDeckBuilder'), 'friend Start game is gated by room connection');
ok(online.includes('peerConnected'), 'friend Start game tracks live peer presence');
ok(gwent.includes('window.GwentPlayMode === "friend"'), 'deck-builder routes controls by chosen play mode');

// v1.1.1: cross-browser landing/menu layout must not depend on negative margins or text-width offsets.
const styleCss = fs.readFileSync(path.join(root, 'style.css'), 'utf8');
ok(!styleCss.includes('#play-mode-buttons {\n    margin-top: -43px;'), 'landing buttons do not use overlap-prone negative margin');
ok(indexHtml.includes('id="export-import-actions"'), 'Export/Import actions grouped for stable cross-browser layout');
ok(indexHtml.includes('id="save-load-actions"'), 'Save/Load actions grouped for stable cross-browser layout');
ok(styleCss.includes('.deck-option-pair .deck-options'), 'grouped deck links use flow layout instead of independent absolute offsets');


// v1.1.2: a guest must not wait for the host's lobby-ready message before Ready unlocks.
const safeJoinBlock = online.slice(online.indexOf('async joinRoomSafe()'), online.indexOf('async quickMatchSafe()'));
const safeQuickBlock = online.slice(online.indexOf('async quickMatchSafe()'), online.indexOf('initUI()'));
ok(safeJoinBlock.includes('this.peerConnected = true;') && safeJoinBlock.includes('this.updateReadyUI();'), 'Join Room immediately refreshes Ready after pairing');
ok(safeQuickBlock.includes('this.peerConnected = OnlineNet.role === "guest";') && safeQuickBlock.includes('this.updateReadyUI();'), 'Quick Match immediately refreshes Ready for the second paired player');



// v1.1.3: private hand/deck replicas are synchronized from the owning browser
// and no longer participate in the blocking public-state checksum.
const syncStart = online.indexOf('syncState() {');
const syncEnd = online.indexOf('// Full audit state', syncStart);
const syncBlock = online.slice(syncStart, syncEnd);
ok(online.includes("actorState:self.zoneSnapshot(player_me)"), 'turn-state carries authoritative post-action private zones');
ok(online.includes("reconcilePrivateZones(remoteActor, m.actorState, 'post-action')"), 'peer reconciles acting player private zones before turn check');
ok(!syncBlock.includes('handCount:'), 'blocking sync excludes private hand count');
ok(!syncBlock.includes('deckCount:'), 'blocking sync excludes private deck count');
const serverText = fs.readFileSync(path.join(root, 'server', 'server.js'), 'utf8');
ok(!serverText.includes('if (!allowMessage(ws))\n\t\tif (!allowMessage(ws))'), 'server rate limiter consumes one token per message');



// v1.1.4: Decoy/Spy must be one awaited transaction on both peers.
ok(online.includes('async resolveDecoyAtomic'), 'online has atomic Decoy transaction');
ok(online.includes('await board.toHand(target, row, player.hand);'), 'Decoy fully returns target before continuing');
ok(online.includes('target.holder = player;'), 'Decoy explicitly transfers Spy/target ownership to acting player');
ok(online.includes('return await self.resolveDecoyAtomic(player_me, p, row, card);'), 'local Decoy bypasses stock racy selectCard path');
ok(online.includes('return await this.resolveDecoyAtomic(player, card, row, target);'), 'remote Decoy uses the same atomic transaction');


// v1.1.5: turn ownership is committed explicitly by the acting peer.
ok(online.includes('_turnSeq'), 'online tracks a monotonic turn sequence');
ok(online.includes('nextRole'), 'turn-state carries authoritative next logical role');
ok(online.includes('startTurn(nextRole)'), 'turn transition uses authoritative next role');
ok(online.includes('nextWithTimeout'), 'turn barrier cannot freeze silently forever');
ok(online.includes('Remote action sequence mismatch'), 'remote actions validate turn sequence');


// v1.1.7: Decoy target selection must generate exactly one top-level turn action.
ok(online.includes('decoy:suppress-preliminary-play'), 'Decoy row selection suppresses generic play packet');
ok(online.includes('deferred-decoy-play'), 'remote controller tolerates legacy preliminary Decoy play packet');
ok(online.includes('remote:ignored-preliminary-decoy-play'), 'remote turn keeps waiting after preliminary Decoy play');


// v1.2.0-base-v1.1.7: stale mulligan UI reset + bounded board settle window.
ok(online.includes('Carousel.clearCurrent();'), 'new online match clears stale carousel state');
ok(online.includes("mulligan:open"), 'opening mulligan is traced and explicitly reopened');
ok(online.includes('Date.now() + 2200'), 'public board mismatch has a bounded settle window');
ok(online.includes("sync:settle-ok"), 'settled public board convergence is traced');

// v1.2.4 immutable role mapping regression
ok(online.includes('player_me.onlineRole = this.localRole()'), 'local Player gets immutable onlineRole');
ok(online.includes('player_op.onlineRole = this.otherRole(this.localRole())'), 'remote Player gets immutable onlineRole');
ok(online.includes("if (player_me?.onlineRole === role) return player_me"), 'playerOf uses immutable role marker');
ok(online.includes("state.faction !== player.deck.faction"), 'private-zone sync validates faction before reconciliation');


// v1.3.0 full multiplayer audit invariants
ok(online.includes('beginDecision(kind'), 'all generic decisions can be scoped with decision ids');
ok(online.includes('nextMatching(types'), 'network queue supports decision-scoped message matching');
ok(online.includes('cardLocator(card)'), 'carousel selections use real gameplay card locators');
ok(online.includes('resolveCardLocator(locator'), 'remote carousel resolves real card location');
ok(online.includes('withOwnedEffects(owner'), 'card effects bind delayed hooks to their owner');
ok(online.includes('bindNewGameHooks(owner'), 'delayed card hooks preserve decision ownership');
ok(online.includes('decision:decision.id') || online.includes('decision:decision.id,'), 'choice messages carry decision ids');
ok(online.includes("x => x.decision === decision.id"), 'remote choices filter by decision id');
ok(online.includes('oldRowAddCard'), 'placed card abilities execute in owner context');
ok(online.includes('oldWeatherAddCard'), 'weather card abilities execute in owner context');
ok(online.includes('oldPlayCardAction'), 'activated card abilities execute in owner context');
ok(online.includes('leader:${this.leader?.key'), 'active leaders execute in owner context');
ok(online.includes('faction:${this.deck?.faction'), 'active factions execute in owner context');
const auditDoc = fs.readFileSync(path.join(root, 'docs', 'FULL_MULTIPLAYER_AUDIT_V1.3.0.md'), 'utf8');
ok(auditDoc.includes('Total audited decision call sites: **96**'), 'full audit inventories all 96 interactive decision sites');
ok(auditDoc.includes('Total randomization call sites reviewed: **41**'), 'full audit inventories gameplay randomness');


// v1.3.1 passed-state audit: model and UI must never drift.
const setPassedStart = gwent.indexOf('setPassed(hasPassed)');
const setPassedEnd = gwent.indexOf('// Sets up board for turn', setPassedStart);
const setPassedBlock = gwent.slice(setPassedStart, setPassedEnd);
ok(setPassedBlock.includes('classList.toggle("passed", hasPassed)'), 'setPassed forces passed badge to requested state');
ok(!setPassedBlock.includes('this.passed ^ hasPassed'), 'setPassed no longer depends on previous model/UI state');
ok(!gwent.includes('player_me.passed = false;\n            if (typeof player_me.setPassed'), 'give-up cleanup does not pre-clear local passed boolean before setter');
ok(!gwent.includes('player_op.passed = false;\n            if (typeof player_op.setPassed'), 'give-up cleanup does not pre-clear remote passed boolean before setter');
const passAuditDoc = fs.readFileSync(path.join(root, 'docs', 'PASSED_STATE_AUDIT_V1.3.1.md'), 'utf8');
ok(passAuditDoc.includes('Player.passRound') && passAuditDoc.includes('Player.endRound') && passAuditDoc.includes('rematch'), 'passed-state audit covers all lifecycle transitions');
ok(gwent.includes('player_me.setPassed(false);\n        player_op.setPassed(false);\n\n        await this.runEffects(this.roundStart);'), 'every new round normalizes both passed states before round-start effects');


// v1.3.3 opening-hand race audit.
ok(abilities.includes('game.gameStart.push(async () =>') && abilities.includes('await card.holder.deck.draw(card.holder.hand);'), 'Francesca Daisy opening draws are awaited before mulligan');
ok(factions.includes('await player.deck.draw(player.hand);'), 'opening/round faction draws await hand mutation');
ok(gwent.includes('this.busy = false;') && gwent.includes('if (this.busy) return;'), 'carousel serializes mutating/selecting picks');
ok(online.includes("mulligan:remote-received") && online.indexOf('const remoteMessage = await remoteTask') < online.indexOf('reconcilePrivateZones(remotePlayer, remoteMessage.state'), 'remote mulligan snapshot is applied only after local selection finishes');
ok(online.includes('p.deck.addCard(c.removeCard(i))'), 'Francesca Daisy removes chosen hand card immediately before shuffle');
ok(online.includes("mulligan:daisy-hand-error") && online.includes("mulligan:pick-applied"), 'Daisy opening hand and each applied pick are traced/validated');

// v1.3.2 full opening-mulligan audit.
ok(gwent.includes('await this.initialRedraw();'), 'startGame awaits opening redraw');
ok(gwent.includes('bRedraw = false'), 'carousel exposes explicit redraw mode');
ok(gwent.includes('this.bRedraw = !!bRedraw'), 'carousel stores explicit redraw mode');
ok(gwent.includes('if (this.bRedraw)'), 'carousel selection uses explicit redraw mode');
ok(online.includes('mulligan:barrier-open'), 'online mulligan opens an explicit simultaneous barrier');
ok(online.includes('matchToken:token'), 'mulligan state is scoped to the current match token');
ok(online.includes("mulligan:pick"), 'each local mulligan pick is traced');
ok(online.includes('true\n    );'), 'local mulligan invokes carousel in explicit redraw mode');

// v1.3.4 wheel-only usability regression.
ok(gwent.includes('addEventListener("wheel"') && gwent.includes('curr.shift(e, delta > 0 ? 1 : -1)'), 'carousel supports mouse-wheel navigation');


// v1.3.5 round-transition audit regressions.
ok(gwent.includes('await weather.clearWeather()') && gwent.includes('await Promise.all(board.row.map(async row =>'), 'round cleanup awaits weather and row cleanup');
ok(gwent.includes('async clear()') && gwent.includes('for (const c of units) await board.toGrave(c, this, true)'), 'Row.clear is async and awaits grave moves');
ok(gwent.includes('await this.startRound(verdict)') && gwent.includes('await this.startTurn()'), 'round lifecycle chaining is awaited');
ok(online.includes('roundPhaseBarrier(phase)') && online.includes("t:'round-phase'"), 'online round phase barrier exists');
ok(online.includes('effect-enter') && online.includes('effect-done'), 'online round effects are traced per effect');

// v1.3.6 decision-sync audit regressions.
ok(online.includes('_effectDecisionSerial') && online.includes('const serial = this._effectContext ? this._effectDecisionSerial++ : this._decisionSerial++'), 'owned effects use deterministic per-effect decision ordinals');
ok(online.includes('Timed out waiting for popup choice') && online.includes('decision:popup-timeout'), 'remote popup decisions fail fast instead of freezing forever');
ok(online.includes('Timed out waiting for carousel choice') && online.includes('decision:carousel-timeout'), 'remote carousel decisions fail fast instead of freezing forever');
ok(online.includes('decision:popup-send') && online.includes('decision:popup-recv') && online.includes('decision:carousel-send') && online.includes('decision:carousel-recv'), 'decision synchronization is traced on both peers');
ok(server.includes('"popup-choice", "choice", "choice-end"') && server.includes('detail.decision = msg.data.decision'), 'server logs decision relay ids for deadlock diagnosis');

// v1.3.8 multi-select carousel audit regressions.
ok(gwent.includes('this.selectionCards = []'), 'multi-select tracks stable card identities instead of only indices');
ok(gwent.includes('!this.selectionCards.includes(c)'), 'selected cards are removed from the visible candidate set immediately');
ok(gwent.includes('const picks = this.selectionCards.slice()') && gwent.includes('this.container?.cards?.indexOf(pickedCard)'), 'multi-select commits by card identity after selection closes');
ok(gwent.includes('await sleep(70)') && gwent.includes('middle.classList.add("selection")'), 'multi-select gives immediate visual pick feedback before removing candidate');
ok(online.includes('const pendingChoices = []') && online.includes('if (m.t === "choice-commit") break'), 'remote peer batches selections until choice-commit before executing nested effects');
ok(online.includes("'pre-carousel-transaction'") && online.includes('const privateBase = pendingChoices.find'), 'private-zone base state is reconciled once per multi-select transaction');
ok(online.includes('decision:carousel-commit'), 'remote multi-select commit is traced');


// v1.3.8 carousel commit lifecycle regressions.
ok(gwent.includes('this.committing = true') && gwent.includes('this.committing = false'), 'multi-select exposes an explicit async commit phase');
ok(gwent.includes('await carousel.completion') && gwent.includes('this.releaseUI();') && gwent.includes('this._resolveCompletion();'), 'each carousel owns its completion while nested UI can open');
ok(online.includes("await self.waitBoardInteraction(oldQueue.call(this, container, count, wrapped") && online.indexOf("decision:carousel-send-end") > online.indexOf("await self.waitBoardInteraction(oldQueue.call(this, container, count, wrapped"), 'online choice-end is emitted only after queueCarousel fully resolves');

// v1.3.9 continuation / multi-stage ability audit regressions.
ok(online.includes("previewOnlyLeader") && online.includes("decision:carousel-local-preview"), 'leader preview carousel is local-only and cannot leave stale network choices');
ok(online.includes("const chooser = self.decisionOwner() || this") && online.includes("decision:destination-commit"), 'card destinations are scoped to the logical decision owner and awaited to commit');
ok(online.includes("self._continuationCard === card && self._continuationDecision"), 'continuation destination is detected before ordinary hand-play routing');
ok(abilities.includes("await card.holder.opponent().selectCardDestination") && abilities.includes("await card.holder.selectCardDestination"), 'Emhyr Invader awaits both opponent and own restored-card destinations');
ok(!abilities.slice(abilities.indexOf('emhyr_invader:'), abilities.indexOf('eredin_bringer_of_death:')).includes('endturn_action'), 'Emhyr Invader no longer uses detached nested endturn_action choreography');
const continuationSources = abilities + '\n' + factions;
ok(!/(^|\n)\s*(?:card\.holder|player)\.selectCardDestination\(/m.test(continuationSources), 'audited ability/faction destination continuations are all awaited');
ok(abilities.includes('await resolveInOrder(op_spies,') && abilities.includes('await resolveInOrder(targetCards,'), 'audit removes detached async collection moves in affected abilities');
const contAuditDoc = fs.readFileSync(path.join(root, 'docs', 'CONTINUATION_AUDIT_V1.3.9.md'), 'utf8');
ok(contAuditDoc.includes('Emhyr') && contAuditDoc.includes('decision owner') && contAuditDoc.includes('leader preview'), 'v1.3.9 audit documents the full continuation failure class');

console.log(failed ? 'RESULT: FAILED' : 'RESULT: ALL STATIC CHECKS PASS');
process.exit(failed ? 1 : 0);
