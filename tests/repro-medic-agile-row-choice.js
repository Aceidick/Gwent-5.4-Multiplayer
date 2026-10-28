"use strict";
// Regression test for the Medic row-choice bug.
// Question: when a human player uses a Medic and restores a card that has
// several valid rows (agile variants), is the player offered the choice of
// where to place it?
// Buggy behavior: the restored card always went through Card.autoplay() ->
// board.toRow(), which hardcodes "close" for every agile variant, so the card
// was silently placed in Close Combat.
// Intended behavior: cards with several valid rows must open the destination
// picker (Player.selectCardDestination), which highlights every valid row via
// board.getAgileRows(); single-row cards keep the automatic placement.
//
// This test locks that in:
//  1. restoring an agile_rs card (ranged/siege) from the grave with a medic
//     must open a pending destination decision and highlight exactly the
//     ranged and siege rows of the holder;
//  2. committing the siege row choice must place the card in the siege row;
//  3. restoring a single-row (siege) card must auto-place without any
//     destination decision, as before.
const { chromium } = require('playwright-core');
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const PORT = process.env.TEST_PORT || '18098';
let failed = false;
function assert(v, label) { console.log(`${v?'PASS':'FAIL'} ${label}`); if (!v) failed = true; }
function chromePath() {
  for (const p of [process.env.CHROMIUM_PATH, '/usr/bin/chromium', '/usr/bin/chromium-browser', '/usr/bin/google-chrome',
    ...(fs.existsSync('/home/appuser/.cache/ms-playwright') ? fs.readdirSync('/home/appuser/.cache/ms-playwright')
      .filter(d=>d.startsWith('chromium_headless_shell'))
      .map(d=>`/home/appuser/.cache/ms-playwright/${d}/chrome-headless-shell-linux64/chrome-headless-shell`) : [])])
    if (p && fs.existsSync(p)) return p;
  throw new Error('Chromium not found. Install it or set CHROMIUM_PATH.');
}
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
    const ofir = premade_deck.find(d=>d.faction==='ofir' && d.leader==='ofir_aamad_wise');
    dm.deckFromJSON(JSON.parse(JSON.stringify(ofir)), false);
    dm.startNewGame(1);
  });
  await page.waitForFunction(()=>Carousel.curr, null, {timeout:10000});
  await page.evaluate(()=>Carousel.curr.cancel());
  await page.waitForFunction(()=>game.roundCount>=1 && player_me && player_op && !Carousel.curr, null, {timeout:20000});
  // Deterministic environment: AI turns and notifications disabled.
  await page.evaluate(()=>{
    player_op.controller.startTurn = async () => {};
    ui.notification = async () => {};
    game.currPlayer = player_me;
  });

  // Case 1: medic restores an agile_rs (ranged/siege) card -> destination picker.
  // Row.addCard's DOM translation animation crashes the headless shell, so the
  // placed() ability is invoked directly; this is the same entry point Row.addCard
  // uses and covers exactly the medic decision chain under test.
  const agile = await page.evaluate(async ()=>{
    const medic = new Card('ne_albrich', card_dict['ne_albrich'], player_me);
    const wyvern = new Card('mo_wyvern', card_dict['mo_wyvern'], player_me);
    player_me.grave.addCard(wyvern);
    const p = ability_dict['medic'].placed(medic);
    // Wait for the medic grave carousel and select the agile card.
    for (let i=0;i<600 && !Carousel.curr;i++) await new Promise(r=>setTimeout(r,25));
    if (!Carousel.curr) { await p; return {error:'medic carousel never opened'}; }
    const keys = Carousel.curr.container.cards.map(c=>c.key);
    const idx = keys.indexOf('mo_wyvern');
    if (idx < 0) { Carousel.curr.cancel(); await p; return {error:'agile card not offered in medic carousel', keys}; }
    Carousel.curr.index = idx;
    Carousel.curr.select();
    // The destination picker must open: endturn_action pending + rows highlighted.
    for (let i=0;i<400 && !player_me.endturn_action;i++) await new Promise(r=>setTimeout(r,25));
    const validRows = board.getAgileRows(wyvern, player_me).map(r=>board.row.indexOf(r));
    const highlighted = board.row.map((r,i)=>({i, selectable: r.elem.classList.contains('row-selectable')}))
      .filter(r=>r.selectable).map(r=>r.i);
    const pending = !!player_me.endturn_action;
    const preview = ui.previewCard ? ui.previewCard.key : null;
    const inHand = player_me.hand.cards.includes(wyvern);
    if (!pending) { await p; return {error:'no pending destination decision', validRows, highlighted, keys}; }
    // Commit the siege row choice.
    const siegeRow = board.row[5];
    if (!validRows.includes(5)) { await p; return {error:'siege row not valid for agile_rs', validRows}; }
    const click = ui.selectRow(siegeRow);
    await Promise.race([
      Promise.all([p, click]),
      new Promise((_,rej)=>setTimeout(()=>rej(new Error('placement timeout')),30000))
    ]);
    return {
      pending, preview, inHand, validRows, highlighted,
      siege: board.row.indexOf(wyvern.currentLocation),
      graveCount: player_me.grave.cards.filter(c=>c.key==='mo_wyvern').length
    };
  });
  assert(!agile.error, 'agile restore: medic carousel offers the agile card and the destination picker opens');
  if (agile.error) console.log('  detail:', JSON.stringify(agile));
  if (!agile.error) {
    assert(agile.preview === 'mo_wyvern', 'agile restore previews the restored card for row selection');
    assert(agile.inHand, 'restored agile card is staged in hand for placement');
    assert(JSON.stringify(agile.validRows) === JSON.stringify([4,5]), 'agile_rs card has exactly ranged+siege as valid rows');
    assert(JSON.stringify(agile.highlighted) === JSON.stringify(agile.validRows), 'exactly the valid rows (ranged/siege) are highlighted');
    assert(agile.siege === 5, 'committing the siege row places the restored card in the siege row');
    assert(agile.graveCount === 0, 'restored agile card left the grave');
  }

  // Case 2: single-row card keeps automatic placement (no destination decision).
  const single = await page.evaluate(async ()=>{
    game.currPlayer = player_me;
    const medic2 = new Card('ne_albrich', card_dict['ne_albrich'], player_me);
    const nurse = new Card('nr_banner_nurse', card_dict['nr_banner_nurse'], player_me);
    player_me.grave.addCard(nurse);
    const p2 = ability_dict['medic'].placed(medic2);
    for (let i=0;i<600 && !Carousel.curr;i++) await new Promise(r=>setTimeout(r,25));
    if (!Carousel.curr) { await p2; return {error:'second medic carousel never opened'}; }
    const keys = Carousel.curr.container.cards.map(c=>c.key);
    const idx = keys.indexOf('nr_banner_nurse');
    if (idx < 0) { Carousel.curr.cancel(); await p2; return {error:'single-row card not offered', keys}; }
    Carousel.curr.index = idx;
    Carousel.curr.select();
    await Promise.race([
      p2,
      new Promise((_,rej)=>setTimeout(()=>rej(new Error('single placement timeout')),30000))
    ]);
    return {
      siege: board.row.indexOf(nurse.currentLocation),
      pending: !!player_me.endturn_action
    };
  });
  assert(!single.error, 'single-row restore: medic carousel offers the siege card and placement completes');
  if (single.error) console.log('  detail:', JSON.stringify(single));
  if (!single.error) {
    assert(single.siege === 5, 'single-row (siege) card is still auto-placed in the siege row');
    assert(!single.pending, 'single-row card does not open a destination decision');
  }

  console.log(failed ? 'DONE (failures)' : 'DONE (all passed)');
  await browser.close();
  server.kill();
  process.exitCode = failed ? 1 : 0;
})().catch(e=>{ console.error(e); process.exit(1); });
