"use strict";
// Reproduction for: AI plays Sly Seductress (ambush) onto the human's side;
// human plays Decoy on it -> which hand does the card end up in?
// Expectation (correct rules): the human's hand (the Decoy player takes the unit).
const { chromium } = require('playwright-core');
const { spawn } = require('child_process');
const path = require('path');
const PORT = process.env.TEST_PORT || '18085';
const URL = `http://127.0.0.1:${PORT}`;

function assert(v, label) { console.log(`${v?'PASS':'FAIL'} ${label}`); if (!v) process.exitCode = 1; }

(async()=>{
  const server = spawn(process.execPath, [path.join(__dirname,'..','server','server.js')],
    {env:{...process.env, PORT}, cwd:path.join(__dirname,'..'), stdio:['ignore','pipe','pipe']});
  await new Promise(r=>setTimeout(r,800));
  const browser = await chromium.launch({headless:true, executablePath:'/home/appuser/.cache/ms-playwright/chromium_headless_shell-1243/chrome-headless-shell-linux64/chrome-headless-shell', args:['--no-sandbox']});
  const page = await (await browser.newContext({viewport:{width:1920,height:1080}})).newPage();
  const pageErrors=[];
  page.on('pageerror', e=>{ pageErrors.push(String(e)); console.log('PAGE ERROR:', String(e)); });
  await page.goto(URL);
  await page.waitForFunction(()=>typeof dm!=='undefined'&&typeof premade_deck!=='undefined', null, {timeout:20000});
  await page.evaluate(()=>{
    const sk = premade_deck.find(d=>d.leader==='sk_holger') || premade_deck[0];
    dm.deckFromJSON(JSON.parse(JSON.stringify(sk)), false);
    dm.startNewGame(1);
  });
  await page.waitForFunction(()=>Carousel.curr, null, {timeout:10000});
  await page.evaluate(()=>Carousel.curr.cancel());
  await page.waitForFunction(()=>game.roundCount>=1 && player_me && player_op && !Carousel.curr, null, {timeout:20000});

  const result = await page.evaluate(async ()=>{
    const wait = ms => new Promise(r=>setTimeout(r,ms));
    // make sure it's the human's turn
    for (let i=0;i<120 && game.currPlayer!==player_me;i++) await wait(100);
    if (game.currPlayer!==player_me) return {error:'not my turn'};

    // Opponent (AI) "plays" Sly Seductress (novigrad ambush unit) onto MY side.
    const sly = new Card('nv_passiflora_1', card_dict['nv_passiflora_1'], player_op);
    const myRow = board.getRow(sly, 'close', player_op); // where a spy-like placement would go
    await board.moveTo(sly, myRow, null);

    // Give the human a Decoy and play it on the Sly Seductress through the UI path.
    const decoy = new Card('spe_decoy', card_dict['spe_decoy'], player_me);
    player_me.hand.addCard(decoy);
    board.updateScores();

    ui.showPreview(decoy);
    ui.lastRow = myRow;
    await ui.selectCard(sly);

    await wait(500);
    return {
      slyHolderIsMe: sly.holder === player_me,
      slyInMyHand: player_me.hand.cards.includes(sly),
      slyInOpHand: player_op.hand.cards.includes(sly),
      sylInMyHand_aiView: player_me.hand.cards.map(c=>c.key).includes('nv_passiflora_1'),
      decoyOnRow: myRow.cards.some(c=>c.key==='spe_decoy'),
      opHandKeys: player_op.hand.cards.map(c=>c.key).filter(k=>k==='nv_passiflora_1'),
      turnAfter: game.currPlayer === player_me ? 'me' : 'op'
    };
  });
  console.log(JSON.stringify(result, null, 2));
  assert(result.slyInMyHand, 'Sly Seductress ends in the Decoy player\'s (human) hand');
  assert(!result.slyInOpHand, 'Sly Seductress does NOT go back to the opponent\'s hand');
  assert(result.decoyOnRow, 'Decoy was placed on the row');
  if (result.error) { assert(false, 'test setup: '+result.error); }

  // Scenario 2: the human plays an ambush unit onto the AI's side; the AI
  // decoys it. The card must end up in the AI's (acting player's) hand.
  const result2 = await page.evaluate(async ()=>{
    const wait = ms => new Promise(r=>setTimeout(r,ms));
    const sly2 = new Card('nv_passiflora_1', card_dict['nv_passiflora_1'], player_me);
    const aiRow = board.getRow(sly2, 'close', player_me);
    await board.moveTo(sly2, aiRow, null);

    const decoy2 = new Card('spe_decoy', card_dict['spe_decoy'], player_op);
    player_op.hand.addCard(decoy2);
    board.updateScores();

    const ai = player_op.controller;
    const max = ai.getMaximums();
    const data = ai.getBoardData();
    await ai.decoy(decoy2, max, data);
    await wait(500);
    return {
      slyInAiHand: player_op.hand.cards.includes(sly2),
      slyInMyHand: player_me.hand.cards.includes(sly2),
      decoyOnAiRow: aiRow.cards.some(c=>c.key==='spe_decoy')
    };
  });
  console.log(JSON.stringify(result2, null, 2));
  assert(result2.slyInAiHand, 'AI decoy: ambush unit ends in the AI\'s (acting player\'s) hand');
  assert(!result2.slyInMyHand, 'AI decoy: ambush unit does NOT go back to the human\'s hand');
  assert(result2.decoyOnAiRow, 'AI decoy: Decoy placed on the AI row');

  await browser.close();
  server.kill();
})();
