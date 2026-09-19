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
  const emptyRole=await A.evaluate(()=>GwentOnline.roleOfPlayer(game.currPlayer));
  for(const page of [A,B]) await page.evaluate(role=>{
    const p=GwentOnline.playerOf(role);p.leader=new Card('wu_alzur_maker',card_dict.wu_alzur_maker,p);p.enableLeader();
  },emptyRole);
  const emptyLocal=emptyRole==='host'?A:B;
  assert(await emptyLocal.evaluate(async()=>await player_me.activateLeader()===false),'Alzur with no valid target returns without trapping input');
  await A.waitForTimeout(100);
  assert(await A.evaluate(()=>GwentOnline._turnSeq===0&&!GwentOnline._abilityTarget),'no-target action preserves the turn and clears its decision');
  // Each fixture installs the same logical state in opposite browser orientations.
  async function setup(leader, targetOpponent=true) {
    await A.waitForTimeout(900);
    const role = await A.evaluate(()=>GwentOnline.roleOfPlayer(game.currPlayer));
    const seq = await A.evaluate(()=>GwentOnline._turnSeq);
    for (const p of [A,B]) await p.evaluate(async ({leader,targetOpponent,role})=>{
      const actor=GwentOnline.playerOf(role);
      actor.leader = new Card(leader,card_dict[leader],actor);
      actor.enableLeader();
      const owner=targetOpponent ? actor.opponent() : actor;
      const key=Object.keys(card_dict).find(k=>card_dict[k].row==='close' && !card_dict[k].ability && Number(card_dict[k].strength)>0 && !card_dict[k].hero);
      window.fixtureCards=[];
      for(let i=0;i<4;i++) {
        const c=new Card(key,card_dict[key],owner);
        await board.addCardToRow(c,'close',owner);
        fixtureCards.push(c);
      }
      board.updateScores();
    },{leader,targetOpponent,role});
    return {local:role==='host'?A:B, remote:role==='host'?B:A, seq, role};
  }
  async function activate(t) {
    await t.local.evaluate(()=>{ window.actionDone=false; window.actionError=null;
      player_me.activateLeader().then(()=>window.actionDone=true,e=>window.actionError=String(e));
    });
  }
  async function committed(t,label) {
    await Promise.all([A,B].map(p=>p.waitForFunction(seq=>GwentOnline._turnSeq===seq+1, t.seq,{timeout:20000})));
    await Promise.all([A,B].map(p=>p.waitForFunction(()=>!GwentOnline._decisionOwner)));
    await t.remote.waitForFunction(()=>game.currPlayer===player_me && !document.querySelector('main').classList.contains('noclick'));
    assert(await t.local.evaluate(()=>document.querySelector('main').classList.contains('noclick')),label+' completed actor input disabled');
    assert(await t.remote.evaluate(()=>!GwentOnline._effectContext),label+' next turn has no old effect context');
    const states=await Promise.all([A,B].map(p=>p.evaluate(()=>GwentOnline.syncState())));
    assert(JSON.stringify(states[0])===JSON.stringify(states[1]),label+' identical public state');
    assert(await t.local.evaluate(()=>!window.actionError),label+' no action error');
    assert(await t.remote.evaluate(()=>!GwentOnline.queue.some(m=>['rearrange-card','rearrange-row','rearrange-end','ability-target','power-card'].includes(m.t))),label+' no leftover decisions');
  }
  for (const [leader,opponent,count,early] of [
    ['sc_francesca_pureblood',true,3,false],
    ['sc_francesca_pureblood',true,0,true],
    ['sc_francesca_pureblood',true,1,true],
    ['sc_francesca_hope_of_the_aen_seidhe',false,4,false]
  ]) {
    const t=await setup(leader,opponent); await activate(t);
    await Promise.all([t.local,t.remote].map(p=>p.waitForFunction(()=>ui.underRearrangement)));
    assert(await t.local.evaluate(()=>!document.querySelector('main').classList.contains('noclick')),'chooser can move '+leader);
    assert(await t.remote.evaluate(()=>document.querySelector('main').classList.contains('noclick')),'remote cannot move '+leader);
    assert(await t.remote.evaluate(()=>!!GwentOnline._effectContext),'parent action remains open '+leader);
    for(let i=0;i<count;i++) await t.local.evaluate(async i=>{
      await ui.selectCard(fixtureCards[i]);
      if(i===0) { await ui.selectRow(fixtureCards[i].currentLocation); await ui.selectCard(fixtureCards[i]); }
      await ui.selectRow(board.getRow(fixtureCards[i],'ranged',fixtureCards[i].holder));
    },i);
    if(early) await t.local.click('#arrangementWindow-button');
    await committed(t,leader+' moves='+count);
  }
  for(const leader of ['wu_alzur_maker','lr_meve_princess','sy_carlo_varese','sy_cyrus_hemmelfart']) {
    const t=await setup(leader,leader!=='wu_alzur_maker'); await activate(t);
    await Promise.all([t.local,t.remote].map(p=>p.waitForFunction(()=>!!GwentOnline._abilityTarget)));
    await t.local.evaluate(async leader=>{
      if(leader==='wu_alzur_maker') await ui.selectCard(fixtureCards[0]);
      else await ui.selectRow(fixtureCards[0].currentLocation);
    },leader);
    await committed(t,leader);
  }
  const factionTest=await setup('sc_francesca_hope_of_the_aen_seidhe',false);
  for(const p of [A,B]) await p.evaluate(role=>{
    const actor=GwentOnline.playerOf(role); actor.deck.faction='lyria_rivia'; actor.factionAbilityUses=1;
  },factionTest.role);
  await factionTest.local.evaluate(()=>{window.actionError=null; player_me.useFactionAbility().catch(e=>window.actionError=String(e));});
  await factionTest.local.waitForFunction(()=>!!GwentOnline._abilityTarget);
  await factionTest.local.evaluate(async()=>await ui.selectRow(fixtureCards[0].currentLocation,true));
  await committed(factionTest,'Lyria faction target');

  const power=await setup('sc_francesca_hope_of_the_aen_seidhe',false);
  for(const p of [A,B]) await p.evaluate(role=>{
    const owner=GwentOnline.playerOf(role); owner.capabilities.cardEdit=2;
    window.powerDone=false;
    GwentOnline.withDecisionOwner(owner,()=>ui.enableCardPowerEdit(owner,10),'test:power-edit')
      .then(()=>window.powerDone=true,e=>window.actionError=String(e));
  },power.role);
  await power.local.evaluate(()=>{ui.selectCard(fixtureCards[0]);});
  await power.local.waitForFunction(()=>!!NumberValuePopup.curr);
  assert(await power.local.evaluate(()=>{document.getElementById('number-popup-value').value='11';return NumberValuePopup.curr.done()===false;}),'power edit rejects values above the limit');
  await power.local.evaluate(()=>{document.getElementById('number-popup-value').value='10';NumberValuePopup.curr.done();});
  await Promise.all([A,B].map(p=>p.waitForFunction(()=>window.powerDone)));
  assert(await power.remote.evaluate(()=>fixtureCards[0].basePower===10),'power edit replayed');
  assert(await power.local.evaluate(()=>fixtureCards[0].basePower===10),'power edit local');
  assert(await A.evaluate(seq=>GwentOnline._turnSeq===seq,power.seq),'power edit does not end turn');

  const emhyr=await setup('ne_emhyr_invader_of_the_north',false);
  for(const p of [A,B]) await p.evaluate(()=>{
    for(const owner of [GwentOnline.playerOf('host'),GwentOnline.playerOf('guest')]) {
      const key=fixtureCards[0].key; owner.grave.addCard(new Card(key,card_dict[key],owner));
    }
  });
  await activate(emhyr);
  for(let i=0;i<2;i++) {
    await emhyr.local.waitForFunction(()=>!!Carousel.curr);
    await emhyr.local.evaluate(()=>{Carousel.curr.select(new Event('click'));});
    await emhyr.local.waitForFunction(()=>!!GwentOnline._continuationCard);
    await emhyr.local.evaluate(async()=>{
      const c=GwentOnline._continuationCard;
      await ui.selectRow(board.getRow(c,c.row,c.holder));
    });
  }
  await committed(emhyr,'Emhyr two grave choices and destinations');

  // Exercise Holger in the actual turn-end lifecycle, not only the editor API.
  const holger=await setup('sk_holger',false);
  for(const p of [A,B]) await p.evaluate(async role=>{
    const owner=GwentOnline.playerOf(role);
    await GwentOnline.withOwnedEffects(owner,'leader:sk_holger:placed',()=>ability_dict.holger_blakhand.placed(owner.leader));
    const key=fixtureCards[0].key; owner.hand.addCard(new Card(key,card_dict[key],owner));
  },holger.role);
  await holger.local.evaluate(()=>{
    const c=player_me.hand.cards.find(c=>c.key===fixtureCards[0].key);
    ui.selectCard(c);
    ui.selectRow(board.getRow(c,c.row,player_me)).catch(e=>window.actionError=String(e));
  });
  await holger.local.waitForFunction(()=>!!Popup.curr);
  await holger.local.evaluate(()=>Popup.curr.selectYes());
  await holger.local.waitForFunction(()=>ui.underCardPowerEdit);
  await holger.local.evaluate(()=>{ui.selectCard(fixtureCards[0]);});
  await holger.local.waitForFunction(()=>!!NumberValuePopup.curr);
  await holger.local.evaluate(()=>{document.getElementById('number-popup-value').value='0';NumberValuePopup.curr.done();});
  await committed(holger,'Holger turn-end selection');
  assert(await holger.remote.evaluate(()=>fixtureCards[0].basePower===0),'Holger zero strength replicated');
  const interrupted=await setup('sc_francesca_pureblood',true);
  await activate(interrupted);
  await interrupted.local.waitForFunction(()=>ui.underRearrangement);
  await interrupted.local.evaluate(()=>GwentOnline.concedeLocal());
  await Promise.all([A,B].map(p=>p.waitForFunction(()=>game.over)));
  assert(await interrupted.remote.evaluate(()=>!ui.underRearrangement && !GwentOnline._rearrangement),'forfeit cancels pending rearrangement on peer');
  // Exercise the real rematch handshake after cancelling an open decision.
  await A.evaluate(()=>game.restartGame());
  await B.evaluate(()=>game.restartGame());
  await Promise.all([A,B].map(p=>p.waitForFunction(()=>!!Carousel.curr)));
  await A.evaluate(()=>Carousel.curr.cancel()); await B.evaluate(()=>Carousel.curr.cancel());
  await Promise.all([A,B].map(p=>p.waitForFunction(()=>game.roundCount===1 && !game.over)));
  assert(await A.evaluate(()=>!GwentOnline._rearrangement && !GwentOnline._abilityTarget && !GwentOnline._powerEdit),'rematch has no stale board decision');
  // Regression: leader-edited temporary strength (Holger an Dimun: Blackhand)
  // must count toward the round score before reverting (Kambi 0->10 must beat
  // a passing opponent). Both peers build the same fixture in lockstep.
  {
    await Promise.all([A,B].map(p=>p.waitForFunction(()=>game.roundCount===1&&!!game.currPlayer&&!GwentOnline._decisionOwner&&!GwentOnline._effectContext&&!GwentOnline.queue.length,null,{timeout:30000})));
    await new Promise(r=>setTimeout(r,800));
    const hostMoves=await Promise.all([A,B].map(p=>p.evaluate(()=>game.currPlayer===player_me)));
    const hostMovesStable=hostMoves[0]===hostMoves[1]&&hostMoves[0];
    const starter=hostMovesStable?A:B, responder=hostMovesStable?B:A;
    const starterRole=hostMovesStable?'host':'guest';
    for(const p of [A,B]) await p.evaluate(async role=>{
      const actor=GwentOnline.playerOf(role);
      for(const row of board.row)
        for(const c of row.cards.filter(c=>!c.noRemove).slice())
          await board.toGrave(c,row,true);
      const kambiCard=new Card('sk_kambi',card_dict.sk_kambi,actor);
      kambiCard.locked=true;
      await board.addCardToRow(kambiCard,'close',actor);
      kambiCard.originalBasePower=kambiCard.basePower;
      kambiCard.basePower=10;
      kambiCard.temporaryPower=true;
      board.updateScores();
    },starterRole);
    await Promise.all([A,B].map(p=>p.waitForFunction(()=>board.row.some(r=>r.cards.some(c=>c.key==='sk_kambi'&&c.basePower===10))&&player_me.total+player_op.total===10,'kambi fixture settled')));
    assert(await starter.evaluate(()=>player_me.total===10&&player_op.total===0),'edited temporary strength counts toward the player total');
    const seq=await A.evaluate(()=>GwentOnline._turnSeq);
    await starter.evaluate(()=>{ player_me.passRound(); });
    await Promise.all([A,B].map(p=>p.waitForFunction(sq=>GwentOnline._turnSeq===sq+1,seq,{timeout:20000})));
    await responder.waitForFunction(()=>game.currPlayer===player_me&&!GwentOnline._sendingSuppressed,null,{timeout:20000});
    await responder.waitForTimeout(250);
    await responder.evaluate(()=>{ player_me.passRound(); });
    await Promise.all([A,B].map(p=>p.waitForFunction(()=>game.roundCount===2,{timeout:30000})));
    assert(await starter.evaluate(()=>game.roundHistory.at(-1).winner===player_me&&game.roundHistory.at(-1).score_me===10&&game.roundHistory.at(-1).score_op===0),'edited temporary strength wins the round with the edited score');
    assert(await responder.evaluate(()=>game.roundHistory.at(-1).winner===player_op),'round winner matches on the responding peer');
    assert(await starter.evaluate(()=>player_me.grave.cards.some(c=>c.key==='sk_kambi'&&c.basePower===0&&!c.temporaryPower)&&player_me.getAllRowCards().every(c=>c.key!=='sk_kambi'||c.basePower===0)),'temporary strength reverted after round scoring');
  }
  assert(errs.A.length===0,'no host errors '+errs.A.join(' | '));
  assert(errs.B.length===0,'no guest errors '+errs.B.join(' | '));
  if(failed) throw Error('Regression assertions failed');
  console.log('RESULT: BOARD DECISION REGRESSIONS PASS');
})().catch(e=>{console.error('FATAL',e);process.exitCode=1;}).finally(async()=>{
  if(cleanupBrowser) await cleanupBrowser.close();
  if(cleanupServer) cleanupServer.kill();
});

