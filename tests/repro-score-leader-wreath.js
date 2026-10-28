"use strict";
// Regression test for the score-leader wreath around the player in the lead.
// Bug: Player.setWinning() toggled the "score-leader" DOM class only when the
// model boolean changed (XOR toggle). After give-up/rematch flows wrote the
// model and the DOM class separately, model and DOM could disagree; the next
// toggle then moved the wreath to the wrong player or dropped it entirely.
// Fix: setWinning() is now idempotent and forces the DOM class to the
// requested state on every call, like setPassed().
const { chromium } = require('playwright-core');
const { spawn } = require('child_process');
const path = require('path');
const PORT = process.env.TEST_PORT || '18098';
const URL = `http://127.0.0.1:${PORT}`;

function assert(v, label) { console.log(`${v?'PASS':'FAIL'} ${label}`); if (!v) process.exitCode = 1; }
const log = o => console.log(JSON.stringify(o));

const stateExpr = "({me: document.getElementById('score-total-me').classList.contains('score-leader'), op: document.getElementById('score-total-op').classList.contains('score-leader'), meTotal: player_me.total, opTotal: player_op.total})";

(async()=>{
  const server = spawn(process.execPath, [path.join(__dirname,'..','server','server.js')],
    {env:{...process.env, PORT}, cwd:path.join(__dirname,'..'), stdio:['ignore','pipe','pipe']});
  await new Promise(r=>setTimeout(r,800));
  const browser = await chromium.launch({headless:true, executablePath:'/home/appuser/.cache/ms-playwright/chromium_headless_shell-1243/chrome-headless-shell-linux64/chrome-headless-shell', args:['--no-sandbox']});
  const page = await (await browser.newContext({viewport:{width:1920,height:1080}})).newPage();
  page.on('pageerror', e=>{ console.log('PAGE ERROR:', String(e)); process.exitCode = 1; });
  await page.goto(URL);
  await page.waitForFunction(()=>typeof dm!=='undefined'&&typeof premade_deck!=='undefined', null, {timeout:20000});
  await page.evaluate(()=>{ dm.deckFromJSON(JSON.parse(JSON.stringify(premade_deck[0])), false); dm.startNewGame(1); });
  await page.waitForFunction(()=>Carousel.curr, null, {timeout:10000});
  await page.evaluate(()=>Carousel.curr.cancel());
  await page.waitForFunction(()=>game.roundCount>=1 && player_me && player_op && !Carousel.curr, null, {timeout:20000});

  // 1) Wreath always matches the actual totals, whatever they are at start.
  let s = await page.evaluate((expr) => eval(expr), stateExpr);
  log({initial: s});
  assert(s.me === (s.meTotal > s.opTotal) && s.op === (s.opTotal > s.meTotal),
    'Wreath matches actual leader at game start');

  // 2) Direct setWinning desync: model and DOM forced apart, then repaired.
  s = await page.evaluate((expr)=>{
    // Simulate the stale-DOM condition the give-up/reset flow can produce:
    // model says not winning but the DOM class is still present.
    player_me.winning = false;
    document.getElementById('score-total-me').classList.add('score-leader');
    // Old XOR implementation: false ^ false = 0 -> class kept, wreath wrong.
    player_me.setWinning(false);
    return eval(expr);
  }, stateExpr);
  log({after_desync_repair: s});
  assert(!s.me, 'Desynced DOM wreath is removed by setWinning(false)');

  // 3) Repeated calls with the same value stay stable (idempotent).
  s = await page.evaluate((expr)=>{
    player_me.setWinning(true);
    player_me.setWinning(true);
    player_op.setWinning(false);
    player_op.setWinning(false);
    return eval(expr);
  }, stateExpr);
  log({idempotent_calls: s});
  assert(s.me && !s.op, 'Repeated setWinning calls do not flip the wreath');

  // 4) board.updateLeader() repairs any desync from real totals.
  s = await page.evaluate((expr)=>{
    player_me.winning = true;
    player_op.winning = true;
    document.getElementById('score-total-me').classList.remove('score-leader');
    document.getElementById('score-total-op').classList.add('score-leader');
    board.updateLeader();
    return eval(expr);
  }, stateExpr);
  log({update_leader_repairs: s});
  assert(s.me === (s.meTotal > s.opTotal) && s.op === (s.opTotal > s.meTotal),
    'updateLeader forces the DOM back in sync with the model');

  // 5) updateTotal drives the wreath to the actual leader, both directions.
  s = await page.evaluate((expr)=>{ player_me.updateTotal(100); return eval(expr); }, stateExpr);
  log({me_leads: s});
  assert(s.me && !s.op, 'Wreath on player_me when me leads');

  s = await page.evaluate((expr)=>{ player_op.updateTotal(200); return eval(expr); }, stateExpr);
  log({op_leads: s});
  assert(!s.me && s.op, 'Wreath moves to player_op when op leads');

  s = await page.evaluate((expr)=>{ player_op.updateTotal(-150); return eval(expr); }, stateExpr);
  log({back_to_me: s});
  assert(s.me && !s.op, 'Wreath moves back to player_me');

  s = await page.evaluate((expr)=>{ player_op.updateTotal(50); return eval(expr); }, stateExpr);
  log({tied: s});
  assert(!s.me && !s.op, 'Wreath cleared on tie');

  await browser.close();
  server.kill();
})();
