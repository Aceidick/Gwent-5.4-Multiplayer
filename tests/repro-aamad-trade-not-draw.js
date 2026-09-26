"use strict";
// Regression test for "Aamad, the Wise" (ofir_aamad) + Traveling Merchant (trade).
// Question: does the card taken via Traveling Merchant's trade count as a draw
// for Aamad's passive (+1 total power per card drawn)?
// Intended behavior: NO. Aamad's description says "Whenever you draw a card".
// Trade is not a draw - the merchant's card text says "Choose any card ... and
// add it to your hand" and the implementation moves the card via board.toHand(),
// which does not go through Deck.draw() (the only path the Aamad patch hooks).
// Contrast: Ofiri Envoy explicitly says "draw" and does go through Deck.draw().
//
// This test locks that semantics in:
//  1. a successful trade (runestone paid, card stolen from the opponent deck)
//     must NOT change aamadBonus, the Aamad badge, or the total beyond the
//     merchant's own board power;
//  2. a real deck.draw() afterwards must still increment bonus, total and the
//     badge, proving the Aamad patch is active and the test can detect increments.
const { chromium } = require('playwright-core');
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const PORT = process.env.TEST_PORT || '18099';
let failed = false;
function assert(v, label) { console.log(`${v?'PASS':'FAIL'} ${label}`); if (!v) failed = true; }
function chromePath() {
  for (const p of [process.env.CHROMIUM_PATH, '/usr/bin/chromium', '/usr/bin/chromium-browser', '/usr/bin/google-chrome',
    ...(fs.existsSync('/home/appuser/.cache/ms-playwright') ? fs.readdirSync('/home/appuser/.cache/ms-playwright')
      .filter(d=>d.startsWith('chromium_headless_shell'))
      .map(d=>`/home/appuser/.cache/ms-playwright/${d}/chrome-headless-shell-linux64/chrome-headless-shell`) : [])])
    if (p && fs.existsSync(p)) return p;
  throw new Error('Chromium not found. Install it or set CHROMIUM_PATH.');
}
(async()=>{
  const server = spawn(process.execPath, [path.join(__dirname,'..','server','server.js')],
    {env:{...process.env, PORT}, cwd:path.join(__dirname,'..'), stdio:['ignore','pipe','pipe']});
  await new Promise(r=>setTimeout(r,800));
  const browser = await chromium.launch({headless:true, executablePath:chromePath(), args:['--no-sandbox']});
  const page = await (await browser.newContext({viewport:{width:1920,height:1080}})).newPage();
  page.on('pageerror', e=>{ console.log('PAGE ERROR:', String(e)); failed = true; });
  await page.goto(`http://127.0.0.1:${PORT}`);
  await page.waitForFunction(()=>typeof dm!=='undefined'&&typeof premade_deck!=='undefined', null, {timeout:20000});
  await page.evaluate(()=>{
    const ofir = premade_deck.find(d=>d.faction==='ofir' && d.leader==='ofir_aamad_wise');
    dm.deckFromJSON(JSON.parse(JSON.stringify(ofir)), false);
    dm.startNewGame(1);
  });
  await page.waitForFunction(()=>Carousel.curr, null, {timeout:10000});
  await page.evaluate(()=>Carousel.curr.cancel());
  await page.waitForFunction(()=>game.roundCount>=1 && player_me && player_op && !Carousel.curr, null, {timeout:20000});
  // Deterministic environment: AI turns and notifications disabled, decks stocked.
  await page.evaluate(()=>{
    player_op.controller.startTurn = async () => {};
    ui.notification = async () => {};
    game.currPlayer = player_me;
    window.__runeKeys = ['ofir_perun','ofir_triglav','ofir_veles','ofir_zoria','ofir_morana','ofir_stribog','ofir_chernobog','ofir_svarog','ofir_dazhbog','ofir_devana'];
    if (!player_me.deck.cards.some(c=>window.__runeKeys.includes(c.key)))
      player_me.deck.addCard(new Card('ofir_perun', card_dict['ofir_perun'], player_me));
    if (!player_op.deck.cards.some(c=>c.isUnit()))
      player_op.deck.addCard(new Card('ofir_cavalry', card_dict['ofir_cavalry'], player_op));
  });
  const setup = await page.evaluate(()=>({
    patched: !!(player_me.deck.draw && player_me.deck.draw._isPatched),
    aamadBonus: player_me.aamadBonus || 0,
    myRunes: player_me.deck.cards.filter(c=>window.__runeKeys.includes(c.key)).length,
    opDeck: player_op.deck.cards.length,
    opHand: player_op.hand.cards.length
  }));
  assert(setup.patched, 'Aamad patch is installed on deck.draw at game start');
  assert(setup.aamadBonus === 0, 'Aamad bonus starts at 0 after opening hand');
  assert(setup.myRunes > 0, 'Player has a runestone in the deck to pay the trade');
  // Play Traveling Merchant and let the trade resolve (carousel auto-select).
  const trade = await page.evaluate(async ()=>{
    const badgeBefore = document.getElementById('aamad-bonus-me');
    const before = {
      total: player_me.total,
      aamadBonus: player_me.aamadBonus || 0,
      badgeHidden: badgeBefore.classList.contains('hide')
    };
    const m = new Card('ofir_traveling_merchant', card_dict['ofir_traveling_merchant'], player_me);
    player_me.hand.addCard(m);
    const p = player_me.playCard(m);
    for (let i=0;i<400 && !Carousel.curr;i++) await new Promise(r=>setTimeout(r,25));
    if (Carousel.curr) Carousel.curr.select();
    await p;
    const badge = document.getElementById('aamad-bonus-me');
    return { before,
      after: {
        total: player_me.total,
        aamadBonus: player_me.aamadBonus || 0,
        badgeHidden: badge.classList.contains('hide')
      },
      merchantPower: Number(m.basePower) || 0,
      myRunes: player_me.deck.cards.filter(c=>window.__runeKeys.includes(c.key)).length,
      opDeck: player_op.deck.cards.length,
      opHand: player_op.hand.cards.length
    };
  });
  assert(trade.merchantPower > 0, 'trade: merchant has board power (placed on the board)');
  assert(trade.myRunes === setup.myRunes - 1, 'trade: a runestone was paid from the deck (trade really happened)');
  assert(trade.opDeck === setup.opDeck - 1, 'trade: one card left the opponent deck (card was bought)');
  assert(trade.opHand === setup.opHand + 1, 'trade: opponent received the paid runestone in hand');
  assert(trade.after.aamadBonus === trade.before.aamadBonus,
    'trade: aamadBonus is unchanged (trade is not a draw)');
  assert(trade.after.total === trade.before.total + trade.merchantPower,
    'trade: total only grows by the merchant own power, no Aamad bonus');
  assert(trade.after.badgeHidden === true,
    'trade: Aamad badge stays hidden after the trade');
  // Control: a real draw through Deck.draw must increment bonus, total and badge.
  const draw = await page.evaluate(async ()=>{
    const totalBefore = player_me.total;
    await player_me.deck.draw(player_me.hand);
    const badge = document.getElementById('aamad-bonus-me');
    return {
      totalBefore,
      total: player_me.total,
      aamadBonus: player_me.aamadBonus || 0,
      scoreText: document.getElementById('score-total-me').children[0].innerHTML,
      badgeText: badge.innerHTML,
      badgeHidden: badge.classList.contains('hide')
    };
  });
  assert(draw.aamadBonus === 1, 'control: a real deck.draw raises aamadBonus to 1');
  assert(draw.total === draw.totalBefore + 1, 'control: a real deck.draw raises the total by exactly 1');
  assert(String(draw.scoreText) === String(draw.total), 'control: visible score matches total after the real draw');
  assert(draw.badgeText === '+1' && draw.badgeHidden === false, 'control: badge shows +1 after a real draw');
  console.log(failed ? 'DONE (failures)' : 'DONE (all passed)');
  await browser.close();
  server.kill();
  process.exitCode = failed ? 1 : 0;
})().catch(e=>{ console.error(e); process.exit(1); });
