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
  const A = await (await browser.newContext()).newPage();
  const B = await (await browser.newContext()).newPage();
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
  const role=await A.evaluate(()=>GwentOnline.roleOfPlayer(game.currPlayer));
  const local=role==='host'?A:B, remote=role==='host'?B:A;
  for(const picks of [2,1,0]) {
    for(const page of [A,B]) await page.evaluate(({role,picks})=>{
      const owner=GwentOnline.playerOf(role);
      const key=Object.keys(card_dict).find(k=>card_dict[k].row==='close'&&!card_dict[k].ability&&Number(card_dict[k].strength)>0);
      window.testChoices=[]; window.testDone=false; window.testError=null;
      const pool=new CardContainer(); const children=new CardContainer();
      for(let i=0;i<3;i++) {const c=new Card(key,card_dict[key],owner);pool.addCard(c);}
      children.addCard(new Card(key,card_dict[key],owner));
      window.testPool=pool;
      GwentOnline.withDecisionOwner(owner,async()=>{
        await ui.queueCarousel(pool,2,async(container,index)=>{
          const selected=container.cards[index];
          testChoices.push(pool.cards.indexOf(selected));
          pool.removeCard(selected);
          await ui.queueCarousel(children,1,()=>{testChoices.push('child');},()=>true,false,false,'Nested child');
        },()=>true,false,true,'Parent with duplicate cards');
        window.testDone=true;
      },'test:nested:'+picks).catch(e=>window.testError=String(e));
    },{role,picks});
    await local.waitForFunction(()=>Carousel.curr?.title==='Parent with duplicate cards');
    for(let i=0;i<picks;i++) {
      await local.evaluate(()=>{Carousel.curr.select(new Event('click'));});
      if(i<picks-1) await local.waitForFunction(()=>Carousel.curr&&!Carousel.curr.busy);
    }
    if(picks<2) {
      await local.waitForFunction(()=>Carousel.curr&&!Carousel.curr.busy);
      await local.evaluate(()=>{Carousel.curr.cancel();});
    }
    for(let i=0;i<picks;i++) {
      await local.waitForFunction(()=>Carousel.curr?.title==='Nested child'&&!Carousel.curr.busy);
      assert(await local.evaluate(()=>!testDone),'parent waits for nested child');
      await local.evaluate(()=>{Carousel.curr.select(new Event('click'));});
      await local.waitForTimeout(120);
    }
    await Promise.all([A,B].map(p=>p.waitForFunction(()=>testDone||testError)));
    const results=await Promise.all([A,B].map(p=>p.evaluate(()=>({done:testDone,error:testError,choices:testChoices,left:testPool.cards.length}))));
    if(JSON.stringify(results[0])!==JSON.stringify(results[1])) console.log('DIVERGENT RESULTS',JSON.stringify(results));
    assert(results.every(r=>r.done&&!r.error),'nested/partial transaction completes, picks='+picks);
    assert(JSON.stringify(results[0])===JSON.stringify(results[1]),'identical duplicate-card commits, picks='+picks);
    assert(results[0].left===3-picks,'early exit commits only the selected cards');
    assert(await remote.evaluate(()=>!GwentOnline.queue.some(m=>m.t.startsWith('choice'))),'no stale carousel packets');
  }
  const seqBefore=await remote.evaluate(()=>GwentOnline._decisionSerial);
  await local.evaluate(()=>{window.inspectDone=false;ui.viewCardsInContainer(testPool).then(()=>inspectDone=true);});
  await local.waitForFunction(()=>!!Carousel.curr);
  await local.evaluate(()=>{Carousel.curr.cancel();});
  await local.waitForFunction(()=>inspectDone);
  assert(await remote.evaluate(seq=>GwentOnline._decisionSerial===seq&&!GwentOnline.queue.some(m=>m.t.startsWith('choice')),seqBefore),'read-only inspection sends no gameplay decisions');
  for(const page of [A,B]) {
    assert(await page.evaluate(async()=>{
      const items=[1,2,3], seen=[];let active=0,max=0;
      await resolveInOrder(items,async item=>{active++;max=Math.max(max,active);items.pop();await Promise.resolve();seen.push(item);active--;});
      return max===1 && seen.join(',')==='1,2,3';
    }),'effect batches finish sequentially from a snapshot');
    assert(await page.evaluate(async role=>{
      const owner=GwentOnline.playerOf(role), key=testPool.cards[0].key;
      const token=new Card(key,card_dict[key],owner);token.banishFromGrave=true;
      const before=owner.grave.cards.slice();
      await board.moveTo(token,owner.grave);
      return !owner.grave.cards.includes(token)&&before.every(c=>owner.grave.cards.includes(c));
    },role),'temporary token removed before move completes without removing other grave cards');
  }
  const randomResults=await Promise.all([A,B].map(page=>page.evaluate(()=>{
    GwentOnline.seedAll(123456);
    const pool=new CardContainer(); pool.cards=Array.from({length:10},(_,i)=>({key:String(i)}));
    return {picks:pool.findCardsRandom(()=>true,5).map(c=>c.key), next:GwentOnline.random()};
  })));
  assert(JSON.stringify(randomResults[0])===JSON.stringify(randomResults[1]),'random subset and next RNG value match across peers');
  // A failed action rejects its caller instead of leaving the carousel pending.
  await local.evaluate(()=>{
    GwentOnline.active=false;
    window.failureCaught=false;
    ui.queueCarousel(testPool,1,async()=>{throw new Error('expected test failure');},()=>true,false,false,'Failure test')
      .catch(e=>window.failureCaught=e.message==='expected test failure');
  });
  await local.waitForFunction(()=>Carousel.curr?.title==='Failure test');
  await local.evaluate(()=>{Carousel.curr.select(new Event('click'));});
  await local.waitForFunction(()=>failureCaught);
  assert(await local.evaluate(()=>!Carousel.curr),'failed callback releases visible carousel');
  await local.evaluate(async()=>{
    game.mode=3;
    const key=testPool.cards[0].key;
    window.offlineCard=new Card(key,card_dict[key],player_op);
    await board.addCardToRow(offlineCard,'close',player_op);
    window.offlineDone=false;
    ability_dict.francesca_pureblood.activated({holder:player_me}).then(()=>offlineDone=true);
  });
  await local.waitForFunction(()=>ui.underRearrangement);
  await local.evaluate(async()=>{
    await ui.selectCard(offlineCard);
    await ui.selectRow(board.getRow(offlineCard,'ranged',player_op));
    await ui.finishBoardRearrangement(true);
  });
  await local.waitForFunction(()=>offlineDone);
  assert(await local.evaluate(()=>offlineCard.currentLocation===board.getRow(offlineCard,'ranged',player_op)&&!ui.underRearrangement),'offline Francesca uses the same awaited movement lifecycle');
  assert(errs.A.length===0,'no host browser errors '+errs.A.join('|'));
  assert(errs.B.length===0,'no guest browser errors '+errs.B.join('|'));
  if(failed) throw Error('Carousel regression failed');
  console.log('RESULT: CAROUSEL REGRESSIONS PASS');
})().catch(e=>{console.error('FATAL',e);process.exitCode=1;}).finally(async()=>{
  if(cleanupBrowser) await cleanupBrowser.close();
  if(cleanupServer) cleanupServer.kill();
});
