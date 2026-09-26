"use strict";
// Reproduction for the follow-up report: after the human decoys the AI's
// Sly Seductress (ambush) off the human's row, the row keeps a ghost
// ambush flag, and when the AI later plays a spy on that row the Decoy
// itself is picked as the "ambush" target: the human draws 2 cards and
// the Decoy is sent to the grave.
const { chromium } = require('playwright-core');
const { spawn } = require('child_process');
const path = require('path');
const PORT = process.env.TEST_PORT || '18086';
const URL = `http://127.0.0.1:${PORT}`;

function assert(v, label) { console.log(`${v?'PASS':'FAIL'} ${label}`); if (!v) process.exitCode = 1; }
const wait = ms => new Promise(r=>setTimeout(r,ms));

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
    for (let i=0;i<120 && game.currPlayer!==player_me;i++) await wait(100);
    if (game.currPlayer!==player_me) return {error:'not my turn'};

    // AI plays Sly Seductress (ambush) onto MY close row
    const sly = new Card('nv_passiflora_1', card_dict['nv_passiflora_1'], player_op);
    const myRow = board.getRow(sly, 'close', player_op);
    await board.moveTo(sly, myRow, null);
    await wait(300);

    const ambushFlagBefore = myRow.effects.ambush;

    // I decoy it
    const decoy = new Card('spe_decoy', card_dict['spe_decoy'], player_me);
    player_me.hand.addCard(decoy);
    ui.showPreview(decoy);
    ui.lastRow = myRow;
    await ui.selectCard(sly);
    await wait(500);

    const ambushFlagAfterDecoy = myRow.effects.ambush;
    const decoyStillOnRow = myRow.cards.some(c=>c.key==='spe_decoy');

    // Now the AI plays a spy onto that row (spy placed on opponent side flips holder to me)
    const myHandBefore = player_me.hand.cards.length;
    const spy = new Card('nr_stennis', card_dict['nr_stennis'], player_op); // any spy unit
    await board.moveTo(spy, board.getRow(spy, 'close', player_op), null);
    await wait(500);

    const drewTwo = player_me.hand.cards.length - myHandBefore; // spy itself is on the row, not in hand
    const decoyAfterSpy = myRow.cards.some(c=>c.key==='spe_decoy');
    const decoyInMyGrave = player_me.grave.cards.some(c=>c.key==='spe_decoy');
    const spyStillOnRow = myRow.cards.includes(spy);

    return {
      error: null,
      ambushFlagBefore, ambushFlagAfterDecoy, decoyStillOnRow,
      drewTwo, decoyAfterSpy, decoyInMyGrave, spyStillOnRow
    };
  });
  console.log(JSON.stringify(result, null, 2));
  if (result.error) { assert(false, 'setup: '+result.error); }
  else {
    assert(result.ambushFlagBefore === true, 'ambush flag set while Sly Seductress is on the row');
    assert(result.ambushFlagAfterDecoy === false, 'ghost ambush flag cleared after the ambush unit is decoyed away');
    assert(result.decoyStillOnRow === true, 'Decoy placed on the row after the swap');
    assert(result.drewTwo === 0, 'later spy on the row does not draw 2 cards for the human');
    assert(result.decoyAfterSpy === true, 'Decoy is NOT consumed as a fake ambush target');
    assert(result.decoyInMyGrave === false, 'Decoy did not go to the grave');
    assert(result.spyStillOnRow === true, 'spy stays on the row');
  }

  // Positive control: a real ambush still triggers correctly when the
  // opponent plays a unit on the ambushed row (owner draws 2, ambush to grave).
  const result2 = await page.evaluate(async ()=>{
    const wait = ms => new Promise(r=>setTimeout(r,ms));
    // AI plays a fresh Sly Seductress on my close row
    const sly2 = new Card('nv_passiflora_1', card_dict['nv_passiflora_1'], player_op);
    const myRow = board.getRow(sly2, 'close', player_op);
    await board.moveTo(sly2, myRow, null);
    await wait(300);
    // I play a unit on that row
    const aiHandBefore = player_op.hand.cards.length;
    const unit = new Card('sk_shield_maiden_2', card_dict['sk_shield_maiden_2'], player_me);
    await board.moveTo(unit, myRow, null);
    await wait(500);
    return {
      drewTwo: player_op.hand.cards.length - aiHandBefore,
      ambushToGrave: player_op.grave.cards.some(c=>c.key==='nv_passiflora_1'),
      ambushFlagCleared: myRow.effects.ambush === false,
      unitStillOnRow: myRow.cards.includes(unit)
    };
  });
  console.log(JSON.stringify(result2, null, 2));
  assert(result2.drewTwo === 2, 'real ambush: owner still draws 2 cards when triggered');
  assert(result2.ambushToGrave === true, 'real ambush: ambush unit goes to the grave when triggered');
  assert(result2.ambushFlagCleared === true, 'real ambush: flag cleared after trigger');
  assert(result2.unitStillOnRow === true, 'real ambush: triggering unit stays on the row');

  await browser.close();
  server.kill();
})();
