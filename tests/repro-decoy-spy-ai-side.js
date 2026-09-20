"use strict";
// Regression test for the AI Decoy side bug (PvE).
// Scenario from the bug report: the human plays a spy (Matta Hu'uri); the AI
// decoys it; the AI later replays the spy onto the human's half. When the AI
// then plays another Decoy, it must NOT be able to take a unit off the human's
// half, and the Decoy must be placed on the acting player's own half.
// Additionally verifies the classic (legal) decoy of a spy that sits on the
// AI's own half still works, and that a stale/no-longer-on-board target does
// not crash the AI turn.
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
  page.on('pageerror', e=>{ console.log('PAGE ERROR:', String(e)); process.exitCode = 1; });
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

  // ---------- Case 1: spy on the human's half must not be decoyed by the AI ----------
  let res = await page.evaluate(async ()=>{
    const wait = ms => new Promise(r=>setTimeout(r,ms));
    for (let i=0;i<200 && game.currPlayer!==player_me;i++) await wait(100);
    if (game.currPlayer!==player_me) return {error:'not my turn'};

    // AI replays its own spy (Matta): holder=AI so it lands on the human half
    const matta = new Card('ofir_matta', card_dict['ofir_matta'], player_op);
    player_op.hand.addCard(matta);
    await player_op.playCard(matta);
    await wait(600);
    const mattaRow = board.row.findIndex(r=>r.cards.includes(matta));
    if (mattaRow < 3) return {error:'setup: spy did not land on human half', mattaRow};

    // Human plays a unit (not pass) so the round continues and the AI acts
    const unit = player_me.hand.cards.find(c=>c.isUnit() && !c.abilities.includes('spy'));
    if (unit) { await player_me.playCard(unit); await wait(500); }
    for (let i=0;i<300 && game.currPlayer!==player_op;i++) await wait(100);
    if (game.currPlayer!==player_op) return {error:'not AI turn'};

    // AI plays a Decoy through the real path
    const decoy = new Card('spe_decoy', card_dict['spe_decoy'], player_op);
    player_op.hand.addCard(decoy);
    const ai = player_op.controller;
    const data = ai.getBoardData();
    await ai.playCard(decoy, ai.getMaximums(), data);
    await wait(800);

    const mattaStill = board.row.flatMap(r=>r.cards).find(c=>c.key==='ofir_matta');
    const decoyOnBoard = board.row.flatMap(r=>r.cards).find(c=>c.key==='spe_decoy');
    return {
      mattaRow: mattaStill ? board.row.indexOf(mattaStill.currentLocation) : null,
      mattaInAiHand: player_op.hand.cards.some(c=>c.key==='ofir_matta'),
      mattaInMyHand: player_me.hand.cards.some(c=>c.key==='ofir_matta'),
      decoyRow: decoyOnBoard ? board.row.indexOf(decoyOnBoard.currentLocation) : null
    };
  });
  log({case1_spy_on_human_half: res});
  if (res.error) { console.log('CASE1 SETUP FAIL: '+res.error); process.exitCode = 1; }
  else {
    assert(!res.mattaInAiHand && !res.mattaInMyHand, 'AI decoy cannot take a unit off the human half');
    assert(res.mattaRow === null || res.mattaRow >= 3, 'spy stays on the human half (or leaves legally)');
    assert(res.decoyRow !== null && res.decoyRow < 3, 'AI Decoy is placed on the AI half');
  }

  // ---------- Case 2: spy on the AI's own half can legally be decoyed ----------
  res = await page.evaluate(async ()=>{
    const wait = ms => new Promise(r=>setTimeout(r,ms));
    // Let the previous turn settle; start a fresh round if needed
    for (let i=0;i<300 && game.currPlayer!==player_me && !game.over;i++) { try { await wait(200); } catch(e){} }
    if (game.over) return {error:'game over'};
    for (let i=0;i<200 && game.currPlayer!==player_me;i++) await wait(100);
    if (game.currPlayer!==player_me) return {error:'not my turn c2'};

    // Human plays a spy -> lands on the AI half; top up the deck first so the
    // spy's own draw and the AI's later spy replay cannot empty the deck
    for (let i=0;i<4;i++) {
      const filler = new Card('ofir_chernobog', card_dict['ofir_chernobog'], player_me);
      player_me.deck.addCard(filler);
      const fillerOp = new Card('ofir_veles', card_dict['ofir_veles'], player_op);
      player_op.deck.addCard(fillerOp);
    }
    const matta2 = new Card('ofir_matta', card_dict['ofir_matta'], player_me);
    player_me.hand.addCard(matta2);
    await player_me.playCard(matta2);
    await wait(600);
    const spyRow = board.row.findIndex(r=>r.cards.includes(matta2));
    if (spyRow < 0 || spyRow > 2) return {error:'setup: spy did not land on AI half', spyRow};

    await player_me.passRound();
    for (let i=0;i<300 && game.currPlayer!==player_op;i++) await wait(100);
    if (game.currPlayer!==player_op) return {error:'not AI turn c2'};

    const decoy = new Card('spe_decoy', card_dict['spe_decoy'], player_op);
    player_op.hand.addCard(decoy);
    const ai = player_op.controller;
    await ai.playCard(decoy, ai.getMaximums(), ai.getBoardData());
    await wait(800);

    const inAiHand = player_op.hand.cards.some(c=>c.key==='ofir_matta');
    const decoyOnBoard = board.row.flatMap(r=>r.cards).find(c=>c.key==='spe_decoy');
    return {
      spyTakenToAiHand: inAiHand,
      decoyRow: decoyOnBoard ? board.row.indexOf(decoyOnBoard.currentLocation) : null
    };
  });
  log({case2_spy_on_ai_half: res});
  if (res.error) { console.log('CASE2 SETUP FAIL: '+res.error); }
  else {
    assert(res.spyTakenToAiHand, 'AI can still legally decoy a spy on its own half');
    assert(res.decoyRow !== null && res.decoyRow >= 0 && res.decoyRow < 3, 'Decoy replaces the taken unit row (AI half)');
  }

  // ---------- Case 3: stale target (not on any own row) must not crash ----------
  res = await page.evaluate(async ()=>{
    const wait = ms => new Promise(r=>setTimeout(r,ms));
    if (game.over) return {skipped:'game over'};
    for (let i=0;i<300 && game.currPlayer!==player_op;i++) { if (game.currPlayer===player_me && !player_me.passed) await player_me.passRound(); await wait(100); }
    if (game.currPlayer!==player_op) return {skipped:'no AI turn'};

    const ai = player_op.controller;
    const decoy = new Card('spe_decoy', card_dict['spe_decoy'], player_op);
    player_op.hand.addCard(decoy);
    const max = ai.getMaximums();
    const data = ai.getBoardData();
    // Simulate the reported bug state: the target data contains a spy that
    // sits on the HUMAN's half (as produced by a stale/raced board scan).
    // The AI decoy must refuse to take it and must place the Decoy on its own
    // half; a target that is not on any own row must not crash the turn.
    const ghost = new Card('ofir_matta', card_dict['ofir_matta'], player_me);
    const myRanged = board.row[4];
    myRanged.addCard(ghost);
    const poisoned = { spy: [ghost], medic: [], scorch: [], bond: {} };
    let crashed = false;
    let tookGhost = false;
    try {
      await ai.decoy(decoy, max, poisoned);
      await wait(400);
    } catch (e) { crashed = true; console.log('decoy threw: '+e); }
    tookGhost = player_op.hand.cards.includes(ghost);
    const ghostStillOnMyHalf = myRanged.cards.some(c=>c===ghost);
    const decoyOnBoard = board.row.flatMap(r=>r.cards).find(c=>c.key==='spe_decoy');
    return {
      crashed,
      tookGhost,
      ghostStillOnMyHalf,
      decoyRow: decoyOnBoard ? board.row.indexOf(decoyOnBoard.currentLocation) : null,
      aiTurnStillAlive: !!game.currPlayer
    };
  });
  log({case3_stale_target: res});
  if (res.error) { console.log('CASE3 SETUP FAIL: '+res.error); process.exitCode = 1; }
  else if (!res.skipped) {
    assert(!res.crashed, 'a decoy target off the AI half does not crash the AI turn');
    assert(!res.tookGhost && res.ghostStillOnMyHalf, 'AI decoy refuses to take a unit sitting on the human half (reported bug)');
    assert(res.decoyRow !== null && res.decoyRow < 3, 'Decoy falls back to the AI half without a valid target');
    assert(res.aiTurnStillAlive, 'game keeps running after the fallback');
  }

  await browser.close();
  server.kill();
})().catch(e=>{ console.error(e); process.exit(1); });
