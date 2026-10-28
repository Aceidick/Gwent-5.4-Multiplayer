"use strict";
// Regression test for the Ofir Traveling Merchant (trade ability) in PvE.
// Bug report: the merchant seemed usable "only once" when replayed via Decoy.
// Root cause: trade has no once-per-game flag - it can be replayed freely - but
// each trade pays with a random runestone taken from the acting player's DECK
// (not hand). When no runestone remains in the deck the ability silently did
// nothing, which looked like "the merchant stopped working". The fix shows a
// visible notification when the payment cannot be made.
//
// Cases verified (deterministic, AI turn logic disabled):
//  1. trade pays a runestone from the deck and steals a card from the AI deck;
//  2. after a Decoy returns the merchant to the hand, replaying it trades again;
//  3. with no runestones left in the deck, the trade shows a notification
//     instead of failing silently, and no cards move.
const { chromium } = require('playwright-core');
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const PORT = process.env.TEST_PORT || '18094';
const URL = `http://127.0.0.1:${PORT}`;

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
  await page.goto(URL);
  await page.waitForFunction(()=>typeof dm!=='undefined'&&typeof premade_deck!=='undefined', null, {timeout:20000});
  await page.evaluate(()=>{
    const ofir = premade_deck.find(d=>d.faction==='ofir') || premade_deck[0];
    dm.deckFromJSON(JSON.parse(JSON.stringify(ofir)), false);
    dm.startNewGame(1);
  });
  await page.waitForFunction(()=>Carousel.curr, null, {timeout:10000});
  await page.evaluate(()=>Carousel.curr.cancel());
  await page.waitForFunction(()=>game.roundCount>=1 && player_me && player_op && !Carousel.curr, null, {timeout:20000});

  // Deterministic environment: disable AI turns and notifications, stock decks.
  await page.evaluate(()=>{
    player_op.controller.startTurn = async () => {};
    ui.notification = async () => {};
    game.currPlayer = player_me;
    window.__runeKeys = ['ofir_perun','ofir_triglav','ofir_veles','ofir_zoria','ofir_morana','ofir_stribog','ofir_chernobog','ofir_svarog','ofir_dazhbog','ofir_devana'];
    for (let i=0;i<5;i++) player_me.deck.addCard(new Card('ofir_perun', card_dict['ofir_perun'], player_me));
    player_me.deck.cards.filter(c=>window.__runeKeys.includes(c.key)).forEach(c=>{});
    for (let i=0;i<5;i++) player_op.deck.addCard(new Card('ofir_cavalry', card_dict['ofir_cavalry'], player_op));
  });

  const playMerchant = () => page.evaluate(async ()=>{
    const m = new Card('ofir_traveling_merchant', card_dict['ofir_traveling_merchant'], player_me);
    player_me.hand.addCard(m);
    const before = {
      myRunes: player_me.deck.cards.filter(c=>window.__runeKeys.includes(c.key)).length,
      opHand: player_op.hand.cards.length,
      opDeck: player_op.deck.cards.length
    };
    const p = player_me.playCard(m);
    for (let i=0;i<400 && !Carousel.curr;i++) await new Promise(r=>setTimeout(r,25));
    if (Carousel.curr) Carousel.curr.select();
    await p;
    return { before,
      after: {
        myRunes: player_me.deck.cards.filter(c=>window.__runeKeys.includes(c.key)).length,
        opHand: player_op.hand.cards.length,
        opDeck: player_op.deck.cards.length
      },
      merchantOnBoard: board.row.some(r=>r.cards.includes(m)) };
  });

  // Case 1: trade pays a runestone from the deck.
  const runeKeys = ['ofir_perun','ofir_triglav','ofir_veles','ofir_zoria','ofir_morana','ofir_stribog','ofir_chernobog','ofir_svarog','ofir_dazhbog','ofir_devana'];
  const r1 = await playMerchant();
  assert(r1.merchantOnBoard, 'case1: merchant placed on the board');
  assert(r1.after.myRunes === r1.before.myRunes - 1, 'case1: one runestone paid from the deck');
  assert(r1.after.opHand === r1.before.opHand + 1, 'case1: opponent received the runestone in hand');

  // Case 2: Decoy the merchant back and replay it - trade must fire again.
  const r2 = await page.evaluate(async ()=>{
    const m = board.row.flatMap(r=>r.cards).find(c=>c.key==='ofir_traveling_merchant');
    const decoy = new Card('spe_decoy', card_dict['spe_decoy'], player_me);
    player_me.hand.addCard(decoy);
    const row = m.currentLocation;
    m.decoyTarget = true;
    m.holder = player_me;
    await board.toHand(m, row);
    await board.moveTo(decoy, row, player_me.hand);
    return { merchantInHand: player_me.hand.cards.includes(m) };
  });
  assert(r2.merchantInHand, 'case2: Decoy returned the merchant to the hand');

  const r3 = await playMerchant();
  assert(r3.merchantOnBoard, 'case2: merchant replayed to the board');
  assert(r3.after.myRunes === r3.before.myRunes - 1, 'case2: trade fired again after Decoy (runestone paid)');
  assert(r3.after.opHand === r3.before.opHand + 1, 'case2: opponent received the second runestone');

  // Case 3: no runestones left in the deck -> visible notification, no movement.
  const r4 = await page.evaluate(async ()=>{
    const m = board.row.flatMap(r=>r.cards).find(c=>c.key==='ofir_traveling_merchant');
    const decoy = new Card('spe_decoy', card_dict['spe_decoy'], player_me);
    player_me.hand.addCard(decoy);
    const row = m.currentLocation;
    m.decoyTarget = true;
    m.holder = player_me;
    await board.toHand(m, row);
    await board.moveTo(decoy, row, player_me.hand);

    player_me.deck.cards.filter(c=>window.__runeKeys.includes(c.key)).slice().forEach(c=>player_me.deck.removeCard(c));
    const seen = [];
    const origNotif = ui.notification.bind(ui);
    ui.notification = async (name) => { seen.push(name); };

    player_me.hand.addCard(m);
    const before = { opHand: player_op.hand.cards.length, opDeck: player_op.deck.cards.length };
    const p = player_me.playCard(m);
    for (let i=0;i<400 && !Carousel.curr;i++) await new Promise(r=>setTimeout(r,25));
    await p;
    ui.notification = origNotif;
    return { seen, before,
      after: { opHand: player_op.hand.cards.length, opDeck: player_op.deck.cards.length } };
  });
  assert(r4.seen.includes('trade-no-runestone'), 'case3: missing runestone shows the trade-no-runestone notification');
  assert(r4.after.opHand === r4.before.opHand && r4.after.opDeck === r4.before.opDeck,
    'case3: no cards move when the trade cannot be paid');

  console.log(failed ? 'DONE (failures)' : 'DONE (all passed)');
  await browser.close();
  server.kill();
  process.exitCode = failed ? 1 : 0;
})().catch(e=>{ console.error(e); process.exit(1); });
