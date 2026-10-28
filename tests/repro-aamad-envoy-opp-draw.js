"use strict";
// Regression test for "Aamad, the Wise" (ofir_aamad) + Ofieri Envoy
// (ofiri_envoy) drawing from the opponent's deck.
//
// Reported symptom: playing Ofieri Envoy while leading with Aamad, the Wise
// and choosing the opponent's deck for the once-per-card opponent draw only
// granted +1 total power, while choosing the own deck twice granted +2.
//
// Intended behavior: Aamad's description says "Whenever you draw a card, you
// gain +1 total power". Both Envoy draws are draws made by the Envoy's owner
// (one from the opponent's deck, one from the own deck), so both must grant
// +1 to the Envoy's owner regardless of which deck the card came from.
//
// Root cause: the Aamad gameStart effect patches only the acting player's own
// Deck.draw, so a draw routed through the opponent's Deck.draw credited the
// bonus to the wrong player (the deck owner) or to nobody.
//
// This test locks the credit semantics in:
//  1. the opponent-deck draw through Envoy must increment the Envoy owner's
//     aamadBonus, total and badge (not the opponent's);
//  2. the second Envoy draw from the own deck must also be credited;
//  3. the opponent's bonus/total must stay untouched by the Envoy draws.

const { chromium } = require('playwright-core');
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');

const PORT = process.env.TEST_PORT || '18098';
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
      opBonus: player_op.aamadBonus || 0,
      myTotal: player_me.total,
      opTotal: player_op.total,
      myDeck: player_me.deck.cards.length,
      opDeck: player_op.deck.cards.length
    };
  });
  assert(setup.patched, 'Aamad patch is installed on the own deck.draw at game start');
  assert(setup.myBonus === 0, 'Player bonus starts at 0 after the opening hand');
  assert(setup.opBonus === 0, 'Opponent bonus starts at 0');

  // Play Ofieri Envoy and answer the deck-choice popup with "Opponent's deck".
  const envoy = await page.evaluate(async ()=>{
    const before = {
      myBonus: player_me.aamadBonus || 0,
      opBonus: player_op.aamadBonus || 0,
      myTotal: player_me.total,
      opTotal: player_op.total,
      myHand: player_me.hand.cards.length,
      opDeck: player_op.deck.cards.length
    };
    const e = new Card('ofir_envoy_1', card_dict['ofir_envoy_1'], player_me);
    player_me.hand.addCard(e);
    const p = player_me.playCard(e);
    // The popup appears on the first of the two draws; pick the opponent's deck.
    for (let i=0;i<400 && !Popup.curr;i++) await new Promise(r=>setTimeout(r,25));
    if (Popup.curr) Popup.curr.selectNo();
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
        opDeck: player_op.deck.cards.length
      },
      badgeText: badge.innerHTML,
      badgeHidden: badge.classList.contains('hide'),
      scoreText: document.getElementById('score-total-me').children[0].innerHTML,
      usedOpponentDraw: e._usedOpponentDraw === true
    };
  });
  assert(envoy.usedOpponentDraw, 'envoy: the opponent-deck option was selected');
  assert(envoy.after.myHand === envoy.before.myHand + 2, 'envoy: hand nets +2 cards (1 played, 2 drawn)');
  assert(envoy.after.opDeck === envoy.before.opDeck - 1, 'envoy: exactly one card left the opponent deck');
  assert(envoy.after.myBonus === envoy.before.myBonus + 2,
    'envoy: BOTH draws are credited to the Envoy owner (bonus +2, was +1)');
  assert(envoy.after.opBonus === envoy.before.opBonus,
    'envoy: the opponent-deck draw must NOT credit the opponent');
  assert(envoy.after.myTotal === envoy.before.myTotal + 2,
    'envoy: the Envoy owner total grows by exactly the Aamad bonus (spy power excluded)');
  assert(envoy.badgeText === '+2' && envoy.badgeHidden === false, 'envoy: badge shows +2 and is visible');
  assert(String(envoy.scoreText) === String(envoy.after.myTotal), 'envoy: visible score matches total');

  // Control: the spy/envoy unit itself went to the opponent's field, so the
  // opponent total must have grown by the envoy's own power only.
  assert(envoy.after.opTotal === envoy.before.opTotal + 6,
    'envoy: opponent total grows only by the envoy unit power (6)');

  // A direct draw from the opponent's deck (same Deck.draw path) must also
  // credit the acting player, not the deck owner.
  const crossDraw = await page.evaluate(async ()=>{
    const before = {
      myBonus: player_me.aamadBonus || 0,
      opBonus: player_op.aamadBonus || 0,
      myTotal: player_me.total,
      opTotal: player_op.total
    };
    await player_op.deck.draw(player_me.hand);
    return {
      before,
      after: {
        myBonus: player_me.aamadBonus || 0,
        opBonus: player_op.aamadBonus || 0,
        myTotal: player_me.total,
        opTotal: player_op.total
      }
    };
  });
  assert(crossDraw.after.myBonus === crossDraw.before.myBonus + 1,
    'control: a draw from the opponent deck credits the acting player (+1)');
  assert(crossDraw.after.opBonus === crossDraw.before.opBonus,
    'control: the opponent gains no bonus from the acting player draw');
  assert(crossDraw.after.opTotal === crossDraw.before.opTotal,
    'control: the opponent total is unchanged by the acting player draw');

  console.log(failed ? 'DONE (failures)' : 'DONE (all passed)');
  await browser.close();
  server.kill();
  process.exitCode = failed ? 1 : 0;
})().catch(e=>{ console.error(e); process.exit(1); });
