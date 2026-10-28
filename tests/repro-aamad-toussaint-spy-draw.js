"use strict";
// Regression test for "Aamad, the Wise" (ofir_aamad) + Toussaint spy
// "look at 3, keep 1" (spy ability, toussaint faction branch).
//
// Reported symptom: playing a Toussaint spy while leading with Aamad, the
// Wise, the kept card did not grant the +1 total power draw bonus, even
// though the card text says "Draw 3 cards from your deck. Keep one of them
// in your hand" and Aamad credits "Whenever you draw a card".
//
// Root cause: the Toussaint spy branch moves the kept card with
// board.toHand() instead of Deck.draw(), bypassing the only path the Aamad
// patch hooks. The two shuffled-back cards are NOT draws and must stay
// uncredited.
//
// This test locks the semantics in:
//  1. the kept card must increment the acting player's aamadBonus, total and
//     badge (exactly +1, not +3);
//  2. the two shuffled-back cards must not be credited;
//  3. the opponent (spy victim) gains no bonus from the acting player's draw;
//  4. the spy unit itself counts towards the opponent's total only.

const { chromium } = require('playwright-core');
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');

const PORT = process.env.TEST_PORT || '18097';
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
    // Lock the opponent deck: a random opponent deck could roll leaders that
    // globally change spy power (spyPowerMult) and make totals unpredictable.
    const nv = premade_deck.find(d=>d.leader==='ne_emhyr_emperor');
    dm.start_op_deck = JSON.parse(JSON.stringify(nv));
    dm.start_op_deck.cards = dm.start_op_deck.cards.map(c=>({index:c[0], count:c[1]}));
    dm.start_op_deck.leader = {index:'ne_emhyr_emperor', card:card_dict.ne_emhyr_emperor};
    game.randomOPDeck = false;
    dm.startNewGame(1);
  });
  await page.waitForFunction(()=>Carousel.curr, null, {timeout:10000});
  await page.evaluate(()=>Carousel.curr.cancel());
  await page.waitForFunction(()=>game.roundCount>=1 && player_me && player_op && !Carousel.curr, null, {timeout:20000});

  // Deterministic environment: AI turns and notifications disabled.
  await page.evaluate(()=>{
    player_op.controller.startTurn = async () => {};
    ui.notification = async () => {};
    game.currPlayer = player_me;
  });

  const setup = await page.evaluate(()=>{
    return {
      patched: !!(player_me.deck.draw && player_me.deck.draw._isPatched),
      myBonus: player_me.aamadBonus || 0,
      opBonus: player_op.aamadBonus || 0
    };
  });
  assert(setup.patched, 'Aamad patch is installed on deck.draw at game start');
  assert(setup.myBonus === 0, 'Player bonus starts at 0 after the opening hand');

  // Play a Toussaint spy (Bootblack, faction toussaint) and keep the first
  // of the three revealed cards.
  const spy = await page.evaluate(async ()=>{
    const before = {
      myBonus: player_me.aamadBonus || 0,
      opBonus: player_op.aamadBonus || 0,
      myTotal: player_me.total,
      opTotal: player_op.total,
      myHand: player_me.hand.cards.length,
      myDeck: player_me.deck.cards.length
    };
    const s = new Card('to_bootblack', card_dict['to_bootblack'], player_me);
    player_me.hand.addCard(s);
    const p = player_me.playCard(s);
    // The carousel shows the top 3 cards; keep the first one.
    for (let i=0;i<400 && !Carousel.curr;i++) await new Promise(r=>setTimeout(r,25));
    if (Carousel.curr) Carousel.curr.select();
    await p;
    const badge = document.getElementById('aamad-bonus-me');
    return {
      before,
      after: {
        myBonus: player_me.aamadBonus || 0,
        opBonus: player_op.aamadBonus || 0,
        myTotal: player_me.total,
        opTotal: player_op.total,
        myHand: player_me.hand.cards.length,
        myDeck: player_me.deck.cards.length
      },
      badgeText: badge.innerHTML,
      badgeHidden: badge.classList.contains('hide'),
      scoreText: document.getElementById('score-total-me').children[0].innerHTML
    };
  });
  assert(spy.after.myHand === spy.before.myHand + 1, 'spy: hand nets +1 card (spy added+played, 1 kept)');
  assert(spy.after.myDeck === spy.before.myDeck - 1, 'spy: deck nets -1 card (kept card left, 2 shuffled back)');
  assert(spy.after.myBonus === spy.before.myBonus + 1,
    'spy: ONLY the kept card is credited to the acting player (bonus +1, not +3)');
  assert(spy.after.opBonus === spy.before.opBonus, 'spy: the opponent gains no bonus from the draw');
  assert(spy.after.myTotal === spy.before.myTotal + 1,
    'spy: the acting player total grows by exactly the Aamad bonus');
  assert(spy.badgeText === '+1' && spy.badgeHidden === false, 'spy: badge shows +1 and is visible');
  assert(String(spy.scoreText) === String(spy.after.myTotal), 'spy: visible score matches total');
  // The spy unit itself counts towards the opponent's total only (strength 5).
  // The spy unit itself counts towards the opponent's total only (strength 5).
  assert(spy.after.opTotal === spy.before.opTotal + 5,
    'spy: opponent total grows only by the spy unit power (5)');

  console.log(failed ? 'DONE (failures)' : 'DONE (all passed)');
  await browser.close();
  server.kill();
  process.exitCode = failed ? 1 : 0;
})().catch(e=>{ console.error(e); process.exit(1); });
