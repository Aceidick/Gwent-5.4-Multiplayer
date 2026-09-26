"use strict";
// Reproduction for: Novigrad leader "Sigismund Dijkstra, the Shrewd"
// (novigrad_sigismund: once per game, prevent the first death of a friendly
// unit) must NOT protect an Ambush card when the ambush triggers and the card
// removes itself to the discard pile. The ambush resolving is not a "death".
// Buggy behavior: board.toGrave() applies the Sigismund death-prevention to
// any unit leaving a Row, including the ambush card resolving itself, so the
// ambush stays on the row and the once-per-game prevention is burned.
// Intended behavior: the ambush card goes to the grave and the leader
// prevention stays available.
// Additionally: the leader prevention is now a choice - the human player is
// asked (Save it / Let it die) and only consumes the once-per-game use when
// the save is accepted; declining lets the unit die and keeps the use.
const { chromium } = require('playwright-core');
const { spawn } = require('child_process');
const path = require('path');
const PORT = process.env.TEST_PORT || '18099';
let failed = false;
function assert(v, label) { console.log(`${v?'PASS':'FAIL'} ${label}`); if (!v) failed = true; }
function chromePath() {
  for (const p of [process.env.CHROMIUM_PATH,
    ...(fs.existsSync('/home/appuser/.cache/ms-playwright') ? fs.readdirSync('/home/appuser/.cache/ms-playwright')
      .filter(d=>d.startsWith('chromium_headless_shell'))
      .map(d=>`/home/appuser/.cache/ms-playwright/${d}/chrome-headless-shell-linux64/chrome-headless-shell`) : [])])
    if (p && fs.existsSync(p)) return p;
  throw new Error('Chromium not found. Install it or set CHROMIUM_PATH.');
}
const fs = require('fs');
(async()=>{
  const server = spawn(process.execPath, [path.join(__dirname,'..','server','server.js')],
    {env:{...process.env, PORT}, cwd:path.join(__dirname,'..'), stdio:['ignore','pipe','pipe']});
  await new Promise(r=>setTimeout(r,800));
  const browser = await chromium.launch({headless:true, executablePath:chromePath(), args:['--no-sandbox']});
  const page = await (await browser.newContext({viewport:{width:1920,height:1080}})).newPage();
  page.on('pageerror', e=>{ console.log('PAGE ERROR:', String(e)); failed = true; });
  await page.goto(`http://127.0.0.1:${PORT}`);
  await page.waitForFunction(()=>typeof dm!=='undefined'&&typeof premade_deck!=='undefined', null, {timeout:20000});
  await page.evaluate(()=>{
    const nv = premade_deck.find(d=>d.faction==='novigrad' && d.leader==='nv_sigismund');
    dm.deckFromJSON(JSON.parse(JSON.stringify(nv)), false);
    dm.startNewGame(1);
  });
  await page.waitForFunction(()=>Carousel.curr, null, {timeout:10000});
  await page.evaluate(()=>Carousel.curr.cancel());
  await page.waitForFunction(()=>game.roundCount>=1 && player_me && player_op && !Carousel.curr, null, {timeout:20000});
  await page.evaluate(()=>{
    player_op.controller.startTurn = async () => {};
    ui.notification = async () => {};
    game.currPlayer = player_me;
    window.__popupAnswers = [];
    window.__popupCalls = [];
    ui.popup = async (yesName, yes, noName, no, title, description) => {
      window.__popupCalls.push(title);
      const answer = window.__popupAnswers.length > 0 ? window.__popupAnswers.shift() : true;
      return answer ? yes({}) : no({});
    };
  });
  // Case 1: my ambush card on the opponent's side triggers -> goes to my grave,
  // Sigismund prevention is NOT consumed.
  const ambushCase = await page.evaluate(async ()=>{
    const wait = ms => new Promise(r=>setTimeout(r,ms));
    // Novigrad ambush unit (Sly Seductress) placed on the opponent's close row.
    const sly = new Card('nv_passiflora_1', card_dict['nv_passiflora_1'], player_me);
    const opRow = board.getRow(sly, 'close', player_me); // spy-like side flip
    await board.moveTo(sly, opRow, null);
    if (typeof sly.currentLocation.effects !== 'undefined') opRow.effects.ambush = true;
    // A non-spy unit played by the opponent onto that row triggers the ambush.
    const trigger = new Card('nr_villen', card_dict['nr_villen'], player_op);
    await board.moveTo(trigger, opRow, null);
    await wait(1200);
    return {
      ambushGone: !opRow.cards.includes(sly),
      ambushInGrave: player_me.grave.cards.includes(sly),
      preventionUsed: !!player_me.sigismundDeathPreventionUsed,
      triggerStillOnRow: opRow.cards.includes(trigger)
    };
  });
  console.log(JSON.stringify(ambushCase, null, 2));
  assert(ambushCase.ambushGone, 'triggered ambush card is removed from the row');
  assert(ambushCase.ambushInGrave, 'triggered ambush card goes to the grave');
  assert(!ambushCase.preventionUsed, 'Sigismund death prevention is NOT consumed by an ambush resolving');
  assert(ambushCase.triggerStillOnRow, 'the triggering unit stays on the row');
  // Case 2: a real destruction with the save accepted consumes the prevention.
  const deathCase = await page.evaluate(async ()=>{
    const wait = ms => new Promise(r=>setTimeout(r,ms));
    player_me.sigismundDeathPreventionUsed = false;
    window.__popupAnswers = [true];
    const unit = new Card('nr_villen', card_dict['nr_villen'], player_me);
    const myRow = board.getRow(unit, 'close', player_me);
    await board.moveTo(unit, myRow, null);
    await board.toGrave(unit, myRow);
    await wait(300);
    return {
      popupShown: window.__popupCalls.includes('Do you want to save this unit?'),
      preventionUsed: !!player_me.sigismundDeathPreventionUsed,
      unitSaved: myRow.cards.includes(unit)
    };
  });
  console.log(JSON.stringify(deathCase, null, 2));
  assert(deathCase.popupShown, 'a real unit destruction asks the Sigismund save question');
  assert(deathCase.preventionUsed, 'accepting the save consumes the Sigismund prevention');
  assert(deathCase.unitSaved, 'the destroyed unit is saved on the row');
  // Case 3: declining the save lets the unit die and keeps the prevention.
  const declineCase = await page.evaluate(async ()=>{
    const wait = ms => new Promise(r=>setTimeout(r,ms));
    player_me.sigismundDeathPreventionUsed = false;
    window.__popupAnswers = [false];
    const unit = new Card('nr_villen', card_dict['nr_villen'], player_me);
    const myRow = board.getRow(unit, 'close', player_me);
    await board.moveTo(unit, myRow, null);
    await board.toGrave(unit, myRow);
    await wait(300);
    return {
      preventionUsed: !!player_me.sigismundDeathPreventionUsed,
      unitInGrave: player_me.grave.cards.includes(unit),
      unitStillOnRow: myRow.cards.includes(unit)
    };
  });
  console.log(JSON.stringify(declineCase, null, 2));
  assert(!declineCase.preventionUsed, 'declining the save keeps the Sigismund prevention available');
  assert(declineCase.unitInGrave, 'declining the save lets the unit die');
  assert(!declineCase.unitStillOnRow, 'declining the save removes the unit from the row');
  console.log(failed ? 'DONE (failures)' : 'DONE (all passed)');
  await browser.close();
  server.kill();
  process.exitCode = failed ? 1 : 0;
})().catch(e=>{ console.error(e); process.exit(1); });
