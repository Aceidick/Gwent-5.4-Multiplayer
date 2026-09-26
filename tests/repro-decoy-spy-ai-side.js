"use strict";
// Regression test for the AI Decoy side bug (PvE).
// Bug report: the human plays a spy (Matta Hu'uri); the AI decoys it; the AI
// later replays the spy onto the human's half. When the AI then plays another
// Decoy it takes the spy off the HUMAN's half while the Decoy itself is placed
// on the AI half. A Decoy may only swap a unit on the acting player's own half.
// The AI's automatic turn logic is disabled so the tested actions are
// deterministic; each case drives the AI decoy path directly.
const { chromium } = require('playwright-core');
const { spawn } = require('child_process');
const path = require('path');
const PORT = process.env.TEST_PORT || '18092';
const URL = `http://127.0.0.1:${PORT}`;

function assert(v, label) { console.log(`${v?'PASS':'FAIL'} ${label}`); if (!v) process.exitCode = 1; }
const log = o => console.log(JSON.stringify(o));

(async()=>{
  const server = spawn(process.execPath, [path.join(__dirname,'..','server','server.js')],
    {env:{...process.env, PORT}, cwd:path.join(__dirname,'..'), stdio:['ignore','pipe','pipe']});
  await new Promise(r=>setTimeout(r,800));
  const browser = await chromium.launch({headless:true, executablePath:'/home/appuser/.cache/ms-playwright/chromium_headless_shell-1223/chrome-headless-shell-linux64/chrome-headless-shell', args:['--no-sandbox']});
  const page = await (await browser.newContext({viewport:{width:1920,height:1080}})).newPage();
  page.on('pageerror', e=>{ console.log('PAGE ERROR:', String(e)); });
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

  // Deterministic environment: stock the decks, silence notifications and
  // disable the AI's automatic startTurn for the whole test.
  await page.evaluate(()=>{
    for (let i=0;i<8;i++) {
      player_me.deck.addCard(new Card('ofir_chernobog', card_dict['ofir_chernobog'], player_me));
      player_op.deck.addCard(new Card('ofir_veles', card_dict['ofir_veles'], player_op));
    }
    window.__origStartTurn = player_op.controller.startTurn;
    window.__origNotif = ui.notification;
    player_op.controller.startTurn = async () => {};
    ui.notification = async () => {};
    game.currPlayer = player_me;
  });

  const rowOf = c => c && c.currentLocation && board.row.includes(c.currentLocation) ? board.row.indexOf(c.currentLocation) : null;

  // ---------- Case 1: classic legal counter - human spy on the AI half ----------
  let res = await page.evaluate(async ()=>{
    const matta = new Card('ofir_matta', card_dict['ofir_matta'], player_me);
    player_me.hand.addCard(matta);
    await player_me.playCard(matta);
    return { mattaRow: board.row.findIndex(r=>r.cards.includes(matta)), holder: matta.holder.tag };
  });
  log({case1_setup: res});
  if (res.error || res.mattaRow < 0 || res.mattaRow > 2) { console.log('CASE1 SETUP FAIL: '+JSON.stringify(res)); process.exitCode = 1; }
  else {
    res = await page.evaluate(async ()=>{
      game.currPlayer = player_op;
      const decoy = new Card('spe_decoy', card_dict['spe_decoy'], player_op);
      player_op.hand.addCard(decoy);
      const ai = player_op.controller;
      await ai.playCard(decoy, ai.getMaximums(), ai.getBoardData());
      const matta = board.row.flatMap(r=>r.cards).find(c=>c.key==='ofir_matta');
      const decoyOnBoard = board.row.flatMap(r=>r.cards).find(c=>c.key==='spe_decoy');
      return {
        mattaInAiHand: player_op.hand.cards.some(c=>c.key==='ofir_matta'),
        mattaRow: matta ? board.row.indexOf(matta.currentLocation) : null,
        decoyRow: decoyOnBoard ? board.row.indexOf(decoyOnBoard.currentLocation) : null
      };
    });
    log({case1_ai_decoy: res});
    assert(res.mattaInAiHand, 'AI can legally decoy a spy sitting on its own half');
    assert(res.decoyRow !== null && res.decoyRow >= 0 && res.decoyRow < 3, 'Decoy replaces the taken unit on the AI half');
  }

  // ---------- Case 2: AI replayed spy sits on the human half - must NOT be taken ----------
  res = await page.evaluate(async ()=>{
    const matta = player_op.hand.cards.find(c=>c.key==='ofir_matta');
    if (!matta) return {error:'Matta not in AI hand'};
    game.currPlayer = player_op;
    await player_op.playCard(matta);
    return { mattaRow: board.row.findIndex(r=>r.cards.includes(matta)), holder: matta.holder.tag };
  });
  log({case2_setup: res});
  if (res.error || res.mattaRow < 3) { console.log('CASE2 SETUP FAIL: '+JSON.stringify(res)); process.exitCode = 1; }
  else {
    res = await page.evaluate(async ()=>{
      game.currPlayer = player_op;
      const decoy = new Card('spe_decoy', card_dict['spe_decoy'], player_op);
      player_op.hand.addCard(decoy);
      const ai = player_op.controller;
      await ai.playCard(decoy, ai.getMaximums(), ai.getBoardData());
      const matta = board.row.flatMap(r=>r.cards).find(c=>c.key==='ofir_matta');
      const decoyOnBoard = board.row.flatMap(r=>r.cards).find(c=>c.key==='spe_decoy');
      return {
        mattaInAiHand: player_op.hand.cards.some(c=>c.key==='ofir_matta'),
        mattaRow: matta ? board.row.indexOf(matta.currentLocation) : null,
        decoyRow: decoyOnBoard ? board.row.indexOf(decoyOnBoard.currentLocation) : null
      };
    });
    log({case2_ai_decoy: res});
    assert(!res.mattaInAiHand, 'AI decoy cannot take a unit off the human half (reported bug)');
    assert(res.mattaRow !== null && res.mattaRow >= 3, 'the spy stays on the human half');
    assert(res.decoyRow !== null && res.decoyRow < 3, 'AI Decoy is placed on the AI half');
  }

  // ---------- Case 3: target data pointing at the human half must be refused ----------
  res = await page.evaluate(async ()=>{
    game.currPlayer = player_op;
    const ai = player_op.controller;
    const decoy = new Card('spe_decoy', card_dict['spe_decoy'], player_op);
    player_op.hand.addCard(decoy);
    const max = ai.getMaximums();
    // Force target data containing a spy that sits on the HUMAN's half,
    // reproducing the reported bug state (stale/raced board scan).
    const ghost = new Card('ofir_matta', card_dict['ofir_matta'], player_me);
    const myRanged = board.row[4];
    myRanged.addCard(ghost);
    const poisoned = { spy: [ghost], medic: [], scorch: [], bond: {} };
    let crashed = false;
    try { await ai.decoy(decoy, max, poisoned); } catch (e) { crashed = true; console.log('decoy threw: '+e); }
    const tookGhost = player_op.hand.cards.includes(ghost);
    const ghostStillOnMyHalf = myRanged.cards.includes(ghost);
    const decoyOnBoard = board.row.flatMap(r=>r.cards).find(c=>c.key==='spe_decoy');
    return {
      crashed,
      tookGhost,
      ghostStillOnMyHalf,
      decoyRow: decoyOnBoard ? board.row.indexOf(decoyOnBoard.currentLocation) : null,
      alive: !!game.currPlayer
    };
  });
  log({case3_poisoned_target: res});
  if (res.error) { console.log('CASE3 SETUP FAIL: '+res.error); process.exitCode = 1; }
  else {
    assert(!res.crashed, 'a decoy target off the AI half does not crash the AI turn');
    assert(!res.tookGhost && res.ghostStillOnMyHalf, 'AI decoy refuses a target sitting on the human half (reported bug)');
    assert(res.decoyRow !== null && res.decoyRow < 3, 'Decoy falls back to the AI half without a valid target');
    assert(res.alive, 'game keeps running after the fallback');
  }

  // Restore the stubbed functions before teardown
  await page.evaluate(()=>{
    player_op.controller.startTurn = window.__origStartTurn;
    ui.notification = window.__origNotif;
  });

  await browser.close();
  server.kill();
})().catch(e=>{ console.error(e); process.exit(1); });
