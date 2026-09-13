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
  assert(await A.evaluate(async()=>{
    const net=GwentOnline;
    let nestedRestored=false;
    await net.withDecisionOwner(player_me,async()=>{
      const first=net.beginDecision('scope-test');
      await net.withDecisionOwner(player_op,async()=>{},'inner-test');
      const second=net.beginDecision('scope-test');
      nestedRestored=net.decisionOwner()===player_me && first.serial===0 && second.serial===1;
      await net.withDecisionOwner(player_op,async()=>{
        net.beginTurnDecisions();
        await net.withDecisionOwner(player_me,async()=>{},'new-turn-test');
      },'old-nested-test');
    },'old-turn-test');
    return nestedRestored && !net._decisionOwner && !net._effectContext && net._effectDecisionSerial===0;
  }),'nested scopes restore within their turn but cannot restore after handoff');

  async function settled(seq) {
    try {
      await Promise.all([A,B].map(p=>p.waitForFunction(seq=>GwentOnline._turnSeq===seq+1 && !GwentOnline._decisionOwner,seq,{timeout:60000})));
    } catch(error) {
      console.log('DIAGNOSTICS',JSON.stringify({errors:errs,states:await Promise.all([A,B].map(p=>p.evaluate(()=>({seq:GwentOnline._turnSeq,owner:GwentOnline.roleOfPlayer(GwentOnline._decisionOwner),preview:ui.previewCard?.key,rows:board.row.map(r=>r.cards.length),popup:!!Popup.curr,carousel:!!Carousel.curr}))))}));
      throw error;
    }
    await A.waitForTimeout(1400);
  }
  async function normalMove(label) {
    const role=await A.evaluate(()=>GwentOnline.roleOfPlayer(game.currPlayer));
    const seq=await A.evaluate(()=>GwentOnline._turnSeq);
    const local=role==='host'?A:B, remote=role==='host'?B:A;
    const enabled=await local.evaluate(()=>!document.querySelector('main').classList.contains('noclick'));
    assert(enabled,label+' next player input enabled');
    assert(await remote.evaluate(()=>document.querySelector('main').classList.contains('noclick')),label+' waiting player input disabled');
    if(!enabled) throw Error(label+': next turn started but main.noclick blocks real clicks');
    for(const p of [A,B]) await p.evaluate(role=>{
      const owner=GwentOnline.playerOf(role);
      const key=Object.keys(card_dict).find(k=>card_dict[k].row==='close'&&!card_dict[k].ability&&Number(card_dict[k].strength)>0&&!card_dict[k].hero);
      window.nextCard=new Card(key,card_dict[key],owner); owner.hand.addCard(nextCard);
      nextCard.elem.dataset.testNext='true'; board.getRow(nextCard,'close',owner).elem.dataset.testNextRow='true';
    },role);
    await local.locator('[data-test-next="true"]').click({timeout:5000});
    await local.waitForFunction(()=>ui.previewCard===nextCard);
    await local.locator('[data-test-next-row="true"]').click({position:{x:8,y:8},timeout:5000});
    await settled(seq);
    assert(await local.evaluate(()=>!player_me.hand.cards.includes(nextCard)),label+' next card played by actual clicks');
    const states=await Promise.all([A,B].map(p=>p.evaluate(()=>GwentOnline.syncState())));
    assert(JSON.stringify(states[0])===JSON.stringify(states[1]),label+' next move synchronized');
    for(const p of [A,B]) await p.evaluate(()=>document.querySelectorAll('[data-test-next],[data-test-next-row]').forEach(e=>{delete e.dataset.testNext;delete e.dataset.testNextRow;}));
  }
  for(const desiredRole of ['host','guest']) for(const leader of [
    'sc_francesca_pureblood','sc_francesca_hope_of_the_aen_seidhe',
    'wu_alzur_maker','lr_meve_princess','sy_carlo_varese','sy_cyrus_hemmelfart'
  ]) {
    if(await A.evaluate(()=>GwentOnline.roleOfPlayer(game.currPlayer))!==desiredRole) await normalMove('align actor');
    const local=desiredRole==='host'?A:B, remote=desiredRole==='host'?B:A;
    const seq=await A.evaluate(()=>GwentOnline._turnSeq);
    for(const p of [A,B]) await p.evaluate(async({leader,role})=>{
      // Independent board fixture: previous scenarios must not accumulate
      // dozens of tied scorch targets and unrelated row effects.
      for(const row of board.row) {
        for(const c of [...row.cards,...row.special.cards]) row.removeCard(c,false);
      }
      const actor=GwentOnline.playerOf(role);
      actor.replaceLeader(new Card(leader,card_dict[leader],actor));
      const owner=['sc_francesca_hope_of_the_aen_seidhe','wu_alzur_maker'].includes(leader)?actor:actor.opponent();
      const key=Object.keys(card_dict).find(k=>card_dict[k].row==='close'&&!card_dict[k].ability&&Number(card_dict[k].strength)>0&&!card_dict[k].hero);
      window.fixtureCards=[];
      for(let i=0;i<4;i++) {
        const c=new Card(key,card_dict[key],owner); await board.addCardToRow(c,'close',owner);
        c.elem.dataset.testFixture=String(i); fixtureCards.push(c);
      }
      fixtureCards[0].currentLocation.elem.dataset.testTarget='true';
      board.getRow(fixtureCards[0],'ranged',owner).elem.dataset.testDestination='true';
      board.updateScores();
    },{leader,role:desiredRole});
    await local.locator('#leader-me > :first-child').click();
    await local.locator('#carousel > :first-child > :nth-child(3)').click();
    if(leader.startsWith('sc_francesca')) {
      await local.waitForFunction(()=>ui.underRearrangement);
      assert(await remote.evaluate(()=>document.querySelector('main').classList.contains('noclick')),leader+' remote blocked during choice');
      const count=leader==='sc_francesca_pureblood'?3:4;
      for(let i=0;i<count;i++) {
        await local.locator('[data-test-fixture="'+i+'"]').click();
        await local.locator('[data-test-destination="true"]').click({position:{x:8,y:8}});
        await local.waitForFunction(()=>!GwentOnline._rearrangement?.busy);
      }
    } else {
      await local.waitForFunction(()=>!!GwentOnline._abilityTarget);
      assert(await remote.evaluate(()=>document.querySelector('main').classList.contains('noclick')),leader+' remote blocked during choice');
      if(leader==='wu_alzur_maker') await local.locator('[data-test-fixture="0"]').click();
      else await local.locator('[data-test-target="true"]').click({position:{x:8,y:8}});
    }
    await settled(seq);
    await normalMove(desiredRole+' '+leader);
    for(const p of [A,B]) await p.evaluate(()=>document.querySelectorAll('[data-test-fixture],[data-test-target],[data-test-destination]').forEach(e=>{delete e.dataset.testFixture;delete e.dataset.testTarget;delete e.dataset.testDestination;}));
  }
  assert(errs.A.length===0,'no host errors '+errs.A.join(' | '));
  assert(errs.B.length===0,'no guest errors '+errs.B.join(' | '));
  if(failed) throw Error('Regression assertions failed');
  console.log('RESULT: REAL CLICK TURN INPUT REGRESSIONS PASS');
})().catch(e=>{console.error('FATAL',e);process.exitCode=1;}).finally(async()=>{
  if(cleanupBrowser) await cleanupBrowser.close();
  if(cleanupServer) cleanupServer.kill();
});
