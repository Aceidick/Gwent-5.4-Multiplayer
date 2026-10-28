"use strict";
// Regression test for the reported Zerrikania inspire + horn issues:
// 1. Free Warrior (inspire) cards double themselves on every score update
//    once a horn is on the row (values explode: 8 -> 64 -> 128 -> ...).
//    Root cause: Row.calcCardScore used the mutable card.power as the
//    inspire source instead of basePower.
// 2. Giving up (or returning to customization) and starting a new game left
//    negative player totals: game.reset() cleared the rows after the players
//    had been reset, so updateScore() decremented the already-zeroed totals.
const { chromium } = require('playwright-core');
const { spawn } = require('child_process');
const path = require('path');
const PORT = process.env.TEST_PORT || '18091';
const URL = `http://127.0.0.1:${PORT}`;
function assert(v, label) { console.log(`${v?'PASS':'FAIL'} ${label}`); if (!v) process.exitCode = 1; }
const wait = ms => new Promise(r=>setTimeout(r,ms));
(async()=>{
  const server = spawn(process.execPath, [path.join(__dirname,'..','server','server.js')],
    {env:{...process.env, PORT}, cwd:path.join(__dirname,'..'), stdio:['ignore','pipe','pipe']});
  await new Promise(r=>setTimeout(r,800));
  const browser = await chromium.launch({headless:true, executablePath:'/home/appuser/.cache/ms-playwright/chromium-1243/chrome-linux64/chrome', args:['--no-sandbox']});
  const page = await (await browser.newContext({viewport:{width:1920,height:1080}})).newPage();
  const pageErrors=[];
  page.on('pageerror', e=>{ pageErrors.push(String(e)); console.log('PAGE ERROR:', String(e)); });
  await page.goto(URL);
  await page.waitForFunction(()=>typeof dm!=='undefined'&&typeof premade_deck!=='undefined', null, {timeout:20000});
  await page.evaluate(()=>{
    const ze = premade_deck.find(d=>d.leader && d.leader.startsWith('ze_')) || premade_deck.find(d=>d.faction==='zerrikania');
    dm.deckFromJSON(JSON.parse(JSON.stringify(ze)), false);
    game.randomOPDeck = false;
    dm.startNewGame(1);
  });
  // Cancel the opening redraw carousel
  await page.waitForFunction(()=>Carousel.curr, null, {timeout:10000});
  await page.evaluate(()=>Carousel.curr.cancel());
  await page.waitForFunction(()=>game.roundCount>=1 && player_me && player_op && !Carousel.curr, null, {timeout:20000});

  // Phase 1: put points on the board, then press Give up. The reset path must
  // not leave negative totals behind: without the fix, clearing the rows
  // decremented the already-reset players, e.g. total -8 and DOM "-8".
  const giveupResult = await page.evaluate(async ()=>{
    const wait = ms => new Promise(r=>setTimeout(r,ms));
    // Freeze the turn flow: pass the AI and hand control to the human
    game.over = true;
    player_op.passed = true;
    game.currPlayer = player_me;
    for (let i=0;i<30 && Carousel.curr;i++) { Carousel.curr.cancel(); await wait(200); }
    await wait(2000);
    // Place a unit on the board directly so my total is positive
    const w = new Card('ze_free_warrior_3', card_dict['ze_free_warrior_3'], player_me);
    const close = board.getRow(w, 'close', player_me);
    player_me.hand.addCard(w);
    await board.moveTo(w, close, player_me.hand);
    await wait(700);
    board.updateScores();
    await wait(700);
    const before = {
      me: player_me.total,
      op: player_op.total,
      domMe: document.getElementById("score-total-me").children[0].innerHTML,
    };
    if (!(before.me > 0)) throw new Error('board setup failed, my total is ' + before.me);
    document.getElementById("giveup-button").click();
    await wait(2500);
    const after = {
      me: player_me.total,
      op: player_op.total,
      domMe: document.getElementById("score-total-me").children[0].innerHTML,
      domOp: document.getElementById("score-total-op").children[0].innerHTML,
      endScreen: !document.getElementById("end-screen").classList.contains("hide"),
    };
    // Start a new game from the end screen, like a user would (Replay)
    game.replay_elem.click();
    for (let i=0;i<200;i++) { if (Carousel.curr) break; await wait(100); }
    if (Carousel.curr) Carousel.curr.cancel();
    const replay = {
      me: player_me.total,
      op: player_op.total,
      domMe: document.getElementById("score-total-me").children[0].innerHTML,
      domOp: document.getElementById("score-total-op").children[0].innerHTML,
    };
    return {before, after, replay};
  });
  console.log('giveup:', JSON.stringify(giveupResult));
  assert(giveupResult.after.me === 0 && giveupResult.after.op === 0,
    'totals after Give up are zero, not negative (got me=' + giveupResult.after.me + ' op=' + giveupResult.after.op + ')');
  assert(Number(giveupResult.after.domMe) === 0 && Number(giveupResult.after.domOp) === 0,
    'DOM scores after Give up are zero (got me="' + giveupResult.after.domMe + '" op="' + giveupResult.after.domOp + '")');
  assert(giveupResult.after.endScreen, 'Give up reached the end screen');
  assert(giveupResult.replay.me >= 0 && giveupResult.replay.op >= 0,
    'totals of the new game are not negative (got me=' + giveupResult.replay.me + ' op=' + giveupResult.replay.op + ')');
  assert(!String(giveupResult.replay.domMe).startsWith('-') && !String(giveupResult.replay.domOp).startsWith('-'),
    'DOM scores of the new game are not negative (got me="' + giveupResult.replay.domMe + '" op="' + giveupResult.replay.domOp + '")');

  // Phase 2: inspire + horn scenario on a cleared board.
  await page.waitForFunction(()=>game.roundCount>=1 && !Carousel.curr, null, {timeout:20000});
  const result = await page.evaluate(async ()=>{
    const wait = ms => new Promise(r=>setTimeout(r,ms));
    const out = {};
    // Freeze turn flow and clear the board for a deterministic scenario
    game.over = true;
    player_op.passed = true;
    game.currPlayer = player_me;
    await wait(2000);
    for (const r of board.row) await r.clear();
    await wait(1000);
    // Collect stray points from the AI's earlier cards
    for (const r of board.row) { r.updateScore(); }
    board.updateScores();
    await wait(500);
    out.clearedTotalMe = player_me.total;

    // Free Warriors: base 8 (close), base 5 (close), base 4 (close)
    const mk = (key) => new Card(key, card_dict[key], player_me);
    const w8 = mk('ze_free_warrior_3');
    const w5 = mk('ze_free_warrior_2');
    const w4 = mk('ze_free_warrior_1');
    const close = board.getRow(w8, 'close', player_me);
    for (const c of [w8, w5, w4]) { player_me.hand.addCard(c); await board.moveTo(c, close, player_me.hand); await wait(700); }
    // Poll until inspire has settled on all three warriors
    for (let i=0;i<30 && !(w8.power===8 && w5.power===8 && w4.power===8);i++) { board.updateScores(); await wait(300); }
    board.updateScores();
    await wait(500);
    out.inspireBeforeHorn = [w8.power, w5.power, w4.power];
    out.rowBeforeHorn = close.total;

    // Add a Commander's Horn to the row
    const horn = new Card('spe_horn', card_dict['spe_horn'], player_me);
    player_me.hand.addCard(horn);
    await board.moveTo(horn, close, player_me.hand);
    // Poll until the horn doubling has settled
    for (let i=0;i<30 && !(w8.power===16 && w5.power===16 && w4.power===16);i++) { board.updateScores(); await wait(300); }
    board.updateScores();
    await wait(500);
    out.inspireAfterHorn = [w8.power, w5.power, w4.power];
    out.rowAfterHorn = close.total;

    // Repeated updates must be stable (no doubling per update)
    for (let i=0;i<3;i++) { board.updateScores(); await wait(300); }
    out.inspireAfterUpdates = [w8.power, w5.power, w4.power];
    out.rowAfterUpdates = close.total;
    return out;
  });

  console.log(JSON.stringify(result, null, 2));
  assert(JSON.stringify(result.inspireBeforeHorn) === JSON.stringify([8,8,8]),
    'inspire lifts all warriors to the highest base power (8,8,8), got ' + JSON.stringify(result.inspireBeforeHorn));
  assert(JSON.stringify(result.inspireAfterHorn) === JSON.stringify([16,16,16]),
    'horn doubles inspire units exactly once (16,16,16), got ' + JSON.stringify(result.inspireAfterHorn));
  assert(JSON.stringify(result.inspireAfterUpdates) === JSON.stringify(result.inspireAfterHorn),
    'repeated score updates are stable, got ' + JSON.stringify(result.inspireAfterUpdates));
  assert(result.rowAfterHorn === 48, 'row total after horn is 48, got ' + result.rowAfterHorn);
  assert(result.rowAfterUpdates === 48, 'row total stays 48 after repeated updates, got ' + result.rowAfterUpdates);
  assert(pageErrors.length===0, 'no page errors: ' + pageErrors.join(' | '));
  await browser.close();
  server.kill();
  process.exit(process.exitCode||0);
})().catch(e=>{console.error('FATAL', e); process.exitCode=1; process.exit(1);});
