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
let cleanupBrowser, cleanupServer;
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
  cleanupServer = server;
  server.stdout.on('data', d=>process.stdout.write('[server] '+d));
  server.stderr.on('data', d=>process.stderr.write('[server] '+d));
  await new Promise(r=>setTimeout(r,800));
  const browser = await chromium.launch({headless:true, executablePath:chromePath(), args:['--no-sandbox']});
  cleanupBrowser = browser;
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


  await A.waitForTimeout(2500);

  async function readyTurn() {
    await Promise.all([A,B].map(p=>p.waitForFunction(()=>game.roundCount===1&&!game.over&&game.currPlayer)));
    await A.waitForTimeout(1600);
  }
  async function rematch() {
    for(const p of [A,B]) {
      await p.locator('#end-screen button').nth(1).click({timeout:5000});
      assert(await p.evaluate(()=>GwentOnline.localReady),'Replay click readies player');
    }
    await Promise.all([A,B].map(p=>p.waitForFunction(()=>!game.over&&!!Carousel.curr)));
    for(const p of [A,B]) await p.evaluate(()=>Carousel.curr.cancel());
    await readyTurn();
  }
  async function customize() {
    for(const p of [A,B]) {
      await p.locator('#end-screen button').nth(0).click({timeout:5000});
      await p.waitForFunction(()=>!GwentOnline.active&&!document.querySelector('#deck-customization').classList.contains('hide'));
      assert(await p.evaluate(()=>document.querySelector('#end-screen').classList.contains('hide')),'Customize click opens deck builder');
    }
    for(const p of [A,B]) await p.locator('#start-game').click({timeout:5000});
    await Promise.all([A,B].map(p=>p.waitForFunction(()=>GwentOnline.active&&!game.over&&!!Carousel.curr)));
    for(const p of [A,B]) await p.evaluate(()=>Carousel.curr.cancel());
    await readyTurn();
  }
  await readyTurn();
  for(const role of ['host','guest']) for(const route of ['replay','customize']) for(const pendingChoice of [false,true]) {
    if(pendingChoice) {
      const actorRole=await A.evaluate(()=>GwentOnline.roleOfPlayer(game.currPlayer));
      for(const p of [A,B]) await p.evaluate(async role=>{
        const actor=GwentOnline.playerOf(role);
        actor.replaceLeader(new Card('sc_francesca_pureblood',card_dict.sc_francesca_pureblood,actor));
        const key=Object.keys(card_dict).find(k=>card_dict[k].row==='close'&&!card_dict[k].ability&&Number(card_dict[k].strength)>0&&!card_dict[k].hero);
        await board.addCardToRow(new Card(key,card_dict[key],actor.opponent()),'close',actor.opponent());
      },actorRole);
      const actor=actorRole==='host'?A:B;
      await actor.locator('#leader-me > :first-child').click();
      await actor.locator('#carousel > :first-child > :nth-child(3)').click();
      await Promise.all([A,B].map(p=>p.waitForFunction(()=>!!GwentOnline._rearrangement)));
    }
    const quitter=role==='host'?A:B;
    // Match-level protocol may arrive even while the other player owns input.
    await quitter.evaluate(()=>GwentOnline.concedeLocal());
    await Promise.all([A,B].map(p=>p.waitForFunction(()=>game.over&&!GwentOnline._forfeitEnding&&!document.querySelector('#end-screen').classList.contains('hide'))));
    await A.waitForTimeout(700);
    for(const [name,p] of [['host',A],['guest',B]]) {
      assert(await p.evaluate(()=>!document.querySelector('main').classList.contains('noclick')),name+' end screen accepts input after '+role+' forfeit '+route+' pending='+pendingChoice);
      assert(await p.evaluate(()=>!GwentOnline._rearrangement),'pending board interaction cleared');
      const result=await p.evaluate(()=>document.querySelector('#end-screen').firstElementChild.className);
      assert(result.includes(name===role?'end-lose':'end-win'),name+' correct forfeit result');
    }
    if(route==='replay') await rematch(); else await customize();
  }
  // Normal game completion must also unlock the end screen when the final
  // action is still bound to either player's decision context.
  for(const p of [A,B]) await p.evaluate(async()=>{
    player_op.health=0;
    await GwentOnline.withDecisionOwner(player_op,()=>game.endGame(),'test-final-action');
    ui.enablePlayer(false); // A late cleanup must not re-lock the menu.
  });
  await customize();
  assert(errs.A.length===0,'no host errors '+errs.A.join(' | '));
  assert(errs.B.length===0,'no guest errors '+errs.B.join(' | '));
  if(failed) throw Error('Regression assertions failed');
  console.log('RESULT: END SCREEN REAL CLICK REGRESSIONS PASS');
})().catch(e=>{console.error('FATAL',e);process.exitCode=1;}).finally(async()=>{
  if(cleanupBrowser) await cleanupBrowser.close();
  if(cleanupServer) cleanupServer.kill();
});
