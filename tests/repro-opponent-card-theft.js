"use strict";
// Regression tests for the "card taken from the opponent ends up with the
// opponent" bug class.
//
// Reported symptom: a leader/faction ability that takes a card from the
// opponent (e.g. a medic-style restore) appeared to give the card to the
// opponent instead of the acting player.
//
// The acting player's ownership is decided by Card.holder: every container
// move (board.toHand/toRow/toDeck/toGrave -> moveTo -> getRow) resolves the
// destination through card.holder. If an ability moves an opponent card
// without first assigning the acting player as holder, the card silently
// goes to the opponent's zone.
//
// These tests load the real game modules headless in a VM sandbox (same
// approach as repro-random-deck-leader.js) and drive the actual ability
// implementations to verify holder semantics of every taker ability:
//  1. emhyr_imperial (AI branch) — opponent grave unit -> acting player hand;
//  2. medic — own grave unit -> own side of the board;
//  3. trade (Traveling Merchant) — opponent deck unit -> acting player hand,
//     runestone payment -> opponent hand;
//  4. seize — opponent melee unit -> acting player melee row + holder flip;
//  5. getHighestWeightCard/getLowestWeightCard exist on the simulator AI
//     controller (emhyr_imperial's AI branch calls them).
const fs = require('fs');
const vm = require('vm');
const path = require('path');

const root = path.resolve(__dirname, '..');
function assert(v, label) { console.log(`${v?'PASS':'FAIL'} ${label}`); if (!v) process.exitCode = 1; }

const ctx = { window: { onload: null }, console, document: { getElementById: () => null } };
ctx.global = ctx;
vm.createContext(ctx);
for (const f of ['cards.js', 'decks.js', 'abilities.js', 'factions.js', 'gametracker.js', 'sim.js']) {
  vm.runInContext(fs.readFileSync(path.join(root, f), 'utf8'), ctx, { filename: f });
}
// sim.js declares Player/Card/dm with let/class (block scoped), so expose
// them onto the sandbox object explicitly.
vm.runInContext('this.__x = { dm, Player, Card, game, board, card_dict, ability_dict, premade_deck };', ctx);
const S = ctx.__x;

(async () => {
  const { dm, Player, Card, game, board, card_dict, ability_dict, premade_deck } = S;

  // Two AI players from premade decks. startGame()/startTurn() never runs so
  // the scenario stays fully deterministic.
  dm.selectDeck(premade_deck.find(d => d.faction === 'zerrikania'));
  dm.selectOPDeck(premade_deck.find(d => d.faction === 'nilfgaard' && d.leader === 'ne_emhyr_imperial'));
  const me = new Player(0, 'P1', dm.start_me_deck, true);
  const op = new Player(1, 'P2', dm.start_op_deck, true);
  ctx.__x.me = me; ctx.__x.op = op;
  vm.runInContext('player_me = __x.me; player_op = __x.op;', ctx);
  game.roundCount = 1;
  // Both taker abilities require a non-empty acting hand.
  op.hand.addCard(new Card('ne_albrich', card_dict['ne_albrich'], op));

  // --- Case 1: emhyr_imperial (AI branch) ------------------------------
  {
    const victim = new Card('nr_banner_nurse', card_dict['nr_banner_nurse'], me);
    me.grave.addCard(victim);
    op.leaderAvailable = true;
    op.leader.holder = op;
    await ability_dict['emhyr_imperial'].activated(op.leader, op);
    const stolen = op.hand.cards.filter(c => c.key === 'nr_banner_nurse');
    assert(stolen.length === 1,
      `emhyr_imperial (AI): opponent grave unit ends in the ACTING player's hand (found ${stolen.length})`);
    if (stolen.length === 1) {
      assert(stolen[0].holder === op, 'emhyr_imperial (AI): stolen card holder is the acting player');
    }
    assert(!me.grave.cards.some(c => c.key === 'nr_banner_nurse'),
      'emhyr_imperial (AI): stolen card left the opponent grave');
  }

  // --- Case 2: medic ----------------------------------------------------
  {
    const medic = new Card('ne_albrich', card_dict['ne_albrich'], me);
    const nurse = new Card('nr_banner_nurse', card_dict['nr_banner_nurse'], me);
    me.grave.addCard(nurse);
    await ability_dict['medic'].placed(medic);
    const rowIdx = board.row.indexOf(nurse.currentLocation);
    assert(rowIdx >= 3, `medic: restored card is placed on the medic player's own side (row index ${rowIdx}, must be >= 3)`);
    assert(nurse.holder === me, 'medic: restored card holder is the medic player');
  }

  // --- Case 3: trade (Traveling Merchant) ------------------------------
  {
    // Only the injected unit is a valid purchase target, so the AI branch must
    // buy exactly that card (the deck is otherwise empty of units/heroes).
    const enemyUnit = new Card('nr_banner_nurse', card_dict['nr_banner_nurse'], op);
    op.deck.cards.length = 0;
    op.deck.addCard(enemyUnit);
    const rune = new Card('ofir_perun', card_dict['ofir_perun'], me);
    me.deck.cards.length = 0;
    me.deck.addCard(rune);
    const merchant = new Card('ofir_traveling_merchant', card_dict['ofir_traveling_merchant'], me);
    await ability_dict['trade'].placed(merchant);
    const stolen = me.hand.cards.filter(c => c === enemyUnit);
    assert(stolen.length === 1,
      `trade: bought card from the opponent's deck ends in the ACTING player's hand (found ${stolen.length})`);
    if (stolen.length === 1) assert(stolen[0].holder === me, 'trade: bought card holder is the acting player');
    assert(!op.deck.cards.includes(enemyUnit), 'trade: bought card left the opponent deck');
    assert(op.hand.cards.includes(rune), 'trade: runestone payment ends in the opponent\'s hand');
    assert(!me.deck.cards.includes(rune) && !me.hand.cards.includes(rune),
      'trade: runestone payment left the acting player');
  }

  // --- Case 4: seize ----------------------------------------------------
  {
    const enemyUnit = new Card('nr_banner_nurse', card_dict['nr_banner_nurse'], op);
    const seizeCard = new Card('sy_cyrus_hemmelfart', card_dict['sy_cyrus_hemmelfart'], me);
    const opClose = board.getRow(seizeCard, 'close', op);
    const meClose = board.getRow(seizeCard, 'close', me);
    opClose.cards.push(enemyUnit);
    enemyUnit.currentLocation = opClose;
    await ability_dict['seize'].activated(seizeCard);
    assert(meClose.cards.includes(enemyUnit), 'seize: seized unit moved to the acting player melee row');
    assert(enemyUnit.holder === me, 'seize: seized unit holder is the acting player');
  }

  // --- Case 5: AI weight helpers exist on the simulator controller ------
  {
    assert(typeof op.controller.getHighestWeightCard === 'function',
      'sim ControllerAI exposes getHighestWeightCard');
    assert(typeof op.controller.getLowestWeightCard === 'function',
      'sim ControllerAI exposes getLowestWeightCard');
    const a = new Card('nr_banner_nurse', card_dict['nr_banner_nurse'], op);
    const b = new Card('nr_trebuchet', card_dict['nr_trebuchet'], op);
    const cards = [a, b];
    const best = op.controller.getHighestWeightCard(cards);
    const worst = op.controller.getLowestWeightCard(cards);
    assert(cards.includes(best) && cards.includes(worst),
      'sim AI weight helpers return cards from the provided list');
  }

  // --- Case 6: getRow resolves every agile variant ----------------------
  {
    const variants = [['agile', 3], ['agile_cr', 3], ['agile_cs', 3], ['agile_crs', 3], ['agile_rs', 4]];
    let allOk = true;
    for (const [row, expected] of variants) {
      const c = new Card('nr_banner_nurse', card_dict['nr_banner_nurse'], me);
      const got = board.getRow(c, row, me);
      if (board.row.indexOf(got) !== expected) allOk = false;
    }
    assert(allOk, 'sim getRow resolves every agile variant (agile/agile_cr/agile_cs/agile_crs -> close, agile_rs -> ranged)');
  }

  console.log(process.exitCode ? 'DONE (failures)' : 'DONE (all passed)');
})().catch(e => { console.log('ERROR:', e && e.stack || e); process.exitCode = 1; });
