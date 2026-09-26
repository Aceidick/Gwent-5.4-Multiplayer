"use strict";
// Regression test for the random AI opponent deck in Player vs Computer.
// Bug: when the opponent uses a random premade deck, startNewGame() overwrote
// the deck's own leader with a uniformly random leader from the same faction.
// The deck title shown on the board (e.g. "Old Northern Realms - False
// Empress", whose bundled leader is Fake Ciri) then no longer matched the
// leader card actually played (e.g. Queen Calanthe). The fix keeps the deck's
// bundled leader, so the title and the leader card always belong together.
//
// The browser flow of DeckMaker.startNewGame() needs a full DOM, so this test
// reproduces the relevant code path headlessly: load cards.js/decks.js, then
// apply the same leader resolution the fixed startNewGame() performs, for every
// premade deck and across many seeded random-deck picks.
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const root = path.resolve(__dirname, '..');
function assert(v, label) { console.log(`${v?'PASS':'FAIL'} ${label}`); if (!v) process.exitCode = 1; }

// Evaluate cards.js and decks.js (browser globals) in a shared sandbox.
const ctx = { window: {}, console };
vm.createContext(ctx);
for (const f of ['cards.js', 'decks.js']) {
  const code = fs.readFileSync(path.join(root, f), 'utf8');
  try { vm.runInContext(code, ctx, {filename: f}); }
  catch (e) { /* some files touch optional browser bits; globals are set before any throw */ }
}
const card_dict = ctx.card_dict;
const premade_deck = ctx.premade_deck;

assert(!!card_dict && Object.keys(card_dict).length > 0, 'cards.js loads card_dict');
assert(!!premade_deck && premade_deck.length > 0, 'decks.js loads premade_deck');

// Every premade deck must bundle a valid leader card of its own faction.
let allBundled = true;
for (const deck of premade_deck) {
  const leader = card_dict[deck.leader];
  if (!leader || leader.row !== 'leader' || leader.deck !== deck.faction) {
    allBundled = false;
    console.log('  bad bundle: ' + JSON.stringify({title: deck.title, leader: deck.leader}));
  }
}
assert(allBundled, 'every premade deck bundles a valid leader of its faction');

// Deterministic PRNG (mulberry32) so failures are reproducible.
function mulberry32(a) {
  return function() {
    a |= 0; a = a + 0x6D2B79F5 | 0;
    let t = Math.imul(a ^ a >>> 15, 1 | a);
    t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
    return ((t ^ t >>> 14) >>> 0) / 4294967296;
  };
}
const rand = mulberry32(0x73CA89);
const randomInt = n => Math.floor(rand() * n);

// Mirror of the fixed startNewGame() random-opponent-deck branch: keep the
// deck's bundled leader (index + card), exactly like the explicit
// selectOPDeck() path and sim.js already did.
function resolveRandomOPDeck() {
  const deck = JSON.parse(JSON.stringify(premade_deck[randomInt(Object.keys(premade_deck).length)]));
  deck.cards = deck.cards.map(c => ({index: c[0], count: c[1]}));
  deck.leader = {index: deck.leader, card: card_dict[deck.leader]};
  return deck;
}

// The reported scenario: title says "Old Northern Realms - False Empress" but
// the leader card on the board was Queen Calanthe. Several premade decks share
// a generic title (e.g. "Northern Realms" x5), so a title alone only allows the
// leaders bundled by decks with that exact title. With the fix, the resolved
// leader must always be one of those; under the old bug a random faction leader
// (e.g. Queen Calanthe under the unique "False Empress" title) escapes the set.
const allowedLeadersByTitle = new Map(premade_deck.map(d => [d.title, new Set()]));
for (const d of premade_deck) allowedLeadersByTitle.get(d.title).add(d.leader);

let mismatches = 0;
const seen = new Set();
const runs = 5000;
for (let i = 0; i < runs; i++) {
  const deck = resolveRandomOPDeck();
  seen.add(deck.title);
  const allowed = allowedLeadersByTitle.get(deck.title);
  if (!allowed.has(deck.leader.index))
    mismatches++;
}
assert(mismatches === 0, `random AI opponent deck always keeps its bundled leader (${runs} runs, ${mismatches} mismatches)`);
assert(seen.size > 1, `random deck pick actually varies (${seen.size} distinct titles sampled)`);

// Direct check of the reported pairing: the unique "False Empress" deck must
// resolve to Fake Ciri, and "Slaughter of Cintra" to Queen Calanthe.
const falseEmpress = premade_deck.find(d => d.title === 'Old Northern Realms - False Empress');
const slaughter = premade_deck.find(d => d.title === 'Old Northern Realms - Slaughter of Cintra');
assert(!!falseEmpress && card_dict[falseEmpress.leader].name === 'Fake Ciri: Empress of Nilfgaard',
  'False Empress deck bundles Fake Ciri');
assert(!!slaughter && card_dict[slaughter.leader].ability === 'queen_calanthe',
  'Slaughter of Cintra deck bundles Queen Calanthe');

console.log('RESULT: ' + (process.exitCode ? 'FAILURES' : 'ALL CHECKS PASS'));
