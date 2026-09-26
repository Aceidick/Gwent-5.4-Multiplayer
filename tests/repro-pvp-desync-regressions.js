"use strict";
// Regression test for the v1.4.4 Player vs Friend desync fixes.
// Covers the three production failure classes from the server logs:
//
// 1. XR37G "Timed out waiting for carousel choice" - a human browsing a
//    large carousel pool needs more than the old 30s remote decision timeout.
//    All human remote decisions (popup/carousel/destination) must now wait
//    120s, matching number/deck-sort/ability-target decisions.
// 2. CPKJ8 "Timed out waiting for continuation destination" - the opening
//    mulligan used the seeded deckRng stream for private shuffles. Each peer
//    consumed its own local draws, so the streams diverged and later seeded
//    shuffles (Zirael/wh_cirilla putting cards back) produced different deck
//    orders; the two peers then opened different decision protocols at wild
//    hunt turnEnd. The mulligan shuffle must not advance the seeded streams.
// 3. EHNZF "Timed out waiting for popup choice" - endRound cleared the six
//    rows in parallel, so several Comrade "Save it?" popups could be open at
//    once while Popup supports only one slot; the unanswered popups never
//    sent popup-choice and the waiting peer timed out. Round cleanup is now
//    serialized. The remote popup replay must also return the callback value
//    (Comrade returns true/false directly) instead of always fake.choice.
//
// The match itself is driven over the real relay like e2e-online.js.
const { chromium } = require('playwright-core');
const fs = require('fs');
function chromePath() {
  for (const p of [process.env.CHROMIUM_PATH, '/usr/bin/chromium', '/usr/bin/chromium-browser', '/usr/bin/google-chrome'])
    if (p && fs.existsSync(p)) return p;
  throw new Error('Chromium not found. Set CHROMIUM_PATH.');
}
const { spawn } = require('child_process');
const path = require('path');
const PORT = process.env.TEST_PORT || '18094';
const URL = `http://127.0.0.1:${PORT}`;
let failed = false;
function assert(v, label) { console.log(`${v?'PASS':'FAIL'} ${label}`); if (!v) failed = true; }
async function wait(page, fn, label, timeout=60000) {
  try { await page.waitForFunction(fn, null, {timeout}); return true; }
  catch (_) { console.log(`FAIL timeout: ${label}`); failed = true; return false; }
}
(async()=>{
  const server = spawn(process.execPath, [path.join(__dirname,'..','server','server.js')],
    {env:{...process.env, PORT}, cwd:path.join(__dirname,'..'), stdio:['ignore','pipe','pipe']});
  await new Promise(r=>setTimeout(r,800));
  const browser = await chromium.launch({headless:true, executablePath: chromePath(), args:['--no-sandbox']});
  const A = await (await browser.newContext({viewport:{width:1920,height:1080}})).newPage();
  const B = await (await browser.newContext({viewport:{width:1920,height:1080}})).newPage();
  for (const p of [A,B]) p.on('pageerror', e=>{ console.log('PAGE ERROR:', String(e)); failed = true; });
  await A.goto(URL); await B.goto(URL);
  await A.click('#button_start_friend'); await B.click('#button_start_friend');
  await wait(A,()=>typeof GwentOnline!=='undefined'&&typeof dm!=='undefined','host loaded');
  await wait(B,()=>typeof GwentOnline!=='undefined'&&typeof dm!=='undefined','guest loaded');
  // Static protocol invariants verified against the served sources on disk.
  const onlineSrc = fs.readFileSync(path.join(__dirname,'..','online.js'), 'utf8');
  assert(onlineSrc.includes("popup-choice', x => x.decision === decision.id, 120000"), 'remote popup decisions wait 120s');
  assert(onlineSrc.includes("x => x.decision === decision.id, 120000, `Timed out waiting for carousel choice"), 'remote carousel decisions wait 120s');
  assert(onlineSrc.includes('`Timed out waiting for continuation destination (${decision.id})`') && onlineSrc.includes('x.decision === decision.id, 120000'), 'remote destination decisions wait 120s');
  assert(onlineSrc.includes('return fake.choice !== null && fake.choice !== undefined ? fake.choice : returned;'), 'remote popup replay returns callback value (Comrade save)');
  assert(onlineSrc.includes('withLocalShuffleRng'), 'mulligan shuffles avoid the seeded deckRng stream');
  const gwentSrc = fs.readFileSync(path.join(__dirname,'..','gwent.js'), 'utf8');
  const parallelCleanup = 'await Promise.all(board.row.map(async row => {';
  const serialCleanup = 'for (const row of board.row) {';
  assert(!gwentSrc.includes(parallelCleanup) && gwentSrc.includes(serialCleanup), 'round-end row cleanup is serialized');
  for (const p of [A,B]) await p.evaluate(()=>document.getElementById('start-pvp-game').click());
  await wait(A,()=>!!document.getElementById('online-create'),'host lobby open');
  await wait(B,()=>!!document.getElementById('online-create'),'guest lobby open');
  await A.evaluate(()=>{ GwentOnline.createRoomSafe(); });
  await wait(A,()=>/^[2-9A-Z]{5}$/.test(document.getElementById('online-room-code').textContent),'room created');
  const code=(await A.textContent('#online-room-code')).trim();
  await B.fill('#online-code-input',code);
  await B.evaluate(()=>{ GwentOnline.joinRoomSafe(); });
  await wait(B,()=>OnlineNet.role==='guest','guest joined');
  await wait(A,()=>GwentOnline.peerConnected===true,'host sees peer');
  for (const p of [A,B]) await p.evaluate(()=>document.getElementById('online-close')?.click());
  await wait(A,()=>!document.getElementById('start-game').disabled,'host Start game enabled');
  await wait(B,()=>!document.getElementById('start-game').disabled,'guest Start game enabled');
  await A.click('#start-game'); await B.click('#start-game');
  await wait(A,()=>GwentOnline.active,'host match active');
  await wait(B,()=>GwentOnline.active,'guest match active');
  await wait(A,()=>typeof Carousel!=='undefined'&&Carousel.curr,'host mulligan open');
  await wait(B,()=>typeof Carousel!=='undefined'&&Carousel.curr,'guest mulligan open');
  // Exercise asymmetric mulligan: host redraws one card, guest redraws none.
  // This is the exact CPKJ8 divergence driver: only one peer consumed seeded
  // draws before v1.4.4.
  await A.evaluate(async()=>{ if (Carousel.curr) Carousel.curr.select(new Event('click')); });
  await A.waitForTimeout(150);
  await A.evaluate(()=>Carousel.curr&&Carousel.curr.cancel());
  await B.evaluate(()=>Carousel.curr&&Carousel.curr.cancel());
  await wait(A,()=>game.roundCount===1&&game.currPlayer,'host round 1');
  await wait(B,()=>game.roundCount===1&&game.currPlayer,'guest round 1');
  // After the asymmetric mulligan, both peers' seeded deckRng streams must be
  // bit-identical: neither peer's private redraw may have advanced them.
  const probeA = await A.evaluate(()=>{ const s = []; for (let i=0;i<4;i++) s.push(GwentOnline.deckRng.host.int(1000)); return s; });
  const probeB = await B.evaluate(()=>{ const s = []; for (let i=0;i<4;i++) s.push(GwentOnline.deckRng.host.int(1000)); return s; });
  assert(JSON.stringify(probeA)===JSON.stringify(probeB), 'seeded deckRng streams stay identical after asymmetric mulligan');
  const probeAg = await A.evaluate(()=>{ const s = []; for (let i=0;i<4;i++) s.push(GwentOnline.deckRng.guest.int(1000)); return s; });
  const probeBg = await B.evaluate(()=>{ const s = []; for (let i=0;i<4;i++) s.push(GwentOnline.deckRng.guest.int(1000)); return s; });
  assert(JSON.stringify(probeAg)===JSON.stringify(probeBg), 'guest deckRng stream stays identical too');
  // A seeded addCard shuffle must now place the card identically on both
  // peers (the Zirael class of divergence), when the deck lengths match.
  // The real Zirael class: the DECK OWNER shuffles cards back. Simulate the
  // owner's own seeded shuffle on both peers via the owner's player object.
  const shuffleA = await A.evaluate(async ()=>{
    const owner = GwentOnline.playerOf('host');
    const n = owner.deck.cards.length;
    await GwentOnline.withDeckRng('host', ()=>owner.deck.addCard(new Card('spe_decoy', card_dict['spe_decoy'], owner)));
    const idx = owner.deck.cards.findIndex(c=>c.key==='spe_decoy');
    owner.deck.removeCard(idx);
    return {idx, n};
  });
  const shuffleB = await B.evaluate(async ()=>{
    const owner = GwentOnline.playerOf('host');
    const n = owner.deck.cards.length;
    await GwentOnline.withDeckRng('host', ()=>owner.deck.addCard(new Card('spe_decoy', card_dict['spe_decoy'], owner)));
    const idx = owner.deck.cards.findIndex(c=>c.key==='spe_decoy');
    owner.deck.removeCard(idx);
    return {idx, n};
  });
  assert(shuffleA.n===shuffleB.n && shuffleA.idx===shuffleB.idx, 'seeded shuffle places cards at the same index on both peers');
  // Popup replay semantics: a remote "yes" for a callback that returns the
  // value (no p.choice) must evaluate truthy on the replaying peer.
  const replayTest = await B.evaluate(async()=>{
    const online = GwentOnline;
    const origNext = online.nextMatchingWithTimeout.bind(online);
    online.nextMatchingWithTimeout = (types, match, ms, label) => {
      online.nextMatchingWithTimeout = origNext;
      return Promise.resolve({decision: 'x', yes: true});
    };
    return await ui.popup('Save it [E]', ()=>true, 'Let it die [Q]', ()=>false, 'Do you want to save this unit?', 'test');
  });
  assert(replayTest===true, 'remote popup "yes" replays as true for return-value callbacks');
  await A.evaluate(()=>document.getElementById('giveup-button').click());
  await wait(A,()=>game.over,'host forfeit reached end');
  await wait(B,()=>game.over,'guest reached end after forfeit');
  server.kill();
  await browser.close();
  console.log(failed ? 'RESULT: FAILED' : 'RESULT: PVP DESYNC REGRESSION PASS');
  process.exit(failed ? 1 : 0);
})().catch(e=>{ console.error('FATAL', e); process.exit(1); });
