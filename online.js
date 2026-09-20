"use strict";

console.log("[Gwent Online] online.js loaded v1.4.3-choice-audit");

/*
 * Gwent Classic v5.0 online layer.
 * The relay only forwards decisions. Both browsers execute the same v5.0 game
 * locally. Host/guest identities are translated so each browser can keep its
 * own human as player_me (id 0).
 */
class OnlineRNG {
  constructor(seed) { this.state = (seed >>> 0) || 0x6d2b79f5; }
  next() {
    let x = this.state >>> 0;
    x ^= x << 13; x ^= x >>> 17; x ^= x << 5;
    this.state = x >>> 0;
    return this.state / 4294967296;
  }
  int(n) { return n > 0 ? Math.floor(this.next() * n) : 0; }
}

class ControllerRemoteV5 extends Controller {
  constructor(player) { super(); this.player = player; }
  redraw() {}
  async startTurn(player) {
    try {
      GwentOnline.trace("remote:waiting-action", {actor:GwentOnline.roleOfPlayer(player)});
      // A turn normally contains exactly one top-level action.  Older online
      // builds could accidentally emit a preliminary `play` when a Decoy row
      // was clicked and then emit the real `decoy` action when its target was
      // selected.  Keep waiting if such a deferred Decoy packet is observed so
      // it can never consume the remote player's whole turn by itself.
      while (GwentOnline.active) {
        const m = await GwentOnline.next("action");
        if (!m || !GwentOnline.active) return;
        GwentOnline.trace("remote:got-action", {actor:GwentOnline.roleOfPlayer(player), action:m.a || null, card:m.card?.key || null, target:m.target?.key || null});
        const result = await GwentOnline.applyRemoteAction(player, m);
        // A cancelled/unavailable ability leaves the same player on turn.
        if (result === false) continue;
        if (result === "deferred-decoy-play") {
          GwentOnline.trace("remote:ignored-preliminary-decoy-play", {actor:GwentOnline.roleOfPlayer(player), card:m.card?.key || null});
          continue;
        }
        GwentOnline.trace("remote:action-complete", {actor:GwentOnline.roleOfPlayer(player), action:m.a || null});
        return result;
      }
    } catch (e) {
      await GwentOnline.failAsync("remote-action", e);
    }
  }
}

// Hidden hand for the remote human. v5's normal Hand keeps cards sorted,
// while HandAI appends them. Multiplayer redraw messages use hand indices,
// so the remote replica MUST mirror Hand's sorted insertion semantics.
class HandRemoteV5 extends HandAI {
  hide() {}
  show() {}
  toggleDisplay() {}
  addCard(card, index) {
    if (!card) return;
    if (Number.isInteger(index))
      this.cards.splice(Math.max(0, Math.min(this.cards.length, index)), 0, card);
    else
      this.addCardSorted(card);
    this.resize();
    card.currentLocation = this;
  }
}

const GwentOnline = {
  active: false,
  role: null,
  queue: [],
  waiters: [],
  remoteDeck: null,
  localReady: false,
  remoteReady: false,
  peerConnected: false,
  opLeaderChoice: "normal",
  remoteOpLeaderChoice: null,
  _decisionOwner: null,
  _effectContext: null,
  _decisionSerial: 0,
  _effectDecisionSerial: 0,
  gameRng: null,
  deckRng: {host:null, guest:null},
  rngScope: null,
  _patched: false,
  _sendingSuppressed: false,
  _uiInitialized: false,
  _roomActionBusy: false,
  _forfeitEnding: false,
  _openingRole: null,
  _turnSeq: 0,
  _matchToken: null,

  otherRole(role) { return role === "host" ? "guest" : "host"; },
  localRole() { return this.role || OnlineNet.role || "host"; },
  roleOfId(id) { return id === 0 ? this.localRole() : this.otherRole(this.localRole()); },

  // Never infer network identity from player_me/player_op after a match has
  // started. Those are local-perspective globals and are recreated between
  // matches. Each Player receives an immutable onlineRole marker at startMatch.
  playerOf(role) {
    if (player_me?.onlineRole === role) return player_me;
    if (player_op?.onlineRole === role) return player_op;
    // Compatibility fallback before startMatch has installed the markers.
    return role === this.localRole() ? player_me : player_op;
  },
  roleOfPlayer(p) {
    if (!p) return null;
    if (p.onlineRole === "host" || p.onlineRole === "guest") return p.onlineRole;
    return p.id === 0 ? this.localRole() : this.otherRole(this.localRole());
  },
  isRemote(p) { return this.active && p && p.controller instanceof ControllerRemoteV5; },

  seedAll(seed) {
    const s = Number(seed) >>> 0;
    this.gameRng = new OnlineRNG(s ^ 0x9e3779b9);
    this.deckRng.host = new OnlineRNG(s ^ 0x243f6a88);
    this.deckRng.guest = new OnlineRNG(s ^ 0xb7e15162);
  },
  random() {
    const r = this.rngScope ? this.deckRng[this.rngScope] : this.gameRng;
    return (r || new OnlineRNG(Date.now())).next();
  },
  randomInt(n) {
    const r = this.rngScope ? this.deckRng[this.rngScope] : this.gameRng;
    return r ? r.int(n) : Math.floor(Math.random() * n);
  },

  withDeckRng(role, fn) {
    const prev = this.rngScope;
    this.rngScope = role;
    try { return fn(); } finally { this.rngScope = prev; }
  },

  cardToWire(card, hand) {
    if (!card) return null;
    const same = hand.cards.filter(c => c.key === card.key);
    return {key: card.key, occurrence: Math.max(0, same.indexOf(card))};
  },
  cardFromWire(ref, hand) {
    if (!ref || !ref.key || !hand) return null;
    const same = hand.cards.filter(c => c.key === ref.key);
    return same[Number.isInteger(ref.occurrence) ? ref.occurrence : 0] || null;
  },

  zoneSnapshot(player) {
    const keys = c => (c?.cards || []).map(x => x.key);
    return {
      role: this.roleOfPlayer(player),
      faction: player?.deck?.faction || null,
      hand: keys(player.hand),
      deck: keys(player.deck),
      grave: keys(player.grave)
    };
  },

  _sameKeys(a, b) {
    return Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((x,i) => x === b[i]);
  },

  // Reconcile only private zones (hand/deck). This deliberately never repairs
  // rows/weather: a board mismatch is a real simulation bug and must fail.
  reconcilePrivateZones(player, state, context = "sync", options = {}) {
    if (!state || !Array.isArray(state.hand) || !Array.isArray(state.deck))
      return this.desync(`Invalid ${context} snapshot`);

    // The wire role is authoritative. If a stale local-perspective reference was
    // passed in, repair the target before touching any private cards. This is
    // what prevents a Skellige snapshot from ever being applied to the Northern
    // Realms player (or vice versa).
    if (state.role === "host" || state.role === "guest") {
      const byRole = this.playerOf(state.role);
      if (byRole) player = byRole;
    }
    if (!player) return this.desync(`Missing ${context} player`);
    const actualRole = this.roleOfPlayer(player);
    if (state.role && actualRole !== state.role)
      return this.desync(`${context} role mismatch: expected ${state.role}, got ${actualRole}`);
    if (state.faction && player.deck?.faction && state.faction !== player.deck.faction) {
      console.error('[Gwent Online] private-zone faction mismatch', {context, state, actualRole, actualFaction:player.deck.faction});
      this.trace('sync:private-role-error', {actor:actualRole, err:`${context}: expected ${state.faction}, got ${player.deck.faction}`});
      return this.desync(`${context} player mapping mismatch (${state.faction} vs ${player.deck.faction})`);
    }

    const currentHand = player.hand.cards.map(c => c.key);
    const currentDeck = player.deck.cards.map(c => c.key);
    if (this._sameKeys(currentHand, state.hand) && this._sameKeys(currentDeck, state.deck)) return true;

    const pool = [...player.hand.cards, ...player.deck.cards];
    const byKey = new Map();
    for (const card of pool) {
      if (!byKey.has(card.key)) byKey.set(card.key, []);
      byKey.get(card.key).push(card);
    }
    const take = (key) => {
      const a = byKey.get(key);
      return a && a.length ? a.shift() : null;
    };
    const hand = state.hand.map(take);
    const deck = state.deck.map(take);
    if (hand.some(x => !x) || deck.some(x => !x) || [...byKey.values()].some(a => a.length)) {
      console.error('[Gwent Online] private-zone multiset mismatch', {
        context, role:actualRole, faction:player.deck?.faction,
        expected:{hand:state.hand, deck:state.deck}, actual:{hand:currentHand, deck:currentDeck}
      });
      this.trace('sync:private-multiset-error', {actor:actualRole, err:`${context} ${player.deck?.faction || ''}`});
      if (options.nonFatal) {
        console.warn('[Gwent Online] non-fatal private-zone multiset mismatch; selection locator will recover the authoritative card', {context, actualRole});
        return true;
      }
      return this.desync(`${context} private-zone mismatch for ${actualRole}/${player.deck?.faction || 'unknown faction'}`);
    }
    player.hand.cards = hand;
    player.deck.cards = deck;
    for (const c of hand) c.currentLocation = player.hand;
    for (const c of deck) c.currentLocation = player.deck;
    player.hand.resize();
    player.deck.resize();
    this.rebuildDeckVisuals(player.deck);
    console.warn('[Gwent Online] reconciled private zones', {context, role:this.roleOfPlayer(player)});
    return true;
  },

  rebuildDeckVisuals(deck) {
    if (!deck?.elem || !deck.counter) return;
    for (const el of [...deck.elem.querySelectorAll('.deck-card')]) el.remove();
    for (let i=0; i<deck.cards.length; i++) {
      const el = document.createElement('div');
      el.classList.add('deck-card');
      el.style.backgroundImage = iconURL('deck_back_' + deck.faction, 'jpg');
      deck.setCardOffset(el, i);
      deck.elem.insertBefore(el, deck.counter);
    }
    deck.resize();
  },

  containerCardRef(container, card) {
    if (!container?.cards || !card) return null;
    return this.cardToWire(card, container);
  },
  containerCardFromRef(container, ref) {
    return this.cardFromWire(ref, container);
  },

  // Describe containers whose contents are private/player-owned. Carousel choices
  // from hand/deck must be replayed against the same logical zone on the peer,
  // not merely whatever stale local container happened to be passed to the ability.
  describePrivateContainer(container) {
    for (const role of ["host", "guest"]) {
      const p = this.playerOf(role);
      if (!p) continue;
      if (container === p.hand) return {kind:"zone", role, zone:"hand"};
      if (container === p.deck) return {kind:"zone", role, zone:"deck"};
      if (container === p.grave) return {kind:"zone", role, zone:"grave"};
    }
    return null;
  },

  resolvePrivateContainer(desc, fallback) {
    if (!desc || desc.kind !== "zone") return fallback;
    const p = this.playerOf(desc.role);
    const c = p && p[desc.zone];
    return c && Array.isArray(c.cards) ? c : fallback;
  },

  // Decoy must be resolved as one ordered transaction online. The stock v5
  // UI starts board.toHand(target, row) without awaiting it, then moves the
  // Decoy and can end the turn while the target is still travelling. That is
  // particularly unsafe for spies because their holder changes when placed.
  // Always move the target fully into the acting player's hand first, then
  // place the Decoy, and only then end the turn.
  async resolveDecoyAtomic(player, decoy, row, target) {
    const actorRole = this.roleOfPlayer(player);
    this.trace("decoy:begin", {actor:actorRole, card:decoy?.key || null, target:target?.key || null});
    try {
    console.log('[Gwent Online] decoy transaction begin', {
      seq:this._turnSeq,
      actorRole:this.roleOfPlayer(player),
      target:target?.key || null,
      targetHolder:target?.holder ? this.roleOfPlayer(target.holder) : null,
      current:game?.currPlayer ? this.roleOfPlayer(game.currPlayer) : null
    });
    if (!player || !decoy || !row || !target)
      return this.desync("Invalid atomic decoy transaction");
    if (!row.cards?.includes(target))
      return this.desync("Decoy target is no longer on the selected row: " + (target.key || "unknown"));
    if (!player.hand?.cards?.includes(decoy))
      return this.desync("Decoy card is no longer in acting player's hand: " + (decoy.key || "unknown"));

    // A Decoy takes the selected unit into the acting player's hand. For a spy
    // this also makes ownership explicit instead of relying on the timing of
    // the spy's holder flip from its placed ability.
    target.decoyTarget = true;
    target.holder = player;
    await board.toHand(target, row, player.hand);
    this.trace("decoy:target-to-hand", {actor:actorRole, card:decoy?.key || null, target:target?.key || null});

    // Do not let the turn barrier run until the board swap is completely done.
    await board.moveTo(decoy, row, player.hand);
    this.trace("decoy:decoy-on-row", {actor:actorRole, card:decoy?.key || null, target:target?.key || null});
    board.updateScores();
    console.log('[Gwent Online] decoy transaction board-complete', {
      seq:this._turnSeq,
      actorRole:this.roleOfPlayer(player),
      hand:player.hand.cards.map(c=>c.key),
      current:game?.currPlayer ? this.roleOfPlayer(game.currPlayer) : null
    });
    this.trace("decoy:before-endturn", {actor:actorRole, card:decoy?.key || null, target:target?.key || null});
    const result = await player.endTurn();
    this.trace("decoy:after-endturn", {actor:actorRole, card:decoy?.key || null, target:target?.key || null});
    return result;
    } catch (e) {
      return await this.failAsync("decoy", e);
    }
  },

  boardCardToWire(card) {
    const row = card?.currentLocation;
    if (!row || !board.row.includes(row)) return null;
    return { row:this.destToWire(row), card:this.containerCardRef(row, card) };
  },
  boardCardFromWire(ref) {
    if (!ref) return null;
    const row = this.destFromWire(ref.row);
    return row ? this.containerCardFromRef(row, ref.card) : null;
  },

  send(m) {
    if (!m) return;
    // Every top-level turn action carries the logical actor and turn sequence.
    // This makes stale/double actions detectable and gives the turn barrier one
    // perspective-neutral identity on both browsers.
    if (m.t === "action" && this.active) {
      if (m.actorRole == null) m.actorRole = this.localRole();
      if (m.seq == null) m.seq = this._turnSeq;
      console.log("[Gwent Online] send action", {seq:m.seq, actorRole:m.actorRole, action:m.a});
    }
    if (this.active || String(m.t).startsWith("lobby-")) OnlineNet.send(m);
  },
  trace(stage, extra = {}) {
    const payload = Object.assign({
      stage,
      seq:this._turnSeq,
      curr:(typeof game !== "undefined" && game.currPlayer) ? this.roleOfPlayer(game.currPlayer) : null
    }, extra || {});
    try { OnlineNet.trace(payload); } catch (_) {}
    console.log("[Gwent Online TRACE]", payload);
  },

  async failAsync(context, err) {
    if (err?.name === "AbortError") return;
    const text = err && (err.stack || err.message) ? String(err.stack || err.message) : String(err);
    this.trace(context + ":error", {err:text});
    console.error("[Gwent Online] async failure", context, err);
    return this.desync(`${context} failed: ${err && err.message ? err.message : err}`);
  },

  route(m) {
    if (!m || typeof m.t !== "string") return;
    if (m.t.startsWith("lobby-")) return this.routeLobby(m);
    if (m.t === 'match-stop') {
      if (this.active && m.matchToken === this._matchToken)
        this.desync('The other client stopped the match: ' + String(m.reason || 'synchronization error'), false);
      return;
    }

    // A forfeit is match-level control, not a turn action. It must be handled
    // immediately even when this client is blocked waiting in ControllerRemoteV5
    // or at a turn-state barrier. Queuing it as a normal action leaves the peer
    // frozen forever when the other player presses Give up.
    if (m.t === "match-forfeit") {
      void this.handleRemoteForfeit(m);
      return;
    }

    this.queue.push(m);
    this.flushWaiters();
  },

  async concedeLocal() {
    if (!this.active || typeof game === "undefined" || game.over || this._forfeitEnding) return;
    const loserRole = this.localRole();
    console.log("[Gwent Online] local forfeit", {loserRole, room:OnlineNet.code});

    // Send before changing local state so the peer cannot be stranded if the
    // end-screen transition below throws for some unrelated UI reason.
    this.send({t:"match-forfeit", loser:loserRole});
    await this.finishForfeit(loserRole, true);
  },

  async handleRemoteForfeit(m) {
    if (!this.active || typeof game === "undefined" || game.over || this._forfeitEnding) return;
    const loserRole = (m && (m.loser === "host" || m.loser === "guest"))
      ? m.loser
      : this.otherRole(this.localRole());

    // The peer is only allowed to concede its own logical role. A malformed or
    // stale packet must never make this browser declare itself the loser.
    if (loserRole === this.localRole()) {
      console.error("[Gwent Online] invalid remote forfeit role", {message:m, localRole:this.localRole()});
      return this.desync("Invalid remote forfeit role: " + loserRole);
    }

    console.log("[Gwent Online] remote forfeit", {loserRole, room:OnlineNet.code});
    await this.finishForfeit(loserRole, false);
  },

  async finishForfeit(loserRole, localInitiated) {
    if (!this.active || typeof game === "undefined" || game.over || this._forfeitEnding) return;
    this._forfeitEnding = true;
    try {
      const loser = this.playerOf(loserRole);
      const winner = this.playerOf(this.otherRole(loserRole));
      if (!loser || !winner) return this.desync("Could not resolve forfeit players");

      // Freeze the turn engine first. Do NOT call Game.reset()/Player.reset() as
      // the old v5 Give up handler does: that destroys the match history and
      // leaves the two online clients in different states.
      game.over = true;
      this.cancelBoardInteractions();
      try { limpar(); } catch (_) {}
      try { ui.enablePlayer(false); } catch (_) {}
      document.getElementById("pass-button")?.classList.add("noclick");
      document.getElementById("stats-me")?.classList.remove("current-turn");
      document.getElementById("stats-op")?.classList.remove("current-turn");
      player_me?.elem_leader?.children?.[1]?.classList.add("hide");
      player_op?.elem_leader?.children?.[1]?.classList.add("hide");

      // endGame() decides win/loss from health. Preserve every completed round
      // and record the in-progress board as the final forfeited round so both
      // end screens remain meaningful.
      loser.health = 0;
      if ((Number(winner.health) || 0) <= 0) winner.health = 1;
      if (Array.isArray(game.roundHistory) && game.roundHistory.length < 3) {
        const last = game.roundHistory[game.roundHistory.length - 1];
        if (!last || !last.forfeit) {
          game.roundHistory.push({
            winner,
            score_me: Number(player_me.total) || 0,
            score_op: Number(player_op.total) || 0,
            forfeit: true
          });
        }
      }

      console.log("[Gwent Online] forfeit finalized", {
        loserRole,
        winnerRole:this.otherRole(loserRole),
        localInitiated:!!localInitiated
      });
      await game.endGame();
    } finally {
      this._forfeitEnding = false;
    }
  },
  flushWaiters() {
    if (!this.waiters.length || !this.queue.length) return;
    for (let w = 0; w < this.waiters.length; w++) {
      const waiter = this.waiters[w];
      const idx = this.queue.findIndex(m => waiter.types.includes(m.t) && (!waiter.match || waiter.match(m)));
      if (idx >= 0) {
        const [m] = this.queue.splice(idx, 1);
        this.waiters.splice(w, 1);
        waiter.resolve(m);
        return this.flushWaiters();
      }
    }
  },
  next(...types) {
    return this.nextMatching(types, null);
  },
  nextMatching(types, match = null) {
    const list = Array.isArray(types) ? types : [types];
    const idx = this.queue.findIndex(m => list.includes(m.t) && (!match || match(m)));
    if (idx >= 0) return Promise.resolve(this.queue.splice(idx, 1)[0]);
    return new Promise(resolve => this.waiters.push({types:list, match, resolve}));
  },

  async nextWithTimeout(types, ms, label) {
    const list = Array.isArray(types) ? types : [types];
    let timer = null;
    try {
      return await Promise.race([
        this.next(...list),
        new Promise((_, reject) => {
          timer = setTimeout(() => reject(new Error(label || ("Timed out waiting for " + list.join('/')))), ms);
        })
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  },

  async nextMatchingWithTimeout(types, match, ms, label) {
    const list = Array.isArray(types) ? types : [types];
    const signal = this._matchAbort?.signal;
    if (signal?.aborted) throw new DOMException('Online match closed', 'AbortError');
    const queued = this.queue.findIndex(m => list.includes(m.t) && (!match || match(m)));
    if (queued >= 0) return this.queue.splice(queued, 1)[0];
    return await new Promise((resolve, reject) => {
      let timer;
      const cleanup = () => {
        clearTimeout(timer);
        signal?.removeEventListener('abort', abort);
        const i = this.waiters.indexOf(waiter);
        if (i >= 0) this.waiters.splice(i, 1);
      };
      const abort = () => { cleanup(); reject(new DOMException('Online match closed', 'AbortError')); };
      const waiter = {types:list, match, resolve:m => { cleanup(); resolve(m); }};
      this.waiters.push(waiter);
      signal?.addEventListener('abort', abort, {once:true});
      timer = setTimeout(() => { cleanup(); reject(new Error(label || ('Timed out waiting for ' + list.join('/')))); }, ms);
    });
  },

  waitBoardInteraction(promise) {
    const signal = this._matchAbort?.signal;
    if (!signal) return promise;
    return new Promise((resolve,reject) => {
      const abort = () => reject(new DOMException('Online match closed', 'AbortError'));
      if (signal.aborted) return abort();
      signal.addEventListener('abort',abort,{once:true});
      promise.then(resolve,reject).finally(()=>signal.removeEventListener('abort',abort));
    });
  },

  cancelBoardInteractions() {
    this._matchAbort?.abort();
    this._rearrangement = this._abilityTarget = this._powerEdit = null;
    if (typeof ui !== 'undefined') {
      ui.underRearrangement = ui.underCardPowerEdit = false;
      ui._arrangementDone = ui._powerEditDone = null;
      ui.updateArrangementCounter(0);
    }
  },

  async roundPhaseBarrier(phase) {
    if (!this.active) return true;
    const round = Number(game?.roundCount) || 0;
    const token = this._matchToken || null;
    let state = this.syncState();
    let hash = this.hashState(state);
    const localRole = this.localRole();
    this.trace(`round:${phase}:barrier-send`, {actor:localRole, err:`r${round}`});
    this.send({t:'round-phase', phase, round, matchToken:token, role:localRole, h:hash, state});
    let remote;
    try {
      remote = await this.nextMatchingWithTimeout('round-phase', m => m && m.phase === phase && Number(m.round) === round && (!m.matchToken || m.matchToken === token), 45000, `Timed out waiting for peer at ${phase} barrier (round ${round})`);
    } catch (e) {
      this.trace(`round:${phase}:barrier-timeout`, {actor:localRole, err:e.message});
      return this.desync(e.message);
    }
    if (!remote) return this.desync(`Missing ${phase} round barrier`);
    if (remote.h !== hash) {
      const deadline = Date.now() + 2500;
      while (remote.h !== hash && Date.now() < deadline) {
        await sleep(80);
        try { board.updateScores(); } catch (_) {}
        state = this.syncState();
        hash = this.hashState(state);
      }
    }
    if (remote.h !== hash) {
      const diff = this.firstStateDifference(state, remote.state);
      const detail = diff ? `${diff.path}: local=${this.shortValue(diff.local)} remote=${this.shortValue(diff.remote)}` : `local=${hash} remote=${remote.h}`;
      return this.desync(`Round ${phase} mismatch at ${detail}`);
    }
    this.trace(`round:${phase}:barrier-ok`, {actor:localRole, err:`r${round}`});
    return true;
  },

  makeDeckRaw() {
    const obj = JSON.parse(dm.deckToJSON());
    obj.title = dm.me_deck_title || (document.querySelector("#faction-title h1") || {}).textContent || obj.faction;
    return obj;
  },
  deckFromRaw(raw) {
    if (!raw || !raw.faction || !card_dict[raw.leader] || !Array.isArray(raw.cards)) throw new Error("Invalid deck received");
    return {
      faction: raw.faction,
      leader: {index: raw.leader, card: card_dict[raw.leader]},
      cards: raw.cards.map(x => ({index:x[0], count:Number(x[1])})),
      title: raw.title || factions[raw.faction]?.name || raw.faction
    };
  },
  validateDeckRaw(raw) {
    try {
      const d = this.deckFromRaw(raw);
      let units = 0, specials = 0;
      for (const x of d.cards) {
        const cd = card_dict[x.index];
        if (!cd || !Number.isInteger(x.count) || x.count < 1) return false;
        if (cd.row === "special" || cd.row === "weather") specials += x.count; else if (cd.row !== "leader") units += x.count;
      }
      return units >= 22 && specials <= 10;
    } catch (_) { return false; }
  },

  async createRoom() {
    this.updateLobby("Connecting to multiplayer server…");
    await this.ensureConnected();
    this.updateLobby("Connected. Creating room…");
    const code = await OnlineNet.createRoom();
    this.role = "host";
    this.peerConnected = false;
    this.updateLobby(`Room: ${code} — waiting for opponent…`, code);
    this.updateDeckStartButton();
  },
  async joinRoom(code) {
    this.updateLobby("Connecting to multiplayer server…");
    await this.ensureConnected();
    await OnlineNet.joinRoom(code);
    this.role = "guest";
    this.peerConnected = true;
    this.updateLobby(`Joined ${OnlineNet.code}. You can now press Start game when your deck is set.`, OnlineNet.code);
    // A successful join response means the relay has already paired us with
    // the room host. Refresh BOTH Ready controls immediately; otherwise the
    // lobby Ready button can remain disabled until the host sends lobby-ready.
    this.updateReadyUI();
    this.updateDeckStartButton();
    this.sendOpLeaderChoice();
  },
  async quickMatch() {
    this.updateLobby("Connecting to multiplayer server…");
    await this.ensureConnected();
    const code = await OnlineNet.quickMatch();
    this.role = OnlineNet.role;
    this.peerConnected = OnlineNet.role === "guest";
    this.updateLobby(`Matched in room ${code}.`, code);
    // Guests are paired at the moment the quickmatch request resolves. Hosts
    // remain disabled until the server's peer-joined event arrives.
    this.updateReadyUI();
    this.updateDeckStartButton();
  },
  async ensureConnected() {
    OnlineNet.onMessage = m => this.route(m);
    OnlineNet.onPeerJoined = () => {
      this.peerConnected = true;
      this.updateLobby("Opponent joined. Both players can now press Start game.", OnlineNet.code);
      this.updateReadyUI();
      this.updateDeckStartButton();
      this.sendOpLeaderChoice();
    };
    OnlineNet.onPeerLeft = () => this.peerLeft();
    await OnlineNet.connect();
    this.updateDeckStartButton();
  },
  ready() {
    if (!OnlineNet.role) return this.updateLobby("Create or join a room first.");
    if (!this.peerConnected) return this.updateLobby("Wait for your friend to join the room first.", OnlineNet.code);
    const deck = this.makeDeckRaw();
    if (!this.validateDeckRaw(deck)) return this.updateLobby("Deck is not valid (minimum 22 units, maximum 10 specials).", OnlineNet.code);
    this.localReady = true;
    this.send({t:"lobby-ready", deck});
    this.updateReadyUI();
    this.updateRematchUI();
    this.maybeStartAsHost();
  },
  unready() {
    this.localReady = false;
    this.send({t:"lobby-unready"});
    this.updateReadyUI();
    this.updateRematchUI();
  },
  // The opponent-leader choice this player makes for the OTHER player. Each
  // player's choice is independent and asymmetric: it only locks the peer.
  // The player who picks "Random Leader" owns the RNG seed and sends it; the
  // locked peer waits for that seed so both peers resolve the same leader.
  onOpLeaderChoice(choice) {
    this.opLeaderChoice = (choice === "random") ? "random" : "normal";
    const el = document.getElementById("op-leader-name");
    if (el) {
      el.innerHTML = this.opLeaderChoice === "random" ? "Random Leader" : "Normal";
      el.classList.toggle("rerollable", this.opLeaderChoice === "random");
    }
    if (this.opLeaderChoice === "random") this.sendOpLeaderSeed();
    this.sendOpLeaderChoice();
  },
  sendOpLeaderChoice() {
    if (!OnlineNet.connected || !this.peerConnected) return;
    try { this.send({t:"lobby-opleader", choice:this.opLeaderChoice}); } catch (_) {}
  },
  // Outgoing seed: this peer's own RNG for locking the OTHER player. Kept
  // separate from the incoming seed (the one we received from the peer for
  // ourselves) so the two independent random picks never collide.
  sendOpLeaderSeed() {
    if (this._outRandomLeaderSeed == null) {
      this._outRandomLeaderSeed = (Math.random() * 4294967296) >>> 0 || 1;
    }
    if (!OnlineNet.connected || !this.peerConnected) return;
    try { this.send({t:"lobby-opleader-seed", seed:this._outRandomLeaderSeed}); } catch (_) {}
  },
  // Re-randomize the opponent's leader: generate a fresh outgoing seed and
  // resend it so the locked peer resolves a new random leader+deck. Triggered
  // by clicking the "Random Leader" text under Select Opponent Leader.
  rerollOpLeader() {
    if (this.opLeaderChoice !== "random") return;
    this._outRandomLeaderSeed = (Math.random() * 4294967296) >>> 0 || 1;
    this.sendOpLeaderSeed();
  },
  // When the remote peer has chosen Random Leader for us, lock our own
  // leader+faction selectors (the deck composition stays editable). When
  // Normal or unknown, unlock them so we can choose freely.
  applyRemoteOpLeaderLock() {
    const locked = this.remoteOpLeaderChoice === "random";
    const changeFaction = document.getElementById("change-faction");
    if (changeFaction) changeFaction.classList.toggle("noclick", locked);
    const cardLeader = document.getElementById("card-leader");
    if (cardLeader) cardLeader.classList.toggle("leader-locked", locked);
    const selectDeck = document.getElementById("select-deck");
    if (selectDeck) selectDeck.classList.toggle("noclick", locked);
    if (locked) this.applyRandomLeaderForSelf();
    else {
      this._randomLeaderApplied = false;
      this._inRandomLeaderSeed = null;
      if (this.remoteOpLeaderChoice === "normal") this.updateLobby("Opponent lets you pick your leader/faction freely.", OnlineNet.code);
    }
  },
  clearOpLeaderLock() {
    const locked = false;
    const changeFaction = document.getElementById("change-faction");
    if (changeFaction) changeFaction.classList.toggle("noclick", locked);
    const cardLeader = document.getElementById("card-leader");
    if (cardLeader) cardLeader.classList.toggle("leader-locked", locked);
    const selectDeck = document.getElementById("select-deck");
    if (selectDeck) selectDeck.classList.toggle("noclick", locked);
  },
  // Apply the remote peer's Random Leader lock locally. The peer who chose
  // Random Leader already sent a lobby-opleader-seed; if it has arrived, apply
  // it now, otherwise wait for routeLobby to apply it on arrival.
  applyRandomLeaderForSelf() {
    if (this._randomLeaderApplied) return;
    if (this._inRandomLeaderSeed == null) return;
    this._randomLeaderApplied = true;
    this._applyRandomLeaderSeed(this._inRandomLeaderSeed);
  },
  // Pick a random leader+deck from the full "Select Own Deck" pool: every
  // premade deck across all factions. This mirrors selecting a deck manually
  // under "Select Own Deck" (setFaction + deckFromJSON), so the whole deck
  // composition follows the picked leader. Each peer resolves from its own
  // incoming seed, so the two picks are independent.
  _applyRandomLeaderSeed(seed) {
    if (!dm || typeof premade_deck === "undefined" || typeof card_dict === "undefined" || typeof factions === "undefined") return;
    const pool = Object.values(premade_deck)
      .filter(d => d.leader && card_dict[d.leader] && card_dict[d.leader].row === "leader");
    if (!pool.length) return;
    const s = (seed >>> 0) || 1;
    let x = s;
    const next = () => { x ^= x << 13; x >>>= 0; x ^= x >> 17; x ^= x << 5; x >>>= 0; return x; };
    const deck = pool[next() % pool.length];
    dm.deckFromJSON(deck, false);
    if (dm.leader_elem && dm.leader_elem.children[1]) getPreviewElem(dm.leader_elem.children[1], dm.leader.card);
    this.updateLobby("Opponent chose Random Leader — your leader+deck locked.", OnlineNet.code);
  },
  routeLobby(m) {
    if (m.t === "lobby-ready") { this.remoteDeck = m.deck; this.remoteReady = this.validateDeckRaw(m.deck); this.updateReadyUI(); this.updateDeckStartButton(); this.updateRematchUI(); return this.maybeStartAsHost(); }
    if (m.t === "lobby-unready") { this.remoteReady = false; this.remoteDeck = null; this.updateReadyUI(); this.updateDeckStartButton(); return this.updateRematchUI(); }
    if (m.t === "lobby-customizing") {
      this.remoteReady = false;
      this.remoteDeck = null;
      this.updateReadyUI();
      this.updateRematchUI();
      return this.updateLobby("Opponent is customizing their deck.", OnlineNet.code);
    }
    if (m.t === "lobby-opleader") {
      this.remoteOpLeaderChoice = (m.choice === "random") ? "random" : "normal";
      this.applyRemoteOpLeaderLock();
      return;
    }
    if (m.t === "lobby-opleader-seed") {
      this._inRandomLeaderSeed = m.seed >>> 0;
      // A re-roll sends a new seed; allow it to apply even if a previous
      // random leader was already resolved.
      this._randomLeaderApplied = false;
      this.applyRandomLeaderForSelf();
      return;
    }
    if (m.t === "lobby-start") {
      if (m.firstRole !== "host" && m.firstRole !== "guest") return this.desync("Invalid opening-player role in match handshake");
      this.send({t:"lobby-start-ack", seed:m.seed, firstRole:m.firstRole});
      return this.startMatch(m.seed, this.makeDeckRaw(), m.hostDeck, m.firstRole);
    }
    if (m.t === "lobby-start-ack" && this.role === "host" && this._pendingStart) {
      const p = this._pendingStart;
      if (m.seed !== p.seed || m.firstRole !== p.firstRole) return this.desync("Rematch handshake mismatch");
      this._pendingStart = null;
      return this.startMatch(p.seed, p.localDeck, p.remoteDeck, p.firstRole);
    }
  },
  maybeStartAsHost() {
    if (this.role !== "host" || !this.localReady || !this.remoteReady || !this.remoteDeck || this._pendingStart) return;
    const seed = (crypto?.getRandomValues ? crypto.getRandomValues(new Uint32Array(1))[0] : Date.now()) >>> 0;
    // First player is part of the authoritative host handshake. Do not derive it
    // from each client's local RNG stream: a previous match/forfeit may have
    // consumed a different number of random values before the rematch starts.
    const firstRole = (seed & 1) ? "host" : "guest";
    const localDeck = this.makeDeckRaw();
    this._pendingStart = {seed, firstRole, localDeck, remoteDeck:this.remoteDeck};
    this.send({t:"lobby-start", seed, firstRole, hostDeck:localDeck});
    this.updateLobby("Starting match…", OnlineNet.code);
  },

  async startMatch(seed, localRaw, remoteRaw, firstRole) {
    this.cancelBoardInteractions();
    this._matchAbort = new AbortController();
    this.active = true; this.role = OnlineNet.role; this.queue = []; this.waiters = [];
    this._turnSeq = 0;
    this._randomLeaderApplied = false;
    this._decisionSerial = 0;
    this._effectDecisionSerial = 0;
    this._decisionOwner = null;
    this._effectContext = null;
    this.patchRuntime();

    if (firstRole !== "host" && firstRole !== "guest")
      return this.desync("Missing authoritative opening-player role");

    // Match-scoped token prevents a late mulligan packet from an earlier
    // rematch/session from satisfying the new match's redraw barrier.
    this._matchToken = `${Number(seed) >>> 0}:${firstRole}`;

    // Hard match boundary. A forfeit intentionally leaves the in-progress board
    // visible for the end screen, so a rematch must clear *all* Game state here:
    // effect callback arrays, round counters/history, weather/rows, current/first
    // player and the over flag. Merely replacing player_me/player_op is not enough.
    try { limpar(); } catch (_) {}
    game.reset();
    game.mode = 4;

    // A Carousel is global UI state in v5 and is not cleared by Game.reset().
    // If a previous mulligan/ability/rematch left Carousel.curr or ui.carousels
    // behind, the next opening redraw is queued behind a dead carousel and the
    // player sees "Draw 2 new cards" but cannot interact with it. Treat a new
    // online match as a hard UI boundary as well as a hard Game boundary.
    try {
      if (typeof Carousel !== 'undefined') {
        Carousel.clearCurrent();
        if (Carousel.elem) Carousel.elem.classList.add('hide');
      }
      if (ui) {
        ui.carousels = [];
        ui.previewCard = null;
        ui.lastRow = null;
        ui.underRearrangement = false;
        ui.underCardPowerEdit = false;
      }
      document.getElementById('carousel')?.classList.add('hide');
      document.getElementsByTagName('main')[0]?.classList.remove('noclick');
    } catch (e) { console.warn('[Gwent Online] transient UI reset failed', e); }

    // Seed only after the reset. From here onward all match RNG belongs to this
    // match and cannot inherit consumption from the previous one.
    this.seedAll(seed);
    this._openingRole = firstRole;
    this._forfeitEnding = false;
    this.localReady = false;
    this.remoteReady = false;
    this.remoteDeck = null;
    this._pendingStart = null;
    this.updateReadyUI();
    this.updateRematchUI();

    const localDeck = this.deckFromRaw(localRaw);
    const remoteDeck = this.deckFromRaw(remoteRaw);
    this.rngScope = this.localRole();
    player_me = new Player(0, "You", localDeck, false);
    player_me.onlineRole = this.localRole();
    this.rngScope = this.otherRole(this.localRole());
    player_op = new Player(1, "Opponent", remoteDeck, true);
    player_op.onlineRole = this.otherRole(this.localRole());
    console.log('[Gwent Online] role map installed', {
      localRole:this.localRole(),
      me:{role:player_me.onlineRole, faction:player_me.deck?.faction},
      op:{role:player_op.onlineRole, faction:player_op.deck?.faction}
    });
    // Player(mode=4) constructs HandAI for the opponent. Replace it before
    // startGame draws any cards so the hidden remote hand sorts exactly like
    // the peer's visible Hand. Otherwise synchronized mulligan indices refer
    // to different cards and permanently diverge the two simulations.
    player_op.hand = new HandRemoteV5(player_op.tag);
    player_op.hand.player = player_op;
    this.rngScope = null;
    player_op.ai = new ControllerAI(player_op);
    player_op.controller = new ControllerRemoteV5(player_op);
    // Use v5's native class-based screen transition.  returnToCustomization()
    // removes this same class; an inline display:none would otherwise survive
    // the Customize button and leave the board visible forever.
    const deckCustomization = document.getElementById("deck-customization");
    if (deckCustomization) {
      deckCustomization.style.display = "";
      deckCustomization.classList.add("hide");
    }
    game.endScreen?.classList.add("hide");
    const lobby = document.getElementById("online-lobby"); if (lobby) lobby.classList.add("hide");
    try { openFullscreen(); } catch (_) {}
    await game.startGame();
  },

  async withDecisionOwner(player, fn, context = null) {
    const scopeMatch = this._matchAbort;
    const scopeTurn = this._decisionTurn;
    const prevOwner = this._decisionOwner;
    const prevContext = this._effectContext;
    const prevEffectDecisionSerial = this._effectDecisionSerial;
    // Scope the RNG to the effect owner so each player's delayed effects
    // (roundStart/roundEnd/turnStart/turnEnd) consume an independent RNG
    // stream. The shared gameRng would otherwise diverge when asynchronous
    // effect bodies (notifications, animations) interleave differently on
    // the two peers, causing randomized effects such as Skellige's round-3
    // graveyard revive to select different cards and desync at the round-phase
    // barrier. deckRng is already per-role and seed-stable across browsers.
    const prevRngScope = this.rngScope;
    const ownerRole = player ? this.roleOfPlayer(player) : null;
    if (ownerRole) this.rngScope = ownerRole;
    this._decisionOwner = player || prevOwner || null;
    // Decision ids inside a delayed/owned effect must be deterministic on both
    // peers. A match-global serial is unsafe because local-only UI interactions
    // (mulligan, notifications, suppressed popups, etc.) may legitimately
    // advance it by different amounts on the two browsers.
    if (context && context !== prevContext) {
      this._effectContext = context;
      this._effectDecisionSerial = 0;
    } else if (context) {
      this._effectContext = context;
    }
    try { return await fn(); }
    finally {
      if (this._matchAbort === scopeMatch && this._decisionTurn === scopeTurn) {
        this._decisionOwner = prevOwner;
        this._effectContext = prevContext;
        this._effectDecisionSerial = prevEffectDecisionSerial;
        this.rngScope = prevRngScope;
      }
    }
  },

  decisionOwner() {
    return this._decisionOwner || game.currPlayer;
  },

  beginTurnDecisions() {
    // Leader/faction actions await endTurn(), which in turn awaits startTurn().
    // Their old owner scopes are therefore still on the stack at handoff.
    // Expire them before the new turn's effects/input; their finally blocks
    // must not restore a previous turn's owner or decision context afterward.
    this._decisionTurn = {};
    this._decisionOwner = null;
    this._effectContext = null;
    this._effectDecisionSerial = 0;
  },

  beginDecision(kind, chooser = null) {
    const owner = chooser || this.decisionOwner();
    const role = this.roleOfPlayer(owner) || "none";
    const context = this._effectContext || "turn";
    const serial = this._effectContext ? this._effectDecisionSerial++ : this._decisionSerial++;
    // Keep the human-readable context before the local ordinal so traces make
    // it obvious when two peers disagree about the same logical decision.
    const id = `${Number(game?.roundCount)||0}:${this._turnSeq}:${role}:${context}:${kind}:${serial}`;
    return {id, role, kind, context, serial};
  },

  bindNewGameHooks(owner, before, label) {
    const names = ['gameStart','roundStart','roundEnd','turnStart','turnEnd','unitDestroyed'];
    for (const name of names) {
      const arr = game?.[name];
      if (!Array.isArray(arr)) continue;
      const start = Number(before?.[name] ?? arr.length);
      for (let i=start; i<arr.length; i++) {
        const fn = arr[i];
        if (typeof fn !== 'function' || fn.__onlineOwnerWrapped) continue;
        const self = this;
        const wrapped = async (...args) => self.withDecisionOwner(owner, () => fn(...args), `${label}:${name}`);
        wrapped.__onlineOwnerWrapped = true;
        wrapped.__onlineOwnerRole = self.roleOfPlayer(owner) || null;
        wrapped.__onlineEffectContext = `${label}:${name}`;
        arr[i] = wrapped;
      }
    }
  },

  async withOwnedEffects(owner, context, fn) {
    const names = ['gameStart','roundStart','roundEnd','turnStart','turnEnd','unitDestroyed'];
    const before = Object.fromEntries(names.map(n => [n, Array.isArray(game?.[n]) ? game[n].length : 0]));
    const result = await this.withDecisionOwner(owner, fn, context);
    this.bindNewGameHooks(owner, before, context);
    return result;
  },

  cardLocator(card) {
    if (!card) return null;
    for (const role of ["host","guest"]) {
      const pl = this.playerOf(role);
      if (!pl) continue;
      for (const zone of ["hand","deck","grave"]) {
        const c = pl[zone];
        if (c?.cards?.includes(card))
          return {kind:"zone", role, zone, card:this.containerCardRef(c, card)};
      }
      if (pl.leader === card) return {kind:"leader", role, key:card.key};
    }
    if (weather?.cards?.includes(card))
      return {kind:"weather", card:this.containerCardRef(weather, card)};
    for (const row of (board?.row || [])) {
      if (row?.cards?.includes(card))
        return {kind:"row", row:this.destToWire(row), card:this.containerCardRef(row, card)};
      if (row?.special?.cards?.includes(card))
        return {kind:"row-special", row:this.destToWire(row), card:this.containerCardRef(row.special, card)};
    }
    return {kind:"virtual", key:card.key || null};
  },

  resolveCardLocator(locator, fallbackContainer = null) {
    if (!locator) return null;
    let container = null, card = null;
    if (locator.kind === "zone") {
      const pl = this.playerOf(locator.role);
      container = pl?.[locator.zone] || null;
      card = container ? this.containerCardFromRef(container, locator.card) : null;
      // Private zones are authoritative on their owner's browser. If the peer's
      // hidden replica is stale, recover the exact keyed card from another
      // private zone (including the opposite player's private zones) instead of
      // aborting a valid public match. Public board cards are never repaired.
      if (!card && container && locator.card?.key) {
        const key = locator.card.key;
        const privateContainers = [];
        for (const role of ["host","guest"]) {
          const p = this.playerOf(role);
          if (p) for (const z of ["hand","deck","grave"]) if (p[z]) privateContainers.push(p[z]);
        }
        let source = null;
        for (const c of privateContainers) {
          const found = c.cards?.find(x => x.key === key);
          if (found) { card = found; source = c; break; }
        }
        if (card && source !== container) {
          const idx = source.cards.indexOf(card);
          if (idx >= 0) source.cards.splice(idx,1);
          container.cards.push(card);
          card.holder = pl; card.currentLocation = container;
          source.resize?.(); container.resize?.();
          this.trace('sync:private-card-relocated', {actor:locator.role, card:key});
        }
        if (!card && card_dict?.[key]) {
          card = new Card(key, card_dict[key], pl);
          card.holder = pl; card.currentLocation = container;
          container.cards.push(card); container.resize?.();
          this.trace('sync:private-card-rehydrated', {actor:locator.role, card:key});
        }
      }
    } else if (locator.kind === "leader") {
      const pl = this.playerOf(locator.role);
      card = pl?.leader?.key === locator.key ? pl.leader : null;
      container = card ? {cards:[card]} : null;
    } else if (locator.kind === "weather") {
      container = weather; card = this.containerCardFromRef(container, locator.card);
    } else if (locator.kind === "row" || locator.kind === "row-special") {
      const row = this.destFromWire(locator.row);
      container = locator.kind === "row-special" ? row?.special : row;
      card = container ? this.containerCardFromRef(container, locator.card) : null;
    } else if (locator.kind === "virtual") {
      container = fallbackContainer;
      if (container && locator.card) card = this.containerCardFromRef(container, locator.card);
      if (container?.cards && locator.key) {
        const matches = container.cards.filter(c => c.key === locator.key);
        if (!card && matches.length === 1) card = matches[0];
      }
    }
    if (!card && fallbackContainer?.cards && locator.key) {
      const matches = fallbackContainer.cards.filter(c => c.key === locator.key);
      if (matches.length === 1) { card = matches[0]; container = fallbackContainer; }
    }
    if (!card) return null;
    if (!container?.cards?.includes(card)) container = {cards:[card]};
    return {card, container, index:container.cards.indexOf(card)};
  },

  patchRuntime() {
    if (this._patched) return; this._patched = true;
    const self = this;

    // Online is semantically PvP for row ownership, abilities and faction logic,
    // but unlike hotseat only the local browser may accept input.
    const oldIsPvP = Game.prototype.isPvP;
    Game.prototype.isPvP = function() { return self.active ? true : oldIsPvP.call(this); };
    const oldEnablePlayer = UI.prototype.enablePlayer;
    UI.prototype.enablePlayer = function(enable) {
      if (!self.active) return oldEnablePlayer.call(this, enable);
      const owner = self.decisionOwner();
      // The end screen lives inside main too. Once the match is over its
      // Replay/Customize controls belong to both clients, regardless of the
      // final action's owner. Late action cleanup must not lock them again.
      if (game.over) enable = true;
      else if (enable && owner && self.isRemote(owner)) enable = false;
      const main = document.getElementsByTagName('main')[0]?.classList;
      if (main) enable ? main.remove('noclick') : main.add('noclick');
    };

    // Bind card-triggered UI decisions to the card owner for the whole async
    // placed-effect chain. This covers spies, medics, wishes, weather specials,
    // random target picks and any future ability implemented through Row/Weather.
    const oldRowAddCard = Row.prototype.addCard;
    Row.prototype.addCard = async function(card, ...args) {
      if (!self.active || !card?.holder) return oldRowAddCard.call(this, card, ...args);
      return self.withOwnedEffects(card.holder, `card:${card.key}:placed`, () => oldRowAddCard.call(this, card, ...args));
    };
    const oldWeatherAddCard = Weather.prototype.addCard;
    Weather.prototype.addCard = async function(card, ...args) {
      if (!self.active || !card?.holder) return oldWeatherAddCard.call(this, card, ...args);
      return self.withOwnedEffects(card.holder, `card:${card.key}:weather`, () => oldWeatherAddCard.call(this, card, ...args));
    };

    const oldPlayCardAction = Player.prototype.playCardAction;
    Player.prototype.playCardAction = async function(card, action, endTurn=true) {
      if (!self.active) return oldPlayCardAction.call(this, card, action, endTurn);
      return self.withOwnedEffects(this, `card:${card?.key || 'unknown'}:action`, () => oldPlayCardAction.call(this, card, action, endTurn));
    };

    // Leaving a finished online match for the deck builder must switch the
    // runtime back out of online-PvP mode. Keep the room connection itself so
    // both players may customize and Ready again without exchanging a new code.
    const oldReturnToCustomization = Game.prototype.returnToCustomization;
    Game.prototype.returnToCustomization = function() {
      if (!self.active) return oldReturnToCustomization.call(this);

      try { self.send({t:'lobby-customizing'}); }
      catch (e) { console.warn('[Gwent Online] could not send customizing state', e); }

      self.active = false;
      self.localReady = false;
      self.remoteReady = false;
      self.remoteDeck = null;
      self._pendingStart = null;
      self._forfeitEnding = false;
      self._sendingSuppressed = false;
      self.rngScope = null;
      self.gameRng = null;
      self.deckRng = {host:null, guest:null};
      self._openingRole = null;
      self.queue = [];
      const pendingWaiters = self.waiters.splice(0);
      for (const waiter of pendingWaiters) {
        try { waiter.resolve(null); } catch (_) {}
      }

      const deckCustomization = document.getElementById('deck-customization');
      if (deckCustomization) deckCustomization.style.display = '';
      document.getElementsByTagName('main')[0]?.classList.remove('noclick');

      const result = oldReturnToCustomization.call(this);
      self.updateReadyUI();
      self.updateLobby('Customize your deck. When ready, use Start game — the room stays connected.', OnlineNet.code);
      console.log('[Gwent Online] returned to customization', {room:OnlineNet.code, role:OnlineNet.role});
      return result;
    };

    // Never use v5's local Replay path for an online match. A local restart
    // would let each browser choose/reuse turn state independently. Instead,
    // Replay is a mutual ready-up: once both players request it, the host sends
    // a fresh seed through the normal lobby-start handshake and startMatch()
    // rebuilds both Player objects from the same decks.
    const oldRestartGame = Game.prototype.restartGame;
    Game.prototype.restartGame = function() {
      if (!self.active) return oldRestartGame.call(this);
      if (!this.over) return;
      if (self.localReady) self.unready();
      else self.ready();
      self.updateRematchUI();
    };

    const oldEndGame = Game.prototype.endGame;
    Game.prototype.endGame = async function() {
      const result = await oldEndGame.call(this);
      if (self.active) {
        // Ready flags should already be false from startMatch(), but enforce it
        // here so a completed match never inherits lobby state.
        self.localReady = false;
        self.remoteReady = false;
        self.remoteDeck = null;
        self._pendingStart = null;
        self.updateReadyUI();
        self.updateRematchUI();
      }
      return result;
    };

    // Register leader/faction effects in HOST->GUEST order on both clients and
    // permanently bind every delayed effect to the player that owns it. v5's
    // stock callbacks often call popup()/queueCarousel() later at round/turn
    // boundaries; using game.currPlayer there gives the choice to the wrong
    // human whenever the effect owner is not the round starter.
    const oldInitPlayers = Game.prototype.initPlayers;
    Game.prototype.initPlayers = function(p1, p2) {
      if (!self.active) return oldInitPlayers.call(this, p1, p2);
      if (self.roleOfPlayer(p1) !== 'host') [p1, p2] = [p2, p1];
      const hookNames = ['gameStart','roundStart','roundEnd','turnStart','turnEnd','unitDestroyed'];
      const wrapNewHooks = (player, before, label) => {
        for (const name of hookNames) {
          const arr = this[name];
          if (!Array.isArray(arr)) continue;
          for (let i=before[name]; i<arr.length; i++) {
            const fn = arr[i];
            if (typeof fn !== 'function' || fn.__onlineOwnerWrapped) continue;
            const wrapped = async (...args) => self.withDecisionOwner(player, () => fn(...args), `${label}:${name}`);
            wrapped.__onlineOwnerWrapped = true;
            wrapped.__onlineOwnerRole = self.roleOfPlayer(player) || null;
            wrapped.__onlineEffectContext = `${label}:${name}`;
            arr[i] = wrapped;
          }
        }
      };
      const initOne = (player) => {
        const leaderDef = ability_dict[player.leader.abilities[0]];
        const beforeLeader = Object.fromEntries(hookNames.map(n => [n, (this[n]||[]).length]));
        if (leaderDef?.placed) self.withDecisionOwner(player, () => leaderDef.placed(player.leader), `leader:${player.leader.key}:placed`);
        if (leaderDef) for (const key of Object.keys(leaderDef)) {
          if (Array.isArray(this[key]) && typeof leaderDef[key] === 'function') this[key].push(leaderDef[key]);
        }
        wrapNewHooks(player, beforeLeader, `leader:${player.leader.key}`);

        const faction = factions[player.deck.faction];
        if (faction?.factionAbility && !faction.activeAbility) {
          const beforeFaction = Object.fromEntries(hookNames.map(n => [n, (this[n]||[]).length]));
          // Passive faction registrations are synchronous in v5. Delayed
          // callbacks appended by them are wrapped immediately below.
          faction.factionAbility(player);
          wrapNewHooks(player, beforeFaction, `faction:${player.deck.faction}`);
        }
      };
      const bothScoiatael = p1.deck.faction === p2.deck.faction && p1.deck.faction === 'scoiatael';
      if (bothScoiatael) {
        // Preserve v5's special mirror-match rule: leaders initialize, faction
        // first-player hooks do not.
        const initLeaderOnly = (player) => {
          const leaderDef = ability_dict[player.leader.abilities[0]];
          const before = Object.fromEntries(hookNames.map(n => [n, (this[n]||[]).length]));
          if (leaderDef?.placed) self.withDecisionOwner(player, () => leaderDef.placed(player.leader), `leader:${player.leader.key}:placed`);
          if (leaderDef) for (const key of Object.keys(leaderDef)) if (Array.isArray(this[key]) && typeof leaderDef[key] === 'function') this[key].push(leaderDef[key]);
          wrapNewHooks(player, before, `leader:${player.leader.key}`);
        };
        initLeaderOnly(p1); initLeaderOnly(p2);
      } else {
        initOne(p1); initOne(p2);
      }
      return {meve_white_queen: [p1,p2].some(p => ability_dict[p.leader.abilities[0]] === ability_dict['meve_white_queen'])};
    };

    // Keep each role's deck RNG independent, even though local/remote player ids are reversed across browsers.
    const oldInit = Deck.prototype.initialize;
    Deck.prototype.initialize = function(list, player) {
      if (!self.active) return oldInit.call(this, list, player);
      const prev = self.rngScope; self.rngScope = self.roleOfId(player.id);
      try { return oldInit.call(this, list, player); } finally { self.rngScope = prev; }
    };
    const oldDeckAdd = Deck.prototype.addCard;
    Deck.prototype.addCard = function(card) {
      if (!self.active) return oldDeckAdd.call(this, card);
      const prev = self.rngScope; self.rngScope = self.roleOfId(this.player?.id ?? card?.holder?.id ?? 0);
      try { return oldDeckAdd.call(this, card); } finally { self.rngScope = prev; }
    };

    // Online opening mulligan is a state barrier, not a replay-by-index protocol.
    // Each browser performs only its own redraw locally, then sends the exact
    // resulting hand+deck order to the peer. This makes simultaneous redraw
    // deterministic even if v5 changes sorting, RNG consumption, or leader logic.
    Game.prototype.initialRedraw = async function() {
      if (!self.active) return self._originalInitialRedraw.call(this);
      const nov = p => p.deck.faction === "novigrad" ? 1 : 0;
      const localRole = self.localRole();
      const remoteRole = self.otherRole(localRole);
      const localPlayer = self.playerOf(localRole);
      const remotePlayer = self.playerOf(remoteRole);
      if (!localPlayer || !remotePlayer) return self.desync("Mulligan player mapping is incomplete");
      if (self.roleOfPlayer(localPlayer) !== localRole || self.roleOfPlayer(remotePlayer) !== remoteRole)
        return self.desync("Mulligan player role mapping mismatch");

      const localCount = localPlayer.mulliganCount + nov(localPlayer);
      const token = self._matchToken;
      self.trace('mulligan:barrier-open', {actor:localRole, remote:remoteRole, count:localCount, token});

      let remoteDone = false;
      // Receive the peer snapshot concurrently, but defer *applying* it until
      // our own carousel has finished. Private-zone reconciliation rebuilds card
      // arrays/DOM and must never run while a local opening selection is active.
      const remoteTask = self.nextMatching(["mulligan-state"], m =>
        m && m.role === remoteRole && (!m.matchToken || m.matchToken === token)
      ).then(m => {
        if (!m) return null;
        remoteDone = true;
        self.trace('mulligan:remote-received', {actor:remoteRole, token});
        return m;
      });

      // Both browsers enter their own local carousel immediately. Neither side
      // waits for the peer before the local human can choose cards.
      await self.localMulligan(localPlayer, localRole, localCount);
      self.send({t:"mulligan-state", role:localRole, matchToken:token, state:self.zoneSnapshot(localPlayer)});
      self.trace('mulligan:local-state-sent', {actor:localRole, token});
      ui.enablePlayer(false);
      if (!remoteDone) await self.showRedrawWait();
      const remoteMessage = await remoteTask;
      if (!remoteMessage) return self.desync("Missing remote mulligan state");
      const ok = self.reconcilePrivateZones(remotePlayer, remoteMessage.state, "post-mulligan");
      if (!ok) return;
      self.trace('mulligan:remote-done', {actor:remoteRole, token});
      await self.hideRedrawWait();
      ui.enablePlayer(false);
      self.trace('mulligan:barrier-complete', {actor:localRole, token});
      await game.startRound();
    };

    // IMPORTANT: player_me/player_op are local-perspective identities and are
    // reversed on the two browsers. A shared random boolean must therefore
    // choose HOST/GUEST, not player_me/player_op, or both clients can believe
    // that the opponent starts.
    const oldCoinToss = Game.prototype.coinToss;
    Game.prototype.coinToss = async function() {
      if (!self.active) return oldCoinToss.call(this);
      if (this.firstPlayer) return this.firstPlayer;
      const firstRole = self._openingRole;
      if (firstRole !== "host" && firstRole !== "guest")
        return self.desync("Opening-player role missing at coin toss");
      this.firstPlayer = self.playerOf(firstRole);
      try { tocar("coin", false); } catch (_) {}
      await ui.notification(this.firstPlayer.tag + "-coin", 1200);
      console.log("[Gwent Online] authoritative first player", { firstRole, localRole:self.localRole(), localStarts:this.firstPlayer === player_me });
      return this.firstPlayer;
    };

    // v1.3.5: fully serialize and trace lifecycle effects. Round boundaries
    // get an explicit peer barrier so one browser can never silently enter the
    // next turn while the other is still resolving round-end/start effects.
    const oldRunEffects = Game.prototype.runEffects;
    Game.prototype.runEffects = async function(effects) {
      if (!self.active) return oldRunEffects.call(this, effects);
      const phase = effects === this.roundEnd ? 'end-effects' : effects === this.roundStart ? 'start-effects' : null;
      if (phase) self.trace(`round:${phase}:enter`, {actor:self.roleOfPlayer(this.currPlayer)});
      for (let i = effects.length - 1; i >= 0; --i) {
        const effect = effects[i];
        const context = effect?.__onlineEffectContext || `effect-${i}`;
        const owner = effect?.__onlineOwnerRole || self.roleOfPlayer(self.decisionOwner()) || null;
        if (phase) self.trace(`round:${phase}:effect-enter`, {actor:owner, err:context});
        let remove = false;
        try { remove = !!(await effect()); }
        catch (e) {
          console.error('[Gwent Online] lifecycle effect failed', {phase, context, owner, error:e});
          self.trace(`round:${phase || 'effect'}:effect-error`, {actor:owner, err:`${context}: ${e?.message || e}`});
          return self.desync(`Lifecycle effect failed (${context}): ${e?.message || e}`);
        }
        if (phase) self.trace(`round:${phase}:effect-done`, {actor:owner, err:context});
        if (remove) effects.splice(i, 1);
      }
      if (phase) {
        self.trace(`round:${phase}:effects-done`, {actor:self.roleOfPlayer(this.currPlayer)});
        const ok = await self.roundPhaseBarrier(phase);
        if (!ok) return;
      }
    };

    const oldStartTurn = Game.prototype.startTurn;
    Game.prototype.startTurn = async function(forcedRole = null) {
      if (!self.active) return oldStartTurn.call(this);
      self.beginTurnDecisions();
      self.trace("turn:start-enter", {next:forcedRole || null});
      await this.runEffects(this.turnStart);

      // At the opening of a round v5 intentionally seeds currPlayer to the
      // player *before* the real starter, so preserve the native relative
      // toggle when no role is supplied. At ordinary online turn boundaries,
      // however, the acting peer sends an authoritative next logical role.
      // Setting it explicitly prevents both clients from ever independently
      // toggling into "opponent's turn" after a complex action such as Spy -> Decoy.
      if (forcedRole === "host" || forcedRole === "guest") {
        const forced = self.playerOf(forcedRole);
        if (!forced) return self.desync("Could not resolve authoritative next player: " + forcedRole);
        this.currPlayer = forced;
        await ui.notification(this.currPlayer.tag + "-turn", 1200);
      } else if (!this.currPlayer.opponent().passed) {
        this.currPlayer = this.currPlayer.opponent();
        await ui.notification(this.currPlayer.tag + "-turn", 1200);
      }

      ui.enablePlayer(this.currPlayer === player_me);
      console.log("[Gwent Online] begin turn", {
        seq:self._turnSeq,
        role:self.roleOfPlayer(this.currPlayer),
        local:this.currPlayer === player_me,
        forcedRole:forcedRole || null
      });
      self.trace("turn:started", {actor:self.roleOfPlayer(this.currPlayer), next:forcedRole || null, local:this.currPlayer === player_me});
      // Deliberately do not await a remote human's think time here. The remote
      // controller owns that pending promise until its next network action.
      void this.currPlayer.startTurn();
    };

    // Turn barrier. The player who actually acted is authoritative for the
    // next logical role. This is stronger than having each browser call
    // opponent() independently and prevents a silent "both wait" deadlock.
    // Public gameplay state is still lockstep checked, while the actor remains
    // authoritative for its private hand/deck snapshot.
    const oldGameEndTurn = Game.prototype.endTurn;
    Game.prototype.endTurn = async function(noEffects=false) {
      if (!self.active) return oldGameEndTurn.call(this, noEffects);
      if (this.over || self._matchAbort?.signal.aborted) return;
      if (this.currPlayer === player_me) ui.enablePlayer(false);
      if (this.currPlayer?.passed) noEffects = true;
      if (!noEffects) await this.runEffects(this.turnEnd);
      if (this.over || self._matchAbort?.signal.aborted) return;
      if (!this.currPlayer.passed && !this.currPlayer.canPlay()) {
        this.currPlayer.setPassed(true);
        ui.notification('op-pass', 1200);
      }
      if (this.currPlayer.endturn_action) {
        await this.currPlayer.endturn_action();
        return;
      }
      if (this.currPlayer.passed) await ui.notification(this.currPlayer.tag + '-pass', 1200);
      board.updateScores();

      const actor = this.currPlayer;
      const actorRole = self.roleOfPlayer(actor);
      const localActed = actor === player_me;
      const bothPassed = !!(player_op.passed && player_me.passed);
      const computedNextRole = bothPassed
        ? null
        : self.roleOfPlayer(actor.opponent().passed ? actor : actor.opponent());
      let nextRole = computedNextRole;

      console.log('[Gwent Online] turn barrier enter', {
        seq:self._turnSeq, actorRole, localActed, computedNextRole, bothPassed
      });
      self.trace('turn:barrier-enter', {actor:actorRole, next:computedNextRole, localActed:!!localActed});

      if (localActed) {
        const syncState = self.syncState();
        const syncHash = self.hashState(syncState);
        const auditState = self.logicalState();
        const auditHash = self.hashState(auditState);
        self.trace('turn:send-state', {actor:actorRole, next:nextRole});
        self.send({
          t:'turn-state',
          seq:self._turnSeq,
          h:syncHash,
          state:syncState,
          actorRole,
          nextRole,
          actorState:self.zoneSnapshot(player_me),
          auditH:auditHash,
          audit:auditState
        });
      } else {
        let m;
        try {
          m = await self.nextWithTimeout('turn-state', 12000,
            `Timed out waiting for turn-state after ${actorRole} action (seq ${self._turnSeq})`);
        } catch (e) {
          console.error('[Gwent Online] turn-state timeout', {seq:self._turnSeq, actorRole, queue:self.queue, error:e});
          return self.desync(e.message || String(e));
        }
        if (!m) return self.desync('Missing turn-state message');
        self.trace('turn:recv-state', {actor:m?.actorRole || actorRole, next:m?.nextRole || null});
        if (Number(m.seq) !== self._turnSeq)
          return self.desync(`Turn sequence mismatch: local=${self._turnSeq} remote=${m.seq}`);

        const expectedActorRole = actorRole;
        const remoteActorRole = m.actorRole || expectedActorRole;
        if (remoteActorRole !== expectedActorRole)
          return self.desync(`Turn-state actor mismatch: expected=${expectedActorRole} remote=${remoteActorRole}`);
        if (m.nextRole !== null && m.nextRole !== 'host' && m.nextRole !== 'guest')
          return self.desync('Invalid authoritative next player: ' + JSON.stringify(m.nextRole));
        if (m.nextRole !== computedNextRole) {
          console.warn('[Gwent Online] local next-role calculation differed; using actor authority', {
            seq:self._turnSeq, local:computedNextRole, remote:m.nextRole, actorRole
          });
        }
        nextRole = m.nextRole;

        const remoteActor = self.playerOf(remoteActorRole);
        if (m.actorState && remoteActor && remoteActor !== player_me) {
          if (!self.reconcilePrivateZones(remoteActor, m.actorState, 'post-action')) return;
        }

        let syncState = self.syncState();
        let syncHash = self.hashState(syncState);

        // Some v5 abilities launch their final board move/animation without
        // awaiting the last DOM/container mutation. The actor can therefore
        // reach endTurn a few frames before the replaying peer. Do not kill a
        // valid match on that transient 0-vs-1 row-card window: give the peer
        // a short chance to settle to the actor's authoritative PUBLIC state.
        if (m.h !== syncHash) {
          const firstDiff = self.firstStateDifference(syncState, m.state);
          console.warn('[Gwent Online] public state not settled yet; waiting briefly', {
            seq:self._turnSeq, firstDiff, local:syncState, remote:m.state
          });
          self.trace('sync:settle-wait', {actor:remoteActorRole, next:nextRole, err:firstDiff?.path || 'hash'});
          const deadline = Date.now() + 2200;
          while (m.h !== syncHash && Date.now() < deadline) {
            await sleep(80);
            try { board.updateScores(); } catch (_) {}
            syncState = self.syncState();
            syncHash = self.hashState(syncState);
          }
          if (m.h === syncHash) self.trace('sync:settle-ok', {actor:remoteActorRole, next:nextRole});
        }

        const auditState = self.logicalState();
        const auditHash = self.hashState(auditState);
        if (m.h !== syncHash) {
          const diff = self.firstStateDifference(syncState, m.state);
          const detail = diff ? `${diff.path}: local=${self.shortValue(diff.local)} remote=${self.shortValue(diff.remote)}` : `local=${syncHash} remote=${m.h || 'missing'}`;
          console.error('[Gwent Online] blocking sync mismatch after settle window', {detail, local:syncState, remote:m.state, message:m});
          return self.desync(`Turn-state mismatch at ${detail}`);
        }
        if (m.auditH && m.auditH !== auditHash) {
          const diff = self.firstStateDifference(auditState, m.audit);
          self.lastAuditWarning = {turn:game.roundCount, diff, local:auditState, remote:m.audit, localHash:auditHash, remoteHash:m.auditH};
          console.warn('[Gwent Online] non-blocking full-state audit difference', self.lastAuditWarning);
        } else {
          self.lastAuditWarning = null;
        }
      }

      console.log('[Gwent Online] turn committed', {
        seq:self._turnSeq, actorRole, nextRole, localRole:self.localRole(), bothPassed
      });
      self.trace('turn:committed', {actor:actorRole, next:nextRole});
      self._turnSeq++;
      if (bothPassed) await this.endRound();
      else await this.startTurn(nextRole);
    };

    // v5's Player.endTurn starts Game.endTurn without awaiting it. Online,
    // awaiting is required so action replay cannot overlap the next message.
    const oldPlayerEndTurn = Player.prototype.endTurn;
    Player.prototype.endTurn = async function(noEffects=false) {
      if (!self.active) return oldPlayerEndTurn.call(this, noEffects);
      if (this.endturn_action) { await this.endturn_action(); return; }
      if (this === player_me) { document.getElementById('pass-button')?.classList.add('noclick'); may_pass1 = false; }
      document.getElementById('stats-' + this.tag)?.classList.remove('current-turn');
      this.elem_leader?.children?.[1]?.classList.add('hide');
      return await game.endTurn(noEffects);
    };

    // v0.5: v5 only auto-runs startTurn() for ControllerAI.  A remote
    // controller deliberately is NOT an AI (many abilities branch on that),
    // so explicitly start its network turn here without opening local human UI.
    const oldPlayerStartTurn = Player.prototype.startTurn;
    Player.prototype.startTurn = async function() {
      if (!self.active) return oldPlayerStartTurn.call(this);
      if (!(this.controller instanceof ControllerRemoteV5)) {
        self._suppressPopupWire = true;
        try { return await oldPlayerStartTurn.call(this); } finally { self._suppressPopupWire = false; }
      }

      document.getElementById("stats-" + this.tag)?.classList.add("current-turn");
      if (this.leaderAvailable && this.elem_leader?.children?.[1])
        this.elem_leader.children[1].classList.remove("hide");

      console.log("[Gwent Online] waiting for remote action", {role:self.roleOfPlayer(this), round:game.roundCount});
      return await this.controller.startTurn(this);
    };

    // v1.3.9 continuation audit.  A card chosen by an ability and then placed
    // on a row is ONE logical decision chain.  The chooser is the current
    // decision owner (leader/faction/card owner), which can be different from
    // the holder of the card being placed (Emhyr Invader is the key example).
    // Keep the parent action pending until the destination has committed on
    // both peers; otherwise the remote controller can finish the leader action
    // and treat the continuation as a second top-level turn action.
    const oldSelectCardDestination = Player.prototype.selectCardDestination;
    Player.prototype.selectCardDestination = async function(card, src=null, callback=null) {
      if (!self.active) return await oldSelectCardDestination.call(this, card, src, callback);
      const chooser = self.decisionOwner() || this;
      const decision = self.beginDecision('destination', chooser);
      self.trace('decision:destination-open', {actor:decision.role, card:card?.key || null, err:decision.id});

      if (self.isRemote(chooser)) {
        if (src) src.removeCard(card);
        this.hand.addCard(card);
        let completed = false;
        this.endturn_action = async () => {
          this.endturn_action = null;
          if (callback) await callback();
          completed = true;
        };
        let m;
        try {
          m = await self.nextMatchingWithTimeout('destination', x => x.decision === decision.id, 30000,
            `Timed out waiting for continuation destination (${decision.id})`);
        } catch (e) {
          self.trace('decision:destination-timeout', {actor:decision.role, card:card?.key || null, err:decision.id});
          return self.desync(e.message || String(e));
        }
        const row = self.destFromWire(m.d);
        if (!row) return self.desync('Invalid continuation destination: ' + JSON.stringify(m.d));
        self.trace('decision:destination-recv', {actor:decision.role, card:card?.key || null, err:decision.id});
        self._sendingSuppressed = true;
        try {
          ui.previewCard = card;
          ui.lastRow = row;
          await UI.prototype.selectRow.call(ui, row, !!m.special);
        } finally { self._sendingSuppressed = false; }
        if (!completed && this.endturn_action) await this.endturn_action();
        self.trace('decision:destination-commit', {actor:decision.role, card:card?.key || null, err:decision.id});
        return;
      }

      if (chooser === player_me) {
        const prevMode = game.mode;
        // Stock v5 only recognizes mode=3 as PvP when deciding which half of
        // the board belongs to a card holder.  Online mode is 4, so an ability
        // that temporarily places an opponent-owned card (Emhyr) needs PvP
        // targeting semantics while the continuation UI is open.
        game.mode = 3;
        let resolveDone;
        const done = new Promise(resolve => { resolveDone = resolve; });
        const wrappedCallback = async () => {
          try { if (callback) await callback(); }
          finally { resolveDone(); }
        };
        self._continuationCard = card;
        self._continuationDecision = decision.id;
        self._continuationChooser = chooser;
        try {
          oldSelectCardDestination.call(this, card, src, wrappedCallback);
          await self.waitBoardInteraction(done);
          self.trace('decision:destination-commit', {actor:decision.role, card:card?.key || null, err:decision.id});
        } finally {
          if (self._continuationCard === card) self._continuationCard = null;
          if (self._continuationDecision === decision.id) self._continuationDecision = null;
          self._continuationChooser = null;
          game.mode = prevMode;
        }
        return;
      }

      return await oldSelectCardDestination.call(this, card, src, callback);
    };

    // Synchronize generic yes/no popups. This covers a large class of v5
    // abilities whose human branch otherwise opens independently on both PCs.
    const oldPopup = UI.prototype.popup;
    UI.prototype.popup = async function(yesName, yes, noName, no, title, description) {
      if (!self.active) return oldPopup.call(this, yesName, yes, noName, no, title, description);
      if (self._suppressPopupWire) {
        self._suppressPopupWire = false;
        return oldPopup.call(this, yesName, yes, noName, no, title, description);
      }
      const chooser = self.decisionOwner();
      const decision = self.beginDecision('popup', chooser);
      if (self.isRemote(chooser)) {
        self.trace('decision:popup-wait', {actor:decision.role, err:decision.id});
        let m;
        try {
          m = await self.nextMatchingWithTimeout('popup-choice', x => x.decision === decision.id, 30000, `Timed out waiting for popup choice (${decision.id})`);
        } catch (e) {
          self.trace('decision:popup-timeout', {actor:decision.role, err:decision.id});
          return self.desync(e.message);
        }
        self.trace('decision:popup-recv', {actor:decision.role, err:decision.id});
        const fake = {choice:null};
        const fn = m.yes ? yes : no;
        if (typeof fn === 'function') { const r = fn(fake); if (r && typeof r.then === 'function') await r; }
        return fake.choice;
      }
      if (chooser === player_me) {
        const y = async p => { self.trace('decision:popup-send', {actor:decision.role, err:decision.id + ':yes'}); self.send({t:'popup-choice', decision:decision.id, yes:true}); return yes && yes(p); };
        const n = async p => { self.trace('decision:popup-send', {actor:decision.role, err:decision.id + ':no'}); self.send({t:'popup-choice', decision:decision.id, yes:false}); return no && no(p); };
        return oldPopup.call(this, yesName, y, noName, n, title, description);
      }
      return oldPopup.call(this, yesName, yes, noName, no, title, description);
    };

    const oldNumberPopup = UI.prototype.numberPopup;
    UI.prototype.numberPopup = async function(v, min, max, callback, title, description) {
      if (!self.active) return oldNumberPopup.call(this, v, min, max, callback, title, description);
      const chooser = self.decisionOwner();
      const decision = self.beginDecision('number', chooser);
      if (self.isRemote(chooser)) {
        const m = await self.nextMatchingWithTimeout('number-choice', x => x.decision === decision.id, 120000, 'Timed out waiting for number choice (' + decision.id + ')');
        const value = Number(m.value);
        if (!Number.isInteger(value) || value < min || value > max) return self.desync('Invalid number choice');
        if (callback) await callback({value});
        return value;
      }
      if (chooser === player_me) {
        const wrapped = popup => { self.send({t:'number-choice', decision:decision.id, value:Number(popup.value)}); return callback && callback(popup); };
        return oldNumberPopup.call(this, v, min, max, wrapped, title, description);
      }
      return oldNumberPopup.call(this, v, min, max, callback, title, description);
    };

    const oldDeckSorter = UI.prototype.startDeckSorter;
    UI.prototype.startDeckSorter = async function(cards, player, action, title, bottomAllowed=false) {
      if (!self.active) return oldDeckSorter.call(this, cards, player, action, title, bottomAllowed);
      const decision = self.beginDecision('deck-sort', player);
      if (self.isRemote(player)) {
        const m = await self.nextMatchingWithTimeout('deck-sort', x => x.decision === decision.id, 120000, 'Timed out waiting for deck sort (' + decision.id + ')');
        if (!Array.isArray(m.deck)) return self.desync('Invalid deck-sort payload');
        const pool = [...player.deck.cards];
        const byKey = new Map();
        for (const c of pool) { if (!byKey.has(c.key)) byKey.set(c.key, []); byKey.get(c.key).push(c); }
        const reordered = m.deck.map(k => { const a=byKey.get(k); return a&&a.length?a.shift():null; });
        if (reordered.some(c=>!c) || reordered.length !== pool.length) return self.desync('Deck-sort card mismatch');
        player.deck.cards = reordered; for (const c of reordered) c.currentLocation = player.deck;
        self.rebuildDeckVisuals(player.deck);
        return;
      }
      const r = await oldDeckSorter.call(this, cards, player, action, title, bottomAllowed);
      if (player === player_me) self.send({t:'deck-sort', decision:decision.id, deck:player.deck.cards.map(c=>c.key)});
      return r;
    };

    // v1.4.0: the decision owner chooses; the target's owner only identifies
    // the board side. Keep the effect pending until its final mutation commits.
    const oldEnableRearrangement = UI.prototype.enableBoardRearrangement;
    UI.prototype.enableBoardRearrangement = async function(player, moves) {
      if (!self.active) return oldEnableRearrangement.call(this, player, moves);
      const chooser = self.decisionOwner() || player;
      const decision = self.beginDecision('rearrange', chooser);
      const tx = {decision, chooser, player, busy:false};
      self._rearrangement = tx;
      const done = oldEnableRearrangement.call(this, player, moves);
      self.trace('decision:rearrange-open', {actor:decision.role, err:decision.id});
      try {
        if (self.isRemote(chooser)) {
          this.enablePlayer(false);
          while (self.active && this.underRearrangement) {
            const m = await self.nextMatchingWithTimeout(['rearrange-card','rearrange-row','rearrange-end'],
              x => x.decision === decision.id, 120000, 'Timed out waiting for rearrangement (' + decision.id + ')');
            if (m.t === 'rearrange-end') { await this.finishBoardRearrangement(); break; }
            if (m.t === 'rearrange-card') {
              const card = self.boardCardFromWire(m.ref);
              if (!card || !player.getAllRows().includes(card.currentLocation) || !(card.isUnit() || card.hero))
                throw new Error('Invalid rearrangement card');
              await oldSelectCard.call(this, card);
            } else {
              const row = self.destFromWire(m.d);
              if (!row || !player.getAllRows().includes(row) || !this.previewCard)
                throw new Error('Invalid rearrangement row');
              await oldSelectRow.call(this, row, false);
            }
          }
        }
        await self.waitBoardInteraction(done);
        self.trace('decision:rearrange-commit', {actor:decision.role, err:decision.id});
      } finally { if (self._rearrangement === tx) self._rearrangement = null; }
    };
    const oldFinishRearrangement = UI.prototype.finishBoardRearrangement;
    UI.prototype.finishBoardRearrangement = async function(manual=false) {
      const tx = self._rearrangement;
      if (self.active && manual && tx) {
        if (tx.chooser !== player_me || tx.busy) return;
        self.send({t:'rearrange-end', decision:tx.decision.id});
      }
      return oldFinishRearrangement.call(this, manual);
    };

    const oldAbilityTarget = UI.prototype.selectAbilityTarget;
    UI.prototype.selectAbilityTarget = async function(card, player) {
      if (!self.active) return oldAbilityTarget.call(this, card, player);
      const chooser = self.decisionOwner() || player;
      const decision = self.beginDecision('ability-target', chooser);
      const tx = {decision, chooser, card, busy:false};
      self._abilityTarget = tx;
      const done = oldAbilityTarget.call(this, card, player);
      let setupError, noTarget = false;
      done.then(result => { noTarget = result === false; }, e => { setupError = e; });
      await Promise.resolve();
      if (setupError) { self._abilityTarget = null; throw setupError; }
      if (noTarget) { self._abilityTarget = null; return false; }
      try {
        if (self.isRemote(chooser)) {
          this.enablePlayer(false);
          const m = await self.nextMatchingWithTimeout('ability-target', x => x.decision === decision.id,
            120000, 'Timed out waiting for ability target (' + decision.id + ')');
          if (m.ref) {
            const target = self.boardCardFromWire(m.ref);
            if (!target || !card.abilities.includes('alzur_maker') || !player.getAllRows().includes(target.currentLocation) || !target.isUnit())
              throw new Error('Invalid ability card target');
            await oldSelectCard.call(this, target);
          } else {
            const row = self.destFromWire(m.d);
            if (!row || card.abilities.includes('alzur_maker')) throw new Error('Invalid ability row target');
            await oldSelectRow.call(this, row, !!m.special);
          }
        }
        await self.waitBoardInteraction(done);
      } finally { if (self._abilityTarget === tx) self._abilityTarget = null; }
    };

    const oldEnablePowerEdit = UI.prototype.enableCardPowerEdit;
    UI.prototype.enableCardPowerEdit = async function(player, maxPower=999) {
      if (!self.active) return oldEnablePowerEdit.call(this, player, maxPower);
      const chooser = self.decisionOwner() || player;
      const decision = self.beginDecision('power-edit', chooser);
      const tx = {decision, chooser, player, busy:false};
      self._powerEdit = tx;
      const done = oldEnablePowerEdit.call(this, player, maxPower);
      try {
        if (self.isRemote(chooser) && this.underCardPowerEdit) {
          this.enablePlayer(false);
          const m = await self.nextMatchingWithTimeout('power-card', x => x.decision === decision.id,
            120000, 'Timed out waiting for power-edit target (' + decision.id + ')');
          const card = self.boardCardFromWire(m.ref);
          if (!card || !player.getAllRows().includes(card.currentLocation) || !(card.isUnit() || card.hero))
            throw new Error('Invalid power-edit card');
          await oldSelectCard.call(this, card);
        }
        await self.waitBoardInteraction(done);
      } finally { if (self._powerEdit === tx) self._powerEdit = null; }
    };

    // Local decision capture. selectRow is the common path for normal cards and most v5 specials.
    const oldSelectRow = UI.prototype.selectRow;
    UI.prototype.selectRow = async function(row, isSpecial=false) {
      const card = this.previewCard;
      const rearrange = self._rearrangement;
      if (self.active && rearrange && this.underRearrangement) {
        if (rearrange.chooser !== player_me || rearrange.busy || !card || !rearrange.player.getAllRows().includes(row)) return;
        rearrange.busy = true;
        try {
          self.send({t:'rearrange-row', decision:rearrange.decision.id, d:self.destToWire(row)});
          return await oldSelectRow.call(this, row, isSpecial);
        } finally { rearrange.busy = false; }
      }
      const target = self._abilityTarget;
      if (self.active && target) {
        if (target.chooser !== player_me || target.busy || card !== target.card || card.abilities.includes('alzur_maker')) return;
        target.busy = true;
        self.send({t:'ability-target', decision:target.decision.id, d:self.destToWire(row), special:!!isSpecial});
        return await oldSelectRow.call(this, row, isSpecial);
      }
      if (self.active && !self._sendingSuppressed && card && game.currPlayer === player_me) {
        // Continuations are owned by the chooser, not necessarily by the card
        // holder. Emhyr can make the local player place an opponent-owned card
        // on the opponent's side, so test this before the normal hand-play path.
        if (self._continuationCard === card && self._continuationDecision) {
          const continuationDecision = self._continuationDecision;
          self.trace('decision:destination-send', {actor:self.localRole(), card:card?.key || null, err:continuationDecision});
          self.send({t:"destination", decision:continuationDecision, d:self.destToWire(row), special:!!isSpecial});
        } else if (card.holder === player_me && player_me.hand.cards.includes(card)) {
          // Mirror v5's own selectRow() Decoy early-return BEFORE sending a
          // network action.  Previously the wrapper sent a generic `play`
          // first, then selectCard(target) sent the real `decoy`, leaving two
          // top-level actions with the same sequence number.  The remote
          // controller consumed the first one and never executed the swap.
          const decoyNeedsTarget = card.key === "spe_decoy" ||
            (card.abilities?.includes("decoy") && row?.cards?.some(c => c.isUnit()));
          if (decoyNeedsTarget) {
            self.trace("decoy:suppress-preliminary-play", {actor:self.localRole(), card:card.key});
          } else {
            self.send({t:"action", a:"play", card:self.cardToWire(card, player_me.hand), i:player_me.hand.cards.indexOf(card), d:self.destToWire(row), special:!!isSpecial, preState:self.zoneSnapshot(player_me)});
          }
        }
      }
      return oldSelectRow.call(this, row, isSpecial);
    };

    const oldSelectCard = UI.prototype.selectCard;
    UI.prototype.selectCard = async function(card) {
      const p = this.previewCard;
      const tx = self._rearrangement || self._powerEdit || self._abilityTarget;
      if (self.active && tx) {
        if (tx.chooser !== player_me || tx.busy || !board.row.includes(card?.currentLocation)) return;
        if (self._rearrangement) {
          if (!tx.player.getAllRows().includes(card.currentLocation) || !(card.isUnit() || card.hero)) return;
          self.send({t:'rearrange-card', decision:tx.decision.id, ref:self.boardCardToWire(card)});
        } else if (self._powerEdit) {
          if (!tx.player.getAllRows().includes(card.currentLocation) || !(card.isUnit() || card.hero)) return;
          tx.busy = true;
          self.send({t:'power-card', decision:tx.decision.id, ref:self.boardCardToWire(card)});
        } else {
          if (!tx.card.abilities.includes('alzur_maker') || !tx.card.holder.getAllRows().includes(card.currentLocation) || !card.isUnit()) return;
          tx.busy = true;
          self.send({t:'ability-target', decision:tx.decision.id, ref:self.boardCardToWire(card)});
        }
        return await oldSelectCard.call(this, card);
      }

      // Intercept Decoy completely in online mode. Calling the stock v5
      // selectCard here would start an un-awaited target move and race the turn
      // transition. Capture all wire references before mutating the containers,
      // then perform the same atomic transaction on both peers.
      if (self.active && !self._sendingSuppressed && p && p.holder === player_me &&
          p.abilities?.includes("decoy") && !player_me.hand.cards.includes(card) &&
          game.currPlayer === player_me) {
        const row = this.lastRow || card.currentLocation;
        const decoyRef = self.cardToWire(p, player_me.hand);
        const targetRef = self.containerCardRef(row, card);
        const decoyIndex = player_me.hand.cards.indexOf(p);
        const targetIndex = row?.cards?.indexOf(card);
        if (!row || !targetRef || decoyIndex < 0 || targetIndex < 0)
          return self.desync("Invalid local decoy target");

        self.trace("decoy:local-send", {actor:self.localRole(), card:p?.key || null, target:card?.key || null});
        self.send({
          t:"action", a:"decoy", card:decoyRef, i:decoyIndex,
          d:self.destToWire(row), target:targetRef, j:targetIndex,
          preState:self.zoneSnapshot(player_me)
        });
        this.hidePreview(card);
        this.enablePlayer(false);
        return await self.resolveDecoyAtomic(player_me, p, row, card);
      }
      return oldSelectCard.call(this, card);
    };

    const oldPass = Player.prototype.passRound;
    Player.prototype.passRound = async function() {
      if (self.active && !self._sendingSuppressed && this === player_me && game.currPlayer === player_me) self.send({t:"action", a:"pass", preState:self.zoneSnapshot(player_me)});
      return oldPass.call(this);
    };
    // v1.4.x: replaceLeader (used by Wild Hunt's round-start leader swap and
    // some ability continuations) runs the new leader's placed() handler, which
    // may push delayed lifecycle hooks (turnEnd/turnStart/...) onto the game
    // arrays. Those hooks must be wrapped in the owner's decision context,
    // exactly like the initial leader init at startGame, otherwise they run
    // with a null effect context. A null context makes their interactive
    // popups use the match-global decision serial, which diverges between the
    // two peers and eventually times out as "Timed out waiting for popup
    // choice (...:turn:popup:N)".
    const oldReplaceLeader = Player.prototype.replaceLeader;
    Player.prototype.replaceLeader = function(newLeader) {
      if (!self.active) return oldReplaceLeader.call(this, newLeader);
      const hookNames = ['gameStart','roundStart','roundEnd','turnStart','turnEnd','unitDestroyed'];
      const before = Object.fromEntries(hookNames.map(n => [n, Array.isArray(game?.[n]) ? game[n].length : 0]));
      const r = oldReplaceLeader.call(this, newLeader);
      self.bindNewGameHooks(this, before, `leader:${newLeader?.key || 'unknown'}:placed`);
      return r;
    };
    const oldLeader = Player.prototype.activateLeader;
    Player.prototype.activateLeader = async function(...args) {
      if (self.active && args[0] !== false && !self._sendingSuppressed && this === player_me && game.currPlayer === player_me) self.send({t:"action", a:"leader", preState:self.zoneSnapshot(player_me)});
      if (!self.active) return oldLeader.apply(this, args);
      return self.withDecisionOwner(this, () => oldLeader.apply(this, args), `leader:${this.leader?.key || 'unknown'}:activate`);
    };
    const oldActivateFaction = Player.prototype.activateFactionAbility;
    Player.prototype.activateFactionAbility = async function(...args) {
      if (!self.active) return oldActivateFaction.apply(this, args);
      return self.withDecisionOwner(this, async () => {
        // The "Use faction ability?" confirm popup is a local-only UI prompt;
        // it never carries a gameplay choice to replay on the peer. Always
        // suppress the synced popup-wire for it (regardless of which player
        // object triggers it) so it can never open a beginDecision that the
        // remote peer has no matching decision for and time out. The actual
        // faction ability runs through useFactionAbility(), whose own
        // withDecisionOwner scope ("faction:...:use") and any inner popups
        // remain fully synced because the suppress flag is consumed by the
        // confirm popup before the ability body runs.
        self._suppressPopupWire = true;
        try { return await oldActivateFaction.apply(this, args); } finally { self._suppressPopupWire = false; }
      }, `faction:${this.deck?.faction || 'unknown'}:activate`);
    };
    const oldFaction = Player.prototype.useFactionAbility;
    Player.prototype.useFactionAbility = async function(...args) {
      if (self.active && !self._sendingSuppressed && this === player_me && game.currPlayer === player_me) self.send({t:"action", a:"faction", preState:self.zoneSnapshot(player_me)});
      if (!self.active) return oldFaction.apply(this, args);
      return self.withDecisionOwner(this, () => oldFaction.apply(this, args), `faction:${this.deck?.faction || 'unknown'}:use`);
    };

    // v1.3 audited carousel protocol. Every carousel has a scoped decision id
    // and every selected card carries a locator for its real gameplay location.
    // This prevents choices from concurrent/multi-stage abilities being consumed
    // by the wrong carousel and makes random/filtered temporary lists safe.
    const oldQueue = UI.prototype.queueCarousel;
    const oldViewContainer = UI.prototype.viewCardsInContainer;
    UI.prototype.viewCardsInContainer = async function(container, action) {
      // Inspecting a row/grave has no gameplay choice to replay on the peer.
      if (self.active && !action)
        return oldQueue.call(this, container, 1, () => {}, () => true, false, true);
      return oldViewContainer.call(this, container, action);
    };
    self._originalQueueCarousel = oldQueue;
    UI.prototype.queueCarousel = async function(container, count, action, predicate, bSort, bQuit, title, bRedraw = false, localPreview = false) {
      if (!self.active) return oldQueue.call(this, container, count, action, predicate, bSort, bQuit, title, bRedraw);
      // Only the explicit viewCard entry point marks a local preview. Card
      // contents cannot distinguish a preview from a one-candidate decision.
      if (localPreview) {
        self.trace('decision:carousel-local-preview', {actor:self.localRole(), card:container.cards[0]?.key || null, err:'leader-preview'});
        return oldQueue.call(this, container, count, action, predicate, bSort, bQuit, title, bRedraw);
      }
      const chooser = self.decisionOwner();
      const decision = self.beginDecision('carousel', chooser);
      self.trace('decision:carousel-open', {actor:decision.role,
        err:decision.id + ':cards=' + (container?.cards?.length || 0) + ':redraw=' + !!bRedraw});

      if (self.isRemote(chooser)) {
        self.trace('decision:carousel-wait', {actor:decision.role, err:decision.id});
        // v1.3.8: collect the whole selection transaction first and commit it at
        // choice-end, matching the local Carousel lifecycle. This prevents one
        // peer from mutating a hand/row/grave while the chooser is still looking
        // at the remaining candidates.
        const pendingChoices = [];
        let receivedEnd = false;
        while (true) {
          let m;
          try {
            m = await self.nextMatchingWithTimeout(["choice", "choice-commit", "choice-end"], x => x.decision === decision.id, 30000, `Timed out waiting for carousel choice (${decision.id})`);
          } catch (e) {
            self.trace('decision:carousel-timeout', {actor:decision.role, err:decision.id});
            return self.desync(e.message);
          }
          self.trace('decision:carousel-recv', {actor:decision.role, card:m.card?.key || null, err:decision.id + ':' + m.t});
          if (m.t === "choice-end") { receivedEnd = true; break; }
          if (m.t === "choice-commit") break;
          pendingChoices.push(m);
        }

        // All local non-redraw choices are committed only after the carousel
        // closes, so every ownerState in this transaction represents the same
        // pre-commit private state. Reconcile it at most once; doing so before
        // every pick would undo the previous committed pick.
        const privateBase = pendingChoices.find(m => m.ownerState && m.locator?.kind === 'zone' && (m.locator.zone === 'hand' || m.locator.zone === 'deck'));
        if (privateBase) {
          const owner = self.playerOf(privateBase.locator.role);
          if (owner) self.reconcilePrivateZones(owner, privateBase.ownerState, 'pre-carousel-transaction', {nonFatal:true});
        }

        const resolvedChoices = [];
        for (const m of pendingChoices) {
          let resolved = self.resolveCardLocator(m.locator, container);
          if (!resolved && m.card?.key && container?.cards) {
            const matches = container.cards.filter(c => c.key === m.card.key);
            if (matches.length === 1) resolved = {card:matches[0], container, index:container.cards.indexOf(matches[0])};
          }
          if (!resolved) {
            const got = container?.cards?.map(c => c.key) || [];
            return self.desync('Remote carousel could not resolve selection' +
              '\ndecision=' + decision.id +
              '\nlocator=' + JSON.stringify(m.locator || null) +
              '\ncard=' + JSON.stringify(m.card || null) +
              '\nremote cards=' + got.join(','));
          }
          resolvedChoices.push(resolved);
        }
        for (const resolved of resolvedChoices) {
          const index = resolved.container.cards.indexOf(resolved.card);
          if (index < 0) throw new Error('Selected remote card left its container before commit');
          await action(resolved.container, index);
        }
        if (!receivedEnd) await self.nextMatchingWithTimeout('choice-end', x => x.decision === decision.id,
          30000, 'Timed out waiting for carousel completion (' + decision.id + ')');
        self.trace('decision:carousel-commit', {actor:decision.role, err:decision.id + ':count=' + pendingChoices.length});
        return;
      }

      if (chooser === player_me) {
        const wrapped = async (c, i) => action(c, i);
        wrapped.prepare = async (c, picks) => {
          for (const chosenCard of picks) {
            const locator = self.cardLocator(chosenCard);
            if (locator?.kind === 'virtual') locator.card = self.containerCardRef(c, chosenCard);
            const payload = {t:'choice', decision:decision.id, card:self.containerCardRef(c, chosenCard),
              i:c.cards.indexOf(chosenCard), locator};
            if (locator?.kind === 'zone' && (locator.zone === 'hand' || locator.zone === 'deck')) {
              const owner = self.playerOf(locator.role);
              if (owner) payload.ownerState = self.zoneSnapshot(owner);
            }
            self.trace('decision:carousel-send', {actor:decision.role, card:chosenCard.key, err:decision.id});
            self.send(payload);
          }
          self.send({t:'choice-commit', decision:decision.id});
        };
        await self.waitBoardInteraction(oldQueue.call(this, container, count, wrapped, predicate, bSort, bQuit, title, bRedraw));
        self.trace('decision:carousel-send-end', {actor:decision.role, err:decision.id});
        self.send({t:'choice-end', decision:decision.id});
        return;
      }
      return oldQueue.call(this, container, count, action, predicate, bSort, bQuit, title, bRedraw);
    };
  },

  _originalInitialRedraw: Game.prototype.initialRedraw,

  async showRedrawWait() {
    if (!this.active || !ui?.notif_elem) return;
    const bar = ui.notif_elem;
    const inner = bar.children && bar.children[0];
    if (!inner) return;
    inner.id = "notif-op-redraw";
    // v5 notifications are CSS-driven rather than I18N data-text driven.
    try { await fadeIn(bar, 150); } catch (_) { bar.classList.remove("hide"); }
  },

  async hideRedrawWait() {
    if (!ui?.notif_elem) return;
    const bar = ui.notif_elem;
    // Only hide our persistent mulligan banner; do not race a later turn banner.
    if (bar.children?.[0]?.id !== "notif-op-redraw") return;
    try { fadeOut(bar, 150); await sleep(180); } catch (_) { bar.classList.add("hide"); }
  },

  async localMulligan(p, role, count) {
    // Do not let a stale carousel from the previous match block opening redraw.
    // There should never be a legitimate active carousel at this match phase.
    try {
      if (typeof Carousel !== 'undefined' && Carousel.curr) {
        console.warn('[Gwent Online] clearing stale carousel before mulligan');
        Carousel.clearCurrent();
        Carousel.elem?.classList.add('hide');
      }
      if (ui?.carousels?.length) ui.carousels = [];
    } catch (_) {}
    const daisy = p.leader.key === "sc_francesca_daisy";
    let pickNo = 0;
    if (daisy && p.hand.cards.length !== 13) {
      this.trace('mulligan:daisy-hand-error', {actor:role, count, hand:p.hand.cards.length, deck:p.deck.cards.length});
      return this.desync(`Francesca Daisy opening hand is ${p.hand.cards.length}; expected 13 before choosing 2 cards`);
    }
    const action = async (c,i) => {
      const card = c?.cards?.[i];
      if (!card) return this.desync(`Mulligan selected a missing card for ${role}`);
      this.trace('mulligan:pick', {actor:role, card:card.key, pick:++pickNo, count, handBefore:c.cards.length, deckBefore:p.deck.cards.length});
      if (daisy) {
        // Daisy is a return-to-deck, not a redraw. Remove it from the hand
        // synchronously so the carousel can never offer/click the same card
        // again while a movement animation is still running. Deck.addCard()
        // performs the actual randomized shuffle under the owner's RNG scope.
        await this.withDeckRng(role, () => p.deck.addCard(c.removeCard(i)));
      } else {
        await this.withDeckRng(role, () => p.deck.swap(c, c.removeCard(i)));
      }
      this.trace('mulligan:pick-applied', {actor:role, card:card.key, pick:pickNo, count, handAfter:c.cards.length, deckAfter:p.deck.cards.length});
    };
    this.trace('mulligan:open', {actor:role, count, daisy, hand:p.hand.cards.length, deck:p.deck.cards.length});
    await this._originalQueueCarousel.call(
      ui, p.hand, count, action, c => true, true, !daisy,
      daisy ? `Choose ${count} cards to put back into your deck.` : `Choose up to ${count} cards to redraw.`,
      true
    );
    this.trace('mulligan:done', {actor:role, picks:pickNo, count, daisy});
  },


  destToWire(dest) {
    if (!dest) return null;
    if (dest === weather || (typeof Weather !== "undefined" && dest instanceof Weather) || dest?.elem?.id === "weather")
      return {kind:"weather"};
    let row = dest;
    if (!board.row.includes(row)) row = board.row.find(r => r.special === dest) || null;
    if (!row) return null;
    const i = board.row.indexOf(row);
    if (i < 0) return null;
    const owner = i < 3 ? player_op : player_me;
    // v5 Row objects do not expose .type. Board order is:
    // opponent siege/ranged/close, local close/ranged/siege.
    const type = ["siege", "ranged", "close", "close", "ranged", "siege"][i];
    return {kind:"row", role:this.roleOfPlayer(owner), type};
  },
  destFromWire(d) {
    if (!d) return null;
    if (d === "weather" || d.weather === true || d.kind === "weather") return weather;
    const role = d.role || d.o;
    const type = d.type || d.r;
    if (!role || !["close","ranged","siege"].includes(type)) return null;
    const owner = this.playerOf(role);
    const mine = owner === player_me;
    const idx = type === "close" ? (mine ? 3 : 2) : type === "ranged" ? (mine ? 4 : 1) : type === "siege" ? (mine ? 5 : 0) : -1;
    return idx >= 0 ? (board.row[idx] || null) : null;
  },

  async applyRemoteAction(player, m) {
    this._sendingSuppressed = true;
    try {
      const expectedRole = this.roleOfPlayer(player);
      if (m.actorRole && m.actorRole !== expectedRole)
        return this.desync(`Remote action actor mismatch: expected=${expectedRole} remote=${m.actorRole}`);
      if (m.seq != null && Number(m.seq) !== this._turnSeq)
        return this.desync(`Remote action sequence mismatch: local=${this._turnSeq} remote=${m.seq}`);
      if (game.currPlayer !== player) {
        console.error('[Gwent Online] remote action arrived for non-current player', {
          seq:this._turnSeq, expectedRole, current:game.currPlayer ? this.roleOfPlayer(game.currPlayer) : null, action:m
        });
        // The network action is authoritative about who is acting. Repairing the
        // object reference here is safer than allowing both clients to enter the
        // turn barrier with opposite local/remote interpretations.
        game.currPlayer = player;
      }
      console.log('[Gwent Online] apply remote action', {seq:this._turnSeq, actorRole:expectedRole, action:m.a});
      if (m.preState && !this.reconcilePrivateZones(player, m.preState, "pre-action")) return;
      if (m.a === "pass") return await player.passRound();
      if (m.a === "leader") return await player.activateLeader();
      if (m.a === "faction") return await player.useFactionAbility();
      let card = this.cardFromWire(m.card, player.hand);
      // A keyed reference is authoritative. Falling back to the same numeric
      // index can replay a completely different card (e.g. Fog as Geralt) and
      // hides the real synchronization fault. Index fallback is kept only for
      // legacy messages that contain no card key.
      if (!card && (!m.card || !m.card.key) && Number.isInteger(m.i)) card = player.hand.cards[m.i];
      if (!card) return this.desync("Remote hand is missing card: " + JSON.stringify(m.card || m.i) +
        " | remote hand=" + player.hand.cards.map(c => c.key).join(","));
      if (m.a === "decoy") {
        const row = this.destFromWire(m.d);
        let target = row ? this.containerCardFromRef(row, m.target) : null;
        if (!target && (!m.target || !m.target.key) && Number.isInteger(m.j)) target = row?.cards?.[m.j];
        if (!row || !target) return this.desync("Invalid decoy target: " + JSON.stringify(m.target || m.j));
        return await this.resolveDecoyAtomic(player, card, row, target);
      }
      if (m.a === "play") {
        const row = this.destFromWire(m.d);
        if (!row) return this.desync("Invalid destination: " + JSON.stringify(m.d));
        // Defensive compatibility for a duplicate Decoy packet.  A Decoy with
        // a selectable unit does not complete on row selection in v5; the real
        // top-level decision is the subsequent target-bearing `decoy` action.
        // Never let the preliminary play packet consume the remote turn.
        const decoyNeedsTarget = card.key === "spe_decoy" ||
          (card.abilities?.includes("decoy") && row?.cards?.some(c => c.isUnit()));
        if (decoyNeedsTarget) {
          this.trace("remote:defer-preliminary-decoy-play", {actor:expectedRole, card:card.key});
          return "deferred-decoy-play";
        }
        // Reuse v5 UI dispatch so special-card branches stay identical to local play.
        ui.previewCard = card; ui.lastRow = row;
        return await UI.prototype.selectRow.call(ui, row, !!m.special);
      }
      return this.desync("Unknown remote action");
    } finally { this._sendingSuppressed = false; }
  },

  // Canonical state used by the *blocking* turn barrier.  Keep this focused
  // on gameplay-visible invariants and independent of local presentation/order.
  // In particular we do not compare grave contents or private hand/deck order:
  // v5 has wall-clock grave cleanup and private-zone ordering can differ while
  // still representing the same playable state.  Board card identity *is*
  // compared, so replaying the wrong card is still caught immediately.
  syncState() {
    const sortedKeys = cards => (cards || []).map(c => c.key).sort();
    const rowState = r => ({
      total:Number(r.total) || 0,
      cards:sortedKeys(r.cards),
      special:sortedKeys(r.special?.cards || [])
    });
    const playerState = p => ({
      health:Number(p.health) || 0,
      total:Number(p.total) || 0,
      passed:!!p.passed,
      // Hand/deck are private authoritative state. They are synchronized from
      // the owning browser at action boundaries and kept in logicalState() for
      // diagnostics, but are not a blocking public lockstep invariant.
      leaderAvailable:!!p.leaderAvailable,
      factionAbilityUses:Number(p.factionAbilityUses) || 0,
      rows:p.getAllRows().map(rowState)
    });
    return {
      host:playerState(this.playerOf('host')),
      guest:playerState(this.playerOf('guest')),
      weather:sortedKeys(weather?.cards || []),
      round:Number(game.roundCount) || 0,
      current:game.currPlayer ? this.roleOfPlayer(game.currPlayer) : null,
      first:game.firstPlayer ? this.roleOfPlayer(game.firstPlayer) : null
    };
  },

  // Full audit state remains intentionally detailed, but a difference here is
  // diagnostic only. It is logged to the browser console instead of killing a
  // valid match. This is useful for finding the next truly unsynchronised v5
  // special ability without creating false positives from private ordering.
  logicalState() {
    const playerState = p => ({
      health:p.health, total:p.total, passed:!!p.passed,
      hand:p.hand.cards.map(c=>c.key), deck:p.deck.cards.map(c=>c.key), grave:p.grave.cards.map(c=>c.key),
      rows:p.getAllRows().map(r=>({cards:r.cards.map(c=>[c.key,c.power]), special:r.special.cards.map(c=>c.key)}))
    });
    return {host:playerState(this.playerOf('host')), guest:playerState(this.playerOf('guest')), weather:weather.cards.map(c=>c.key), round:game.roundCount};
  },

  hashState(value) {
    const s=JSON.stringify(value); let h=2166136261>>>0;
    for (let i=0;i<s.length;i++){h^=s.charCodeAt(i);h=Math.imul(h,16777619)>>>0;}
    return h.toString(16);
  },
  stateHash() { return this.hashState(this.syncState()); },
  auditHash() { return this.hashState(this.logicalState()); },

  shortValue(v) {
    let s;
    try { s = JSON.stringify(v); } catch (_) { s = String(v); }
    return s && s.length > 160 ? s.slice(0,157) + '...' : s;
  },

  firstStateDifference(a, b, path='state') {
    if (a === b) return null;
    if (typeof a !== typeof b) return {path, local:a, remote:b};
    if (a == null || b == null) return {path, local:a, remote:b};
    if (Array.isArray(a) || Array.isArray(b)) {
      if (!Array.isArray(a) || !Array.isArray(b)) return {path, local:a, remote:b};
      if (a.length !== b.length) return {path:path+'.length', local:a.length, remote:b.length};
      for (let i=0;i<a.length;i++) {
        const d=this.firstStateDifference(a[i],b[i],`${path}[${i}]`);
        if (d) return d;
      }
      return null;
    }
    if (typeof a === 'object') {
      const keys=[...new Set([...Object.keys(a),...Object.keys(b)])].sort();
      for (const k of keys) {
        if (!(k in a) || !(k in b)) return {path:`${path}.${k}`, local:a[k], remote:b[k]};
        const d=this.firstStateDifference(a[k],b[k],`${path}.${k}`);
        if (d) return d;
      }
      return null;
    }
    return {path, local:a, remote:b};
  },

  desync(reason, notifyPeer = true) {
    if (String(reason).includes('Online match closed')) return;
    if (notifyPeer) {
      try { this.send({t:'match-stop', matchToken:this._matchToken, reason:String(reason).slice(0,500)}); } catch (_) {}
    }
    this.active = false;
    if (typeof game !== 'undefined') game.over = true;
    this.cancelBoardInteractions();
    document.getElementsByTagName('main')[0]?.classList.add('noclick');
    console.error("Online desync:", reason);
    alert("Online match desynchronized and was stopped.\n\n" + reason);
  },
  peerLeft() {
    this.cancelBoardInteractions();
    if (this.active) { this.active = false; alert("The other player disconnected."); }
    this.peerConnected = false;
    this.localReady = false; this.remoteReady = false; this.remoteDeck = null;
    this.updateReadyUI();
    this.updateDeckStartButton();
    this.updateLobby("Your friend left the room. Create or join a room to continue.", OnlineNet.code);
  },

  applyPlayMode(mode) {
    const friend = mode === "friend";
    const onlineButton = document.getElementById("start-pvp-game");
    if (onlineButton) onlineButton.style.display = friend ? "" : "none";
    const lobby = document.getElementById("online-lobby");
    if (!friend && lobby) lobby.classList.add("hide");
    this.updateDeckStartButton();
    if (friend) this.applyRemoteOpLeaderLock(); else this.clearOpLeaderLock();
  },

  canReadyFromDeckBuilder() {
    return window.GwentPlayMode === "friend" &&
      !!OnlineNet.connected && !!OnlineNet.role && !!OnlineNet.code && !!this.peerConnected && !this.active;
  },

  toggleReadyFromDeckBuilder() {
    if (window.GwentPlayMode !== "friend") return;
    if (!this.canReadyFromDeckBuilder()) {
      this.updateLobby("Open Online Multiplayer and connect to your friend first.", OnlineNet.code);
      return;
    }
    if (this.localReady) this.unready(); else this.ready();
  },

  updateDeckStartButton() {
    const btn = document.getElementById("start-game");
    if (!btn) return;
    if (window.GwentPlayMode !== "friend") {
      btn.disabled = false;
      btn.textContent = "Start game";
      btn.title = "Start a game against the computer";
      return;
    }
    const usable = this.canReadyFromDeckBuilder();
    btn.disabled = !usable;
    if (!OnlineNet.connected || !OnlineNet.role || !OnlineNet.code) {
      btn.textContent = "Start game";
      btn.title = "Connect through Online Multiplayer first";
    } else if (!this.peerConnected) {
      btn.textContent = "Waiting for friend…";
      btn.title = "Waiting for your friend to join the room";
    } else if (this.localReady) {
      btn.textContent = "Waiting for friend…";
      btn.title = "Click to cancel Ready";
      btn.disabled = false;
    } else {
      btn.textContent = "Start game";
      btn.title = "Ready up with your current deck";
    }
  },

  openLobby() {
    if (window.GwentPlayMode !== "friend") return;
    document.getElementById("online-lobby")?.classList.remove("hide");
    this.updateReadyUI();
    this.updateDeckStartButton();
  },
  closeLobby() { document.getElementById("online-lobby")?.classList.add("hide"); },
  updateLobby(text, code) {
    const s = document.getElementById("online-status"); if (s) s.textContent = text || "";
    const c = document.getElementById("online-room-code"); if (c) c.textContent = code || OnlineNet.code || "-----";
  },
  updateReadyUI() {
    const b = document.getElementById("online-ready");
    if (b) {
      b.textContent = this.localReady ? "Not ready" : "Ready";
      b.disabled = !this.peerConnected && !this.localReady;
    }
    const r = document.getElementById("online-ready-state"); if (r) r.textContent = `You: ${this.localReady?"ready":"not ready"} • Opponent: ${this.remoteReady?"ready":"not ready"}`;
    this.updateDeckStartButton();
  },

  updateRematchUI() {
    const btn = game?.replay_elem;
    if (!btn || !this.active || !game?.over) return;
    if (this.localReady && this.remoteReady) btn.textContent = "Starting rematch…";
    else if (this.localReady) btn.textContent = "Waiting for opponent…";
    else if (this.remoteReady) btn.textContent = "Opponent ready — Replay";
    else btn.textContent = "Replay";
  },

  async roomAction(label, action) {
    if (this._roomActionBusy) {
      this.updateLobby("Please wait — a room action is already running.", OnlineNet.code);
      return;
    }
    this._roomActionBusy = true;
    this.setRoomButtonsDisabled(true);
    try {
      await this.ensureConnected();
      OnlineNet.resetRoom();
      this.localReady = false; this.remoteReady = false; this.remoteDeck = null;
      this.peerConnected = false;
      this.remoteOpLeaderChoice = null;
      this._randomLeaderApplied = false;
      this._inRandomLeaderSeed = null;
      this._outRandomLeaderSeed = null;
      this.clearOpLeaderLock();
      this.updateReadyUI();
      this.updateDeckStartButton();
      // WebSocket frames are ordered, so a preceding leave is processed before create/join.
      await action();
    } catch (e) {
      console.error(`[Gwent Online] ${label} failed`, e);
      this.updateLobby("ERROR: " + (e && e.message ? e.message : String(e)), OnlineNet.code);
    } finally {
      this._roomActionBusy = false;
      this.setRoomButtonsDisabled(false);
    }
  },
  setRoomButtonsDisabled(disabled) {
    for (const id of ["online-create","online-join","online-quick"]) {
      const el = document.getElementById(id); if (el) el.disabled = !!disabled;
    }
  },
  async createRoomSafe() {
    return this.roomAction("Create room", async () => {
      this.updateLobby("Connected. Creating room…");
      const code = await OnlineNet.createRoom();
      this.role = "host";
      this.peerConnected = false;
      this.updateLobby(`Room: ${code} — waiting for opponent…`, code);
      this.updateDeckStartButton();
    });
  },
  async joinRoomSafe() {
    const code = String((document.getElementById("online-code-input") || {}).value || "").trim().toUpperCase();
    if (code.length !== 5) return this.updateLobby("Enter the 5-character room code.");
    return this.roomAction("Join room", async () => {
      this.updateLobby(`Connected. Joining ${code}…`);
      await OnlineNet.joinRoom(code);
      this.role = "guest";
      this.peerConnected = true;
      this.updateLobby(`Joined ${OnlineNet.code}. You can now press Start game when your deck is set.`, OnlineNet.code);
      // Join succeeded only after the server attached this socket as the guest,
      // so Ready must be enabled now rather than waiting for peer lobby traffic.
      this.updateReadyUI();
      this.updateDeckStartButton();
    });
  },
  async quickMatchSafe() {
    return this.roomAction("Quick match", async () => {
      this.updateLobby("Connected. Looking for opponent…");
      const code = await OnlineNet.quickMatch();
      this.role = OnlineNet.role;
      this.peerConnected = OnlineNet.role === "guest";
      this.updateLobby(`Matched in room ${code}.`, code);
      // The second quickmatch player receives `joined`; that is already proof
      // of a live peer. Recompute the lobby Ready button immediately.
      this.updateReadyUI();
      this.updateDeckStartButton();
    });
  },

  initUI() {
    // The stock v5 Give up handler is local-only and even resets the board before
    // showing the result. Intercept it in capture phase during online matches so
    // both desktop (onclick) and mobile (addEventListener) paths are replaced by
    // the synchronized forfeit protocol above.
    const giveup = document.getElementById("giveup-button");
    if (giveup) giveup.addEventListener("click", (e) => {
      if (!this.active || (typeof game !== "undefined" && game.over)) return;
      e.preventDefault();
      e.stopPropagation();
      e.stopImmediatePropagation();
      void this.concedeLocal();
    }, true);

    // v0.5: v5 has global E/Q/X/Enter shortcuts registered on window/document.
    // While the online lobby is open (or any form control has focus), those
    // keystrokes must never escape to the game/deck-maker handlers.
    const isolateLobbyKeyboard = (e) => {
      const lobby = document.getElementById("online-lobby");
      const lobbyOpen = !!lobby && !lobby.classList.contains("hide");
      const t = e.target;
      const editing = !!t && (
        /^(INPUT|TEXTAREA|SELECT|BUTTON)$/.test(t.tagName || "") ||
        t.isContentEditable ||
        (typeof t.closest === "function" && !!t.closest("#online-lobby"))
      );
      if (!lobbyOpen && !editing) return;
      e.stopImmediatePropagation();
      // Enter in the room-code box means Join; all normal character input is kept.
      if (e.type === "keydown" && e.key === "Enter" && t?.id === "online-code-input") {
        e.preventDefault();
        this.joinRoomSafe();
      }
    };
    window.addEventListener("keydown", isolateLobbyKeyboard, true);
    window.addEventListener("keyup", isolateLobbyKeyboard, true);

    document.getElementById("online-close")?.addEventListener("click", () => this.closeLobby());
    const create = document.getElementById("online-create"); if (create) create.onclick = () => { this.createRoomSafe(); return false; };
    const join = document.getElementById("online-join"); if (join) join.onclick = () => { this.joinRoomSafe(); return false; };
    const quick = document.getElementById("online-quick"); if (quick) quick.onclick = () => { this.quickMatchSafe(); return false; };
    document.getElementById("online-ready")?.addEventListener("click", () => this.localReady ? this.unready() : this.ready());
    document.getElementById("online-server-save")?.addEventListener("click", () => {
      const v = document.getElementById("online-server-url").value.trim(); if (v) localStorage.setItem("gwent-online-server", v);
      this.updateLobby("Relay server saved. Reopen the lobby connection to use it.", OnlineNet.code);
    });
    const u = document.getElementById("online-server-url"); if (u) u.value = OnlineNet.serverURL();
    this.applyPlayMode(window.GwentPlayMode || null);
  }
};

window.GwentOnline = GwentOnline;
if (document.readyState === "loading") {
  window.addEventListener("DOMContentLoaded", () => GwentOnline.initUI(), {once:true});
} else {
  GwentOnline.initUI();
}


// v1.1.6 diagnostic safety net: surface async failures instead of leaving both peers waiting.
window.addEventListener("unhandledrejection", ev => {
  if (ev.reason?.name === "AbortError") { ev.preventDefault(); return; }
  try { if (GwentOnline?.active) GwentOnline.trace("window:unhandledrejection", {err:String(ev.reason?.stack || ev.reason || "unknown")}); } catch (_) {}
});
window.addEventListener("error", ev => {
  try { if (GwentOnline?.active) GwentOnline.trace("window:error", {err:String(ev.error?.stack || ev.message || "unknown")}); } catch (_) {}
});
