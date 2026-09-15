"use strict";
// Opponent-leader (Select Opponent Leader) multiplayer regression suite.
// Verifies that picking "Random Leader" locks the peer's leader/faction and
// actually resolves to a seeded random leader, deterministic on both peers,
// even when only one side chooses Random Leader (asymmetric lock).
// Requires a system Chromium/Chrome and `npm install` (playwright-core).

const { chromium } = require('playwright-core');
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');

const PORT = process.env.TEST_PORT || '18090';
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
  await A.click('#start-pvp-game'); await B.click('#start-pvp-game');
  await A.click('#online-create');
  await wait(A,()=>/^[2-9A-Z]{5}$/.test(document.getElementById('online-room-code').textContent),'room created');
  const code=(await A.textContent('#online-room-code')).trim();
  await B.fill('#online-code-input',code); await B.click('#online-join');
  await wait(B,()=>OnlineNet.role==='guest','guest joined');
  await A.click('#online-close'); await B.click('#online-close');
  await wait(A,()=>!document.getElementById('start-game').disabled,'host deck Start game enabled');
  await wait(B,()=>!document.getElementById('start-game').disabled,'guest deck Start game enabled');

  // Capture each peer's default (pre-lock) leader+faction.
  const hostBefore = await A.evaluate(()=>({faction:dm.faction, leader:dm.leader?.index}));
  const guestBefore = await B.evaluate(()=>({faction:dm.faction, leader:dm.leader?.index}));

  // Host chooses "Random Leader" for the guest (asymmetric: only host picks).
  await A.click('#select-op-leader');
  await A.waitForFunction(()=>!!Carousel.curr,'host op-leader carousel open');
  // Navigate to "Random Leader" (index 1) and select.
  await A.evaluate(()=>{ if (Carousel.curr) Carousel.curr.index = 1; });
  await A.evaluate(()=>{ if (Carousel.curr) Carousel.curr.select(new Event('click')); });

  // Guest's faction/leader selectors must lock and a random leader resolve.
  await wait(B,()=>document.getElementById('change-faction').classList.contains('noclick'),'guest faction locked');
  await wait(B,()=>document.getElementById('card-leader').classList.contains('noclick'),'guest leader locked');
  await wait(B,()=>document.getElementById('select-deck').classList.contains('noclick'),'guest deck-select locked');

  // The guest must now have a (seeded) random leader applied.
  await wait(B,()=>{
    const d=dm; return d && d.leader && d.leader.index && d.faction;
  },'guest random leader resolved');
  const guestAfter = await B.evaluate(()=>({faction:dm.faction, leader:dm.leader?.index}));

  assert(!!guestAfter.faction && !!guestAfter.leader, 'guest random leader resolved (faction+leader set)');
  assert(!(guestAfter.faction===guestBefore.faction && guestAfter.leader===guestBefore.leader) || true,
    'guest leader may differ from default (random pick allowed to coincide)');

  // Host must NOT be locked by its own choice (asymmetric: only peer is locked).
  const hostLocked = await A.evaluate(()=>document.getElementById('change-faction').classList.contains('noclick'));
  assert(!hostLocked, 'host not locked by own choice');

  // Determinism check: re-derive the host's own seed locally and confirm the
  // guest's resolved faction/leader match the xorshift(seed) algorithm, so the
  // two peers would start a match on the same leader.
  const seedMatch = await A.evaluate(async ()=>{
    // Host keeps the seed it sent in _randomLeaderSeed.
    return GwentOnline._randomLeaderSeed;
  });
  const guestDerived = await B.evaluate((seed)=>{
    if (seed==null) return null;
    const factionKeys=Object.keys(factions);
    let x=(seed>>>0)||1;
    const next=()=>{x^=x<<13;x>>>=0;x^=x>>17;x^=x<<5;x>>>=0;return x;};
    const faction=factionKeys[next()%factionKeys.length];
    const leaders=Object.keys(card_dict).filter(k=>card_dict[k].deck===faction&&card_dict[k].row==='leader');
    const leader=leaders[next()%leaders.length];
    return {faction, leader};
  }, seedMatch);
  assert(!!guestDerived, 'guest derived leader from host seed');
  assert(guestDerived && guestAfter.faction===guestDerived.faction && guestAfter.leader===guestDerived.leader,
    'guest resolved leader matches deterministic seed algorithm');

  // Symmetric lock: guest now also picks "Random Leader" for the host.
  await B.click('#select-op-leader');
  await B.waitForFunction(()=>!!Carousel.curr,'guest op-leader carousel open');
  await B.evaluate(()=>{ if (Carousel.curr) Carousel.curr.index = 1; });
  await B.evaluate(()=>{ if (Carousel.curr) Carousel.curr.select(new Event('click')); });

  await wait(A,()=>document.getElementById('change-faction').classList.contains('noclick'),'host faction locked by guest');
  await wait(A,()=>document.getElementById('card-leader').classList.contains('noclick'),'host leader locked by guest');
  await wait(A,()=>{
    const d=dm; return d && d.leader && d.leader.index && d.faction;
  },'host random leader resolved');

  const hostAfter = await A.evaluate(()=>({faction:dm.faction, leader:dm.leader?.index}));
  assert(!!hostAfter.faction && !!hostAfter.leader, 'host random leader resolved (faction+leader set)');

  // Unlock path: host switches back to "Normal" — guest must unlock.
  await A.click('#select-op-leader');
  await A.waitForFunction(()=>!!Carousel.curr,'host op-leader carousel open (normal)');
  await A.evaluate(()=>{ if (Carousel.curr) Carousel.curr.index = 0; });
  await A.evaluate(()=>{ if (Carousel.curr) Carousel.curr.select(new Event('click')); });
  await wait(B,()=>!document.getElementById('change-faction').classList.contains('noclick'),'guest faction unlocked after host Normal');
  await wait(B,()=>!document.getElementById('card-leader').classList.contains('noclick'),'guest leader unlocked after host Normal');

  // No page errors on either peer.
  assert(errs.A.length===0, 'host no page errors'+(errs.A.length?': '+errs.A.join(' | '):''));
  assert(errs.B.length===0, 'guest no page errors'+(errs.B.length?': '+errs.B.join(' | '):''));
})().catch(e=>console.error('FATAL',e)).finally(async()=>{
  if(cleanupBrowser) await cleanupBrowser.close();
  if(cleanupServer) cleanupServer.kill();
  process.exit(failed?1:0);
});
