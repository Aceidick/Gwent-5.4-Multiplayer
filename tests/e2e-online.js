"use strict";
// Two real Chromium contexts against the bundled single-port server.
// Requires a system Chromium/Chrome and `npm install` (playwright-core is a dev dependency).
const { chromium } = require('playwright-core');
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const PORT = process.env.TEST_PORT || '18080';
const URL = `http://127.0.0.1:${PORT}`;
let failed = false;
function assert(v, label) { console.log(`${v?'PASS':'FAIL'} ${label}`); if (!v) failed = true; }
function chromePath() {
  for (const p of [process.env.CHROMIUM_PATH, 'C:/Program Files/Google/Chrome/Application/chrome.exe', 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', '/usr/bin/chromium', '/usr/bin/chromium-browser', '/usr/bin/google-chrome'])
    if (p && fs.existsSync(p)) return p;
  throw new Error('Chromium not found. Install it (apt install chromium) or set CHROMIUM_PATH.');
}
async function wait(page, fn, label, timeout=60000) {
  try { await page.waitForFunction(fn, null, {timeout}); return true; }
  catch (_) { console.log(`FAIL timeout: ${label}`); failed = true; return false; }
}
(async()=>{
  const server = spawn(process.execPath, [path.join(__dirname,'..','server','server.js')], {
    env:{...process.env, PORT}, cwd:path.join(__dirname,'..'), stdio:['ignore','pipe','pipe']
  });
  server.stdout.on('data', d=>process.stdout.write('[server] '+d));
  server.stderr.on('data', d=>process.stderr.write('[server] '+d));
  await new Promise(r=>setTimeout(r,800));
  const browser = await chromium.launch({headless:true, executablePath:chromePath(), args:['--no-sandbox']});
  const A = await (await browser.newContext({viewport:{width:1920,height:1080}})).newPage();
  const B = await (await browser.newContext({viewport:{width:1920,height:1080}})).newPage();
  const errs={A:[],B:[]};
  for (const [tag,p] of [['A',A],['B',B]]) {
    p.on('pageerror', e=>errs[tag].push(String(e)));
    p.on('dialog', async d=>{ errs[tag].push('DIALOG: '+d.message()); await d.dismiss(); });
  }
  await A.goto(URL); await B.goto(URL);
  await A.click('#button_start_friend'); await B.click('#button_start_friend');
  await wait(A,()=>typeof GwentOnline!=='undefined'&&typeof dm!=='undefined','host loaded');
  await wait(B,()=>typeof GwentOnline!=='undefined'&&typeof dm!=='undefined','guest loaded');
  assert(await A.evaluate(()=>GwentOnline.validateDeckRaw(GwentOnline.makeDeckRaw())), 'host default deck valid');
  assert(await B.evaluate(()=>GwentOnline.validateDeckRaw(GwentOnline.makeDeckRaw())), 'guest default deck valid');

  await A.click('#start-pvp-game'); await B.click('#start-pvp-game');
  await A.click('#online-create');
  await wait(A,()=>/^[2-9A-Z]{5}$/.test(document.getElementById('online-room-code').textContent),'room created');
  const code=(await A.textContent('#online-room-code')).trim();
  await B.fill('#online-code-input',code); await B.click('#online-join');
  await wait(B,()=>OnlineNet.role==='guest','guest joined');
  await A.click('#online-close'); await B.click('#online-close');
  await wait(A,()=>!document.getElementById('start-game').disabled,'host deck Start game enabled');
  await wait(B,()=>!document.getElementById('start-game').disabled,'guest deck Start game enabled');
  await A.click('#start-game'); await B.click('#start-game');
  await wait(A,()=>GwentOnline.active,'host match active'); await wait(B,()=>GwentOnline.active,'guest match active');
  await wait(A,()=>typeof Carousel!=='undefined'&&Carousel.curr,'host mulligan open');
  await wait(B,()=>typeof Carousel!=='undefined'&&Carousel.curr,'guest mulligan open');

  // Exercise asymmetry: host redraws one, guest redraws none.
  await A.evaluate(async()=>{ if (Carousel.curr) Carousel.curr.select(new Event('click')); });
  await A.waitForTimeout(150);
  await A.evaluate(()=>Carousel.curr&&Carousel.curr.cancel());
  await B.evaluate(()=>Carousel.curr&&Carousel.curr.cancel());
  await wait(A,()=>game.roundCount===1&&game.currPlayer,'host round 1');
  await wait(B,()=>game.roundCount===1&&game.currPlayer,'guest round 1');

  const SA=await A.evaluate(()=>({me:player_me.hand.cards.map(c=>c.key),op:player_op.hand.cards.map(c=>c.key),first:GwentOnline.roleOfPlayer(game.firstPlayer)}));
  const SB=await B.evaluate(()=>({me:player_me.hand.cards.map(c=>c.key),op:player_op.hand.cards.map(c=>c.key),first:GwentOnline.roleOfPlayer(game.firstPlayer)}));
  assert(JSON.stringify(SA.me)===JSON.stringify(SB.op),'host hand replicated exactly after mulligan');
  assert(JSON.stringify(SA.op)===JSON.stringify(SB.me),'guest hand replicated exactly after mulligan');
  assert(SA.first===SB.first,'both clients agree on first logical player');

  const first = SA.first==='host' ? A : B;
  const other = first===A ? B : A;
  await wait(first,()=>game.currPlayer===player_me && !document.querySelector('main').classList.contains('noclick'),'first local turn ready');
  // Keep the move reproducible instead of relying on a random opening hand
  // containing a weather card or an ability-free unit.
  for(const page of [A,B]) await page.evaluate(role=>{
    const owner=GwentOnline.playerOf(role);
    owner.hand.addCard(new Card('spe_clear',card_dict.spe_clear,owner));
  },SA.first);
  const played = await first.evaluate(async()=>{
    const c = player_me.hand.cards.find(x=>x.row==='weather') ||
      player_me.hand.cards.find(x=>x.isUnit() && ['close','ranged','siege'].includes(x.row) && x.abilities.length===0);
    if (!c) return null;
    const key=c.key; ui.selectCard(c);
    await ui.selectRow(c.row==='weather'?weather:board.getRow(c,c.row,player_me));
    return key;
  });
  assert(!!played,'first player can play a real card');
  if (played) {
    await wait(other,()=>game.currPlayer===player_me,'turn transferred to second player');
    // Clear Weather resolves into the discard pile instead of remaining in weather.
    const seen = await other.evaluate(key => key==='spe_clear'
      ? player_op.grave.cards.some(c=>c.key===key) && weather.cards.length===0
      : weather.cards.some(c=>c.key===key) || board.row.slice(0,3).some(r=>r.cards.some(c=>c.key===key)), played);
    assert(seen,`remote saw the same card (${played})`);
  }

  // Give up is match-level control: both browsers must reach the end screen,
  // with opposite win/loss results, regardless of whose turn is active.
  const quitter = other;
  const survivor = quitter===A ? B : A;
  await quitter.click('#giveup-button');
  await wait(quitter,()=>game.over && !document.getElementById('end-screen').classList.contains('hide'),'quitter end screen');
  await wait(survivor,()=>game.over && !document.getElementById('end-screen').classList.contains('hide'),'peer end screen after forfeit');
  const quitResult = await quitter.evaluate(()=>document.getElementById('end-screen').children[0].className);
  const surviveResult = await survivor.evaluate(()=>document.getElementById('end-screen').children[0].className);
  assert(/end-lose/.test(quitResult),'quitter sees loss after Give up');
  assert(/end-win/.test(surviveResult),'peer sees win after opponent Give up');
  assert(await quitter.isVisible('#end-screen button:nth-of-type(1)'),'quitter can access end-screen controls');
  assert(await survivor.isVisible('#end-screen button:nth-of-type(1)'),'peer can access end-screen controls');

  // Regression: a synchronized Replay after Give up must be a genuinely fresh
  // match on both peers. In particular, roundCount must return to 1 and the
  // authoritative logical first/current player must be identical, while only
  // one browser treats that current player as local.
  await A.locator('#end-screen button').nth(1).click();
  await B.locator('#end-screen button').nth(1).click();
  await wait(A,()=>GwentOnline.active && !game.over && typeof Carousel!=='undefined'&&Carousel.curr,'host rematch mulligan');
  await wait(B,()=>GwentOnline.active && !game.over && typeof Carousel!=='undefined'&&Carousel.curr,'guest rematch mulligan');
  await A.evaluate(()=>Carousel.curr&&Carousel.curr.cancel());
  await B.evaluate(()=>Carousel.curr&&Carousel.curr.cancel());
  await wait(A,()=>game.roundCount===1&&game.currPlayer,'host rematch round 1');
  await wait(B,()=>game.roundCount===1&&game.currPlayer,'guest rematch round 1');
  const RA=await A.evaluate(()=>({first:GwentOnline.roleOfPlayer(game.firstPlayer),curr:GwentOnline.roleOfPlayer(game.currPlayer),local:game.currPlayer===player_me,round:game.roundCount}));
  const RB=await B.evaluate(()=>({first:GwentOnline.roleOfPlayer(game.firstPlayer),curr:GwentOnline.roleOfPlayer(game.currPlayer),local:game.currPlayer===player_me,round:game.roundCount}));
  assert(RA.round===1&&RB.round===1,'rematch resets round counter');
  assert(RA.first===RB.first,'rematch peers agree on authoritative first player');
  assert(RA.curr===RB.curr,'rematch peers agree on current logical player');
  assert(RA.local!==RB.local,'exactly one peer owns the opening rematch turn');

  assert(errs.A.length===0,'no host JS/dialog errors'+(errs.A.length?': '+errs.A.join(' | '):''));
  assert(errs.B.length===0,'no guest JS/dialog errors'+(errs.B.length?': '+errs.B.join(' | '):''));

  await browser.close(); server.kill('SIGTERM');
  console.log(failed?'RESULT: FAILED':'RESULT: CORE ONLINE E2E PASS');
  process.exit(failed?1:0);
})().catch(e=>{ console.error('FATAL',e); process.exit(1); });
