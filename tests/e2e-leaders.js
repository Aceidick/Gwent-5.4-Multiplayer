"use strict";
// Leader & leader-ability multiplayer regression suite.
// Two real Chromium contexts against the bundled single-port server.
// Requires a system Chromium/Chrome and `npm install` (playwright-core is a dev dependency).
//
// This suite exercises every interactive leader ability that was previously
// uncovered by the core e2e suites. Each case installs a leader, triggers its
// ability (activated or round-start), drives the interactive choice on the
// owning browser, and verifies identical public state + clean turn ownership
// on both peers.

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

// Reusable plain close unit key (ability-free, non-hero, positive strength).
const PLAIN_UNIT_KEY = 'ntr_triss'; // close hero actually; replaced below
const HERO_CLOSE = 'ntr_geralt';
const HERO_RANGED = 'ntr_yennefer';
const SPY_CLOSE = 'nr_stennis';
const EMISSARY = 'ne_vreemde';

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
  const consoleLog={A:[],B:[]};
  for (const [tag,p] of [['A',A],['B',B]]) {
    p.on('pageerror', e=>errs[tag].push(String(e)));
    p.on('console', async m=>{ const t=m.text(); consoleLog[tag].push(t); if(/multiset|mismatch|reconcil|private-zone|desync/i.test(t)){ console.log(`[console:${tag}] ${t}`); if(/multiset mismatch/i.test(t)){ try{ const args=await Promise.all(m.args().map(a=>a.jsonValue&&typeof a.jsonValue==='function'?a.jsonValue():a)); console.log(`[console:${tag}:DETAIL] ${JSON.stringify(args).slice(0,2000)}`); }catch(_){} } } });
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
  await wait(A,()=>GwentOnline.active,'host match active');
  await wait(B,()=>GwentOnline.active,'guest match active');
  await wait(A,()=>typeof Carousel!=='undefined'&&Carousel.curr,'host mulligan open');
  await wait(B,()=>typeof Carousel!=='undefined'&&Carousel.curr,'guest mulligan open');
  await A.evaluate(()=>Carousel.curr&&Carousel.curr.cancel());
  await B.evaluate(()=>Carousel.curr&&Carousel.curr.cancel());
  await wait(A,()=>game.roundCount===1&&game.currPlayer,'host round 1');
  await wait(B,()=>game.roundCount===1&&game.currPlayer,'guest round 1');
  await A.waitForTimeout(2500);

  // Install a carousel-opening counter on both browsers so multi-stage ability
  // transitions can be detected even when both carousels hold equal card counts.
  for (const p of [A,B]) await p.evaluate(()=>{
    if (window.__carouselHooked) return;
    window.__carouselHooked = true;
    window.__carouselOpens = 0;
    const origQueue = UI.prototype.queueCarousel;
    UI.prototype.queueCarousel = async function(...args){ window.__carouselOpens++; return origQueue.apply(this, args); };
    const origView = UI.prototype.viewCardsInContainer;
    UI.prototype.viewCardsInContainer = async function(...args){ window.__carouselOpens++; return origView.apply(this, args); };
  });

  // Resolve the ability-free close unit key dynamically (positive strength, non-hero).
  const plainCloseKey = await A.evaluate(()=>{
    return Object.keys(card_dict).find(k=>card_dict[k].row==='close' && !card_dict[k].ability && Number(card_dict[k].strength)>0 && !card_dict[k].hero);
  });

  // Installs an identical logical state in both browsers, with the leader
  // owned by the current acting player. Returns the local/remote mapping.
  async function setup(leader, opts={}) {
    await A.waitForTimeout(900);
    const role = await A.evaluate(()=>GwentOnline.roleOfPlayer(game.currPlayer));
    const seq = await A.evaluate(()=>GwentOnline._turnSeq);
    for (const p of [A,B]) await p.evaluate(async ({leader, role, plainCloseKey, opts})=>{
      const actor = GwentOnline.playerOf(role);
      // Independent board fixture: clear stale cards (rows, specials, and
      // graves from prior cases) so each leader test starts from a clean,
      // identical state. Private zones (hand/deck) are left untouched.
      for(const row of board.row) { for(const c of [...row.cards, ...row.special.cards]) row.removeCard(c,false); }
      for(const p of [actor, actor.opponent()]) { while(p.grave.cards.length) p.grave.removeCard(p.grave.cards[0]); p.forcedActions = []; p.setPassed(false); }
      actor.replaceLeader(new Card(leader, card_dict[leader], actor));
      // Re-enable leader so activated abilities are usable (replaceLeader may
      // disableLeader() for placed-based leaders; we re-enable for the test).
      if (opts.reEnable) actor.enableLeader();
      window.fixtureCards=[];
      const fixtureKey = opts.fixtureKey || plainCloseKey;
      const owner = opts.fixtureOwner==='opponent' ? actor.opponent() : actor;
      const rowCount = opts.fixtureRows || 1;
      for(let r=0;r<rowCount;r++){
        const rowName = opts.fixtureRowNames ? opts.fixtureRowNames[r] : 'close';
        for(let i=0;i<(opts.fixturePerRow||4);i++){
          const c=new Card(fixtureKey,card_dict[fixtureKey],owner);
          await board.addCardToRow(c,rowName,owner);
          fixtureCards.push(c);
        }
      }
      if (opts.extraFixture) {
        for(const f of opts.extraFixture){
          const c=new Card(f.key,card_dict[f.key],f.owner==='opponent'?owner:f.owner===owner?owner:actor);
          await board.addCardToRow(c,f.row,f.owner==='self'?actor:(f.owner==='opponent'?actor.opponent():owner));
        }
      }
      board.updateScores();
    },{leader, role, plainCloseKey, opts});
    return {local:role==='host'?A:B, remote:role==='host'?B:A, seq, role};
  }

  // Fires the leader's activated ability on the local browser and waits for it
  // to commit (turn sequence advances, no leftover decisions, identical state).
  async function activate(t) {
    await t.local.evaluate(()=>{ window.actionDone=false; window.actionError=null;
      player_me.activateLeader().then(()=>window.actionDone=true,e=>window.actionError=String(e));
    });
  }
  // Helper: after a local selection, wait for the next carousel to open and be
  // fully ready (Carousel.curr set with a non-empty candidate list).
  async function nextCarousel(t, {minCards=1, timeout=20000}={}) {
    const opens = await t.local.evaluate(()=>window.__carouselOpens||0);
    const target = opens + 1;
    const ok = await t.local.waitForFunction(([tgt,mc])=>(window.__carouselOpens||0)>=tgt && !!Carousel.curr && Carousel.curr.container && Carousel.curr.container.cards && Carousel.curr.container.cards.length>=mc, [target, minCards], {timeout}).catch(()=>false);
    if (ok) await A.waitForTimeout(150);
    return ok;
  }
  // Select a specific card (by key) inside the current carousel by navigating
  // the carousel index to that card before firing select(). Falls back to the
  // first card when the key is absent (keeps tests resilient to deck order).
  async function selectInCarouselByKey(t, key) {
    const found = await t.local.evaluate(k=>{
      const c = Carousel.curr; if (!c || !c.container) return false;
      const pos = c.indices.findIndex(i => c.container.cards[i] && c.container.cards[i].key === k);
      if (pos >= 0) c.index = pos;
      return true;
    }, key);
    if (found) await t.local.evaluate(()=>{ if (Carousel.curr) Carousel.curr.select(new Event('click')); });
    return found;
  }
  async function committed(t,label) {
    await Promise.all([A,B].map(p=>p.waitForFunction(seq=>GwentOnline._turnSeq===seq+1, t.seq,{timeout:25000})));
    await Promise.all([A,B].map(p=>p.waitForFunction(()=>!GwentOnline._decisionOwner, null, {timeout:25000})));
    await t.remote.waitForFunction(()=>game.currPlayer===player_me && !document.querySelector('main').classList.contains('noclick'), null, {timeout:25000});
    assert(await t.local.evaluate(()=>document.querySelector('main').classList.contains('noclick')), label+' completed actor input disabled');
    assert(await t.remote.evaluate(()=>!GwentOnline._effectContext), label+' next turn has no old effect context');
    const states=await Promise.all([A,B].map(p=>p.evaluate(()=>GwentOnline.syncState())));
    assert(JSON.stringify(states[0])===JSON.stringify(states[1]), label+' identical public state');
    assert(await t.local.evaluate(()=>!window.actionError), label+' no action error'+(await t.local.evaluate(()=>window.actionError?(' : '+window.actionError):'')));
    assert(await t.remote.evaluate(()=>!GwentOnline.queue.some(m=>['rearrange-card','rearrange-row','rearrange-end','ability-target','power-card','destination','choice'].includes(m.t))), label+' no leftover decisions');
  }

  // Triggers a round-start leader effect (placed-based) on both peers by running
  // the registered roundStart effects within the owning decision context. This
  // mirrors how the game itself fires round-start effects at round boundaries.
  async function triggerRoundStart(t) {
    await t.local.evaluate(()=>{ window.actionDone=false; window.actionError=null; });
    for (const p of [A,B]) await p.evaluate(role=>{
      const owner = GwentOnline.playerOf(role);
      if (window.GwentOnline && window.GwentOnline.active)
        GwentOnline.withDecisionOwner(owner, async ()=>{ try { await game.runEffects(game.roundStart); window.actionDone=true; } catch(e){ window.actionError=String(e);} }, 'test:round-start');
      else { try { game.runEffects(game.roundStart); window.actionDone=true; } catch(e){ window.actionError=String(e);} }
    }, t.role);
  }

  // --- Leader ability cases ---
  // Each case: leader key, trigger type, and a `run(t)` that drives the choice
  // on the local browser. The harness installs the leader, fires the trigger,
  // runs the choice, and verifies committed identical state.

  // 1. foltest_king: popup choice fog vs rain. Needs both in deck.
  {
    const t = await setup('nr_foltest_king', {reEnable:true});
    for (const p of [A,B]) await p.evaluate(role=>{
      const actor = GwentOnline.playerOf(role);
      actor.deck.addCard(new Card('spe_fog', card_dict.spe_fog, actor));
      actor.deck.addCard(new Card('spe_rain', card_dict.spe_rain, actor));
    }, t.role);
    await activate(t);
    await t.local.waitForFunction(()=>!!Popup.curr, null, {timeout:20000});
    await t.local.evaluate(()=>Popup.curr.selectYes());
    await committed(t,'foltest_king weather popup');
  }

  // 2. emhyr_imperial: carousel opponent grave unit, then carousel own hand.
  {
    const t = await setup('ne_emhyr_imperial', {reEnable:true});
    for (const p of [A,B]) await p.evaluate(role=>{
      const actor = GwentOnline.playerOf(role);
      const k = window.fixtureCards[0].key;
      actor.opponent().grave.addCard(new Card(k, card_dict[k], actor.opponent()));
    }, t.role);
    await activate(t);
    await t.local.waitForFunction(()=>!!Carousel.curr, null, {timeout:20000});
    await t.local.evaluate(()=>{ if (Carousel.curr) Carousel.curr.select(new Event('click')); });
    await nextCarousel(t, {minCards:2});
    await t.local.evaluate(()=>{ if (Carousel.curr) Carousel.curr.select(new Event('click')); });
    await committed(t,'emhyr_imperial two carousels');
  }

  // 3. emhyr_relentless: carousel own unit to destroy, then carousel spy to draw.
  // (Moved before Emhyr Invader: Invader pushes a forced action onto the
  // opponent that opens a local "Play card/Pass" popup on the opponent's next
  // startTurn. Online that startTurn is fire-and-forget, so the popup can
  // linger in Popup.curr and steal the slot from a later leader-ability popup
  // (e.g. Crach an Craite), resolving the player's click against the wrong
  // popup. Running Invader last keeps the forced-action popup away from every
  // popup-based leader case that follows.)
  {
    const t = await setup('ne_emhyr_relentless', {reEnable:true});
    for (const p of [A,B]) await p.evaluate(role=>{
      const actor = GwentOnline.playerOf(role);
      actor.deck.addCard(new Card('nr_stennis', card_dict.nr_stennis, actor));
    }, t.role);
    await activate(t);
    await t.local.waitForFunction(()=>!!Carousel.curr, null, {timeout:20000});
    await t.local.evaluate(()=>{ if (Carousel.curr) Carousel.curr.select(new Event('click')); });
    await nextCarousel(t, {minCards:1});
    await t.local.evaluate(()=>{ if (Carousel.curr) Carousel.curr.select(new Event('click')); });
    await committed(t,'emhyr_relentless destroy then draw spy');
  }

  // 4. emhyr_emperor moved to the very end (after case 28). Its ability
  // pushes a forced action onto the opponent that opens a local-only
  // "Play card/Pass" popup on the opponent's next startTurn. Online that
  // startTurn is fire-and-forget, so the popup can linger in Popup.curr and
  // steal the slot from a later leader-ability popup. Running it last keeps
  // the forced-action popup away from every popup-based case that follows.

  // 5. eredin_bringer_of_death: carousel grave unit to hand.
  {
    const t = await setup('mo_eredin_bringer_of_death', {reEnable:true});
    for (const p of [A,B]) await p.evaluate(role=>{
      const actor = GwentOnline.playerOf(role);
      const k = window.fixtureCards[0].key;
      actor.grave.addCard(new Card(k, card_dict[k], actor));
    }, t.role);
    await activate(t);
    await t.local.waitForFunction(()=>!!Carousel.curr, null, {timeout:20000});
    await t.local.evaluate(()=>{ if (Carousel.curr) Carousel.curr.select(new Event('click')); });
    await committed(t,'eredin_bringer_of_death medic carousel');
  }

  // 6. eredin_destroyer: carousel 2 hand to discard, then carousel 1 deck to hand.
  {
    const t = await setup('mo_eredin_destroyer', {reEnable:true});
    await activate(t);
    await t.local.waitForFunction(()=>!!Carousel.curr && !Carousel.curr.busy, null, {timeout:20000});
    // multi-select: pick 2, waiting for the carousel to settle between picks
    await t.local.evaluate(()=>{ if (Carousel.curr) Carousel.curr.select(new Event('click')); });
    await t.local.waitForFunction(()=>!!Carousel.curr && !Carousel.curr.busy, null, {timeout:20000}).catch(()=>{});
    await A.waitForTimeout(120);
    await t.local.evaluate(()=>{ if (Carousel.curr) Carousel.curr.select(new Event('click')); });
    await nextCarousel(t, {minCards:5});
    await A.waitForTimeout(150);
    await t.local.evaluate(()=>{ if (Carousel.curr) Carousel.curr.select(new Event('click')); });
    await committed(t,'eredin_destroyer discard then draw');
  }

  // 7. eredin_king: carousel deck weather card to weather.
  {
    const t = await setup('mo_eredin_king', {reEnable:true});
    for (const p of [A,B]) await p.evaluate(role=>{
      const actor = GwentOnline.playerOf(role);
      actor.deck.addCard(new Card('spe_frost', card_dict.spe_frost, actor));
    }, t.role);
    await activate(t);
    await t.local.waitForFunction(()=>!!Carousel.curr, null, {timeout:20000});
    await t.local.evaluate(()=>{ if (Carousel.curr) Carousel.curr.select(new Event('click')); });
    await committed(t,'eredin_king weather carousel');
  }

  // 8. crach_an_craite: popup keep card, then carousel grave (optional), reshuffle.
  {
    const t = await setup('sk_crach_an_craite', {reEnable:true});
    for (const p of [A,B]) await p.evaluate(role=>{
      const actor = GwentOnline.playerOf(role);
      const k = window.fixtureCards[0].key;
      actor.grave.addCard(new Card(k, card_dict[k], actor));
      actor.opponent().grave.addCard(new Card(k, card_dict[k], actor.opponent()));
    }, t.role);
    await activate(t);
    await t.local.waitForFunction(()=>!!Popup.curr, null, {timeout:20000});
    await t.local.evaluate(()=>Popup.curr.selectNo()); // shuffle all
    await committed(t,'crach_an_craite shuffle all');
  }

  // 9. radovid_mad_king: carousel strongest card to destroy (single max -> direct).
  {
    const t = await setup('re_radovid_mad_king', {reEnable:true, fixtureOwner:'self', fixturePerRow:1});
    await activate(t);
    // single strongest -> no carousel, direct destroy
    await committed(t,'radovid_mad_king direct destroy');
  }

  // 10. radovid_strategist: carousel own hero to hand.
  {
    const t = await setup('re_radovid_strategist', {reEnable:true, fixtureKey:'ntr_geralt'});
    await activate(t);
    await t.local.waitForFunction(()=>!!Carousel.curr, null, {timeout:20000});
    await t.local.evaluate(()=>{ if (Carousel.curr) Carousel.curr.select(new Event('click')); });
    await committed(t,'radovid_strategist hero to hand');
  }

  // 11. anna_henrietta_ladyship: needs a toussaint level-2 monster on board, carousel + destination.
  {
    const t = await setup('to_anna_henrietta_ladyship', {reEnable:true, extraFixture:[{key:'to_regis_higher_vampire', row:'close', owner:'self'}]});
    await activate(t);
    await t.local.waitForFunction(()=>!!Carousel.curr, null, {timeout:20000});
    await t.local.evaluate(()=>{ if (Carousel.curr) Carousel.curr.select(new Event('click')); });
    await t.local.waitForFunction(()=>!!GwentOnline._continuationCard, null, {timeout:20000});
    await t.local.evaluate(async()=>{
      const c = GwentOnline._continuationCard;
      await ui.selectRow(board.getRow(c, c.row, c.holder));
    });
    await committed(t,'anna_henrietta_ladyship transform + destination');
  }

  // 12. lady_wood_weavess: curse card destination.
  {
    const t = await setup('ve_lady_wood_weavess', {reEnable:true});
    for (const p of [A,B]) await p.evaluate(role=>{
      const actor = GwentOnline.playerOf(role);
      actor.deck.addCard(new Card('spe_curse', card_dict.spe_curse, actor));
    }, t.role);
    await activate(t);
    await t.local.waitForFunction(()=>!!GwentOnline._continuationCard || !!Carousel.curr, null, {timeout:20000});
    await t.local.evaluate(async()=>{
      if (GwentOnline._continuationCard) {
        const c = GwentOnline._continuationCard;
        await ui.selectRow(board.getRow(c, c.row==='weather'?'weather':c.row, c.holder));
      } else if (Carousel.curr) {
        Carousel.curr.select(new Event('click'));
      }
    });
    await committed(t,'lady_wood_weavess curse destination');
  }

  // 13. auberon_king: navigator carousel + hand carousel.
  {
    const t = await setup('wh_auberon_king', {reEnable:true});
    for (const p of [A,B]) await p.evaluate(role=>{
      const actor = GwentOnline.playerOf(role);
      actor.deck.addCard(new Card('wh_navigator_1', card_dict.wh_navigator_1, actor));
    }, t.role);
    await activate(t);
    await t.local.waitForFunction(()=>!!Carousel.curr, null, {timeout:20000});
    await t.local.evaluate(()=>{ if (Carousel.curr) Carousel.curr.select(new Event('click')); });
    await nextCarousel(t, {minCards:2});
    await t.local.evaluate(()=>{ if (Carousel.curr) Carousel.curr.select(new Event('click')); });
    await committed(t,'auberon_king navigator exchange');
  }

  // 14. baal_zebuth: carousel 2 opponent grave cards to deck.
  {
    const t = await setup('ze_baal_zebuth', {reEnable:true});
    for (const p of [A,B]) await p.evaluate(role=>{
      const actor = GwentOnline.playerOf(role);
      const k = window.fixtureCards[0].key;
      for(let i=0;i<2;i++) actor.opponent().grave.addCard(new Card(k, card_dict[k], actor.opponent()));
    }, t.role);
    await activate(t);
    await t.local.waitForFunction(()=>!!Carousel.curr && !Carousel.curr.busy, null, {timeout:20000});
    for (let i=0;i<2;i++){
      await t.local.evaluate(()=>{ if (Carousel.curr) Carousel.curr.select(new Event('click')); });
      if(i<1) await t.local.waitForFunction(()=>!!Carousel.curr && !Carousel.curr.busy, null, {timeout:20000}).catch(()=>{});
      await A.waitForTimeout(120);
    }
    await committed(t,'baal_zebuth opponent grave to deck');
  }

  // 15. radovid_king_redania: carousel 3 deck units, play one via destination.
  {
    const t = await setup('re_radovid_king_redania', {reEnable:true});
    await activate(t);
    await t.local.waitForFunction(()=>!!Carousel.curr, null, {timeout:20000});
    await t.local.evaluate(()=>{ if (Carousel.curr) Carousel.curr.select(new Event('click')); });
    await t.local.waitForFunction(()=>!!GwentOnline._continuationCard, null, {timeout:20000});
    await t.local.evaluate(async()=>{
      const c = GwentOnline._continuationCard;
      await ui.selectRow(board.getRow(c, c.row, c.holder));
    });
    await committed(t,'radovid_king_redania draw 3 play one');
  }

  // 16. anna_henrietta_duchess: carousel grave hero, then destination.
  {
    const t = await setup('to_anna_henrietta_duchess', {reEnable:true});
    for (const p of [A,B]) await p.evaluate(role=>{
      const actor = GwentOnline.playerOf(role);
      actor.grave.addCard(new Card('ntr_geralt', card_dict.ntr_geralt, actor));
    }, t.role);
    await activate(t);
    await t.local.waitForFunction(()=>!!Carousel.curr, null, {timeout:20000});
    await t.local.evaluate(()=>{ if (Carousel.curr) Carousel.curr.select(new Event('click')); });
    await t.local.waitForFunction(()=>!!GwentOnline._continuationCard, null, {timeout:20000});
    await t.local.evaluate(async()=>{
      const c = GwentOnline._continuationCard;
      await ui.selectRow(board.getRow(c, c.row, c.holder));
    });
    await committed(t,'anna_henrietta_duchess hero from grave');
  }

  // 17. anna_henrietta_little_weasel: carousel opponent hero, remove hero status.
  {
    const t = await setup('to_anna_henrietta_little_weasel', {reEnable:true, fixtureKey:'ntr_geralt', fixtureOwner:'opponent'});
    await activate(t);
    await t.local.waitForFunction(()=>!!Carousel.curr, null, {timeout:20000});
    await t.local.evaluate(()=>{ if (Carousel.curr) Carousel.curr.select(new Event('click')); });
    await committed(t,'anna_henrietta_little_weasel remove hero status');
  }

  // 18. lady_wood_whispess: multi-select up to 3 grave units to hand.
  {
    const t = await setup('ve_lady_wood_whispess', {reEnable:true});
    for (const p of [A,B]) await p.evaluate(role=>{
      const actor = GwentOnline.playerOf(role);
      const k = window.fixtureCards[0].key;
      for(let i=0;i<3;i++){
        const c=new Card(k, card_dict[k], actor);
        c.destructionRound = game.roundCount;
        actor.grave.addCard(c);
      }
    }, t.role);
    await activate(t);
    await t.local.waitForFunction(()=>!!Carousel.curr && !Carousel.curr.busy, null, {timeout:20000});
    for (let i=0;i<3;i++){
      await t.local.evaluate(()=>{ if (Carousel.curr) Carousel.curr.select(new Event('click')); });
      if(i<2) await t.local.waitForFunction(()=>!!Carousel.curr && !Carousel.curr.busy, null, {timeout:20000}).catch(()=>{});
      await A.waitForTimeout(120);
    }
    await t.local.waitForFunction(()=>!Carousel.curr, null, {timeout:20000});
    await committed(t,'lady_wood_whispess multi-select grave');
  }

  // 19. ghost_tree: destroy weakest unit (single weakest -> direct).
  {
    const t = await setup('ve_ghost_tree', {reEnable:true, fixtureOwner:'self', fixturePerRow:1});
    await activate(t);
    await committed(t,'ghost_tree destroy weakest');
  }

  // 20. eredin_commander: multi-select up to 2 own cards to hand.
  {
    const t = await setup('wh_eredin_commander', {reEnable:true, fixtureOwner:'self'});
    await activate(t);
    await t.local.waitForFunction(()=>!!Carousel.curr && !Carousel.curr.busy, null, {timeout:20000});
    for (let i=0;i<2;i++){
      await t.local.evaluate(()=>{ if (Carousel.curr) Carousel.curr.select(new Event('click')); });
      if(i<1) await t.local.waitForFunction(()=>!!Carousel.curr && !Carousel.curr.busy, null, {timeout:20000}).catch(()=>{});
      await A.waitForTimeout(120);
    }
    await t.local.waitForFunction(()=>!Carousel.curr, null, {timeout:20000});
    await committed(t,'eredin_commander multi-select to hand');
  }

  // 21. winter_queen: carousel deck special, then destination.
  // Select the added spe_fog explicitly: the deck carousel contains every
  // special (including spe_decoy), and picking the first card can choose a
  // non-weather special whose destination race desyncs both peers.
  {
    const t = await setup('wh_winter_queen', {reEnable:true});
    for (const p of [A,B]) await p.evaluate(role=>{
      const actor = GwentOnline.playerOf(role);
      actor.deck.addCard(new Card('spe_fog', card_dict.spe_fog, actor));
    }, t.role);
    await activate(t);
    await t.local.waitForFunction(()=>!!Carousel.curr || !!GwentOnline._continuationCard, null, {timeout:20000});
    await selectInCarouselByKey(t, 'spe_fog');
    await t.local.waitForFunction(()=>!!GwentOnline._continuationCard, null, {timeout:20000});
    await t.local.evaluate(async()=>{
      const c = GwentOnline._continuationCard;
      await ui.selectRow(c.row==='weather' ? weather : board.getRow(c, c.row, c.holder));
    });
    await committed(t,'winter_queen special destination');
  }

  // 22. nibras: carousel 3 deck units, play one via destination.
  {
    const t = await setup('ofir_nibras', {reEnable:true});
    await activate(t);
    await t.local.waitForFunction(()=>!!Carousel.curr, null, {timeout:20000});
    await t.local.evaluate(()=>{ if (Carousel.curr) Carousel.curr.select(new Event('click')); });
    await t.local.waitForFunction(()=>!!GwentOnline._continuationCard, null, {timeout:20000});
    await t.local.evaluate(async()=>{
      const c = GwentOnline._continuationCard;
      await ui.selectRow(board.getRow(c, c.row, c.holder));
    });
    await committed(t,'nibras draw 3 play one');
  }

  // 23. nibras_gale: carousel 3 opponent deck cards, take one to hand.
  {
    const t = await setup('ofir_nibras_gale', {reEnable:true});
    await activate(t);
    await t.local.waitForFunction(()=>!!Carousel.curr, null, {timeout:20000});
    await t.local.evaluate(()=>{ if (Carousel.curr) Carousel.curr.select(new Event('click')); });
    await committed(t,'nibras_gale opponent deck peek');
  }

  // 24. eredin_commander (wild hunt variant already covered above as 20).

  // 25. madman_lugos: round-start popup + random carousel opponent hand.
  {
    const t = await setup('sk_madman_lugos', {});
    // Replace leader already registered the roundStart effect via placed().
    await triggerRoundStart(t);
    await t.local.waitForFunction(()=>!!Popup.curr, null, {timeout:25000});
    await t.local.evaluate(()=>Popup.curr.selectYes());
    await t.local.waitForFunction(()=>!!Carousel.curr, null, {timeout:25000});
    await t.local.evaluate(()=>{ if (Carousel.curr) Carousel.curr.select(new Event('click')); });
    // round-start effects do not advance the turn sequence; verify state convergence instead.
    await Promise.all([A,B].map(p=>p.waitForFunction(()=>!GwentOnline._decisionOwner, null, {timeout:25000})));
    const states=await Promise.all([A,B].map(p=>p.evaluate(()=>GwentOnline.syncState())));
    assert(JSON.stringify(states[0])===JSON.stringify(states[1]), 'madman_lugos round-start identical state');
    assert(await t.local.evaluate(()=>!window.actionError), 'madman_lugos no action error');
  }

  // 26. king_bran: round-start popup bring the storm.
  {
    const t = await setup('sk_king_bran', {});
    for (const p of [A,B]) await p.evaluate(role=>{
      const actor = GwentOnline.playerOf(role);
      actor.deck.addCard(new Card('spe_storm', card_dict.spe_storm, actor));
    }, t.role);
    await triggerRoundStart(t);
    await t.local.waitForFunction(()=>!!Popup.curr, null, {timeout:25000});
    await t.local.evaluate(()=>Popup.curr.selectYes());
    await Promise.all([A,B].map(p=>p.waitForFunction(()=>!GwentOnline._decisionOwner, null, {timeout:25000})));
    const states=await Promise.all([A,B].map(p=>p.evaluate(()=>GwentOnline.syncState())));
    assert(JSON.stringify(states[0])===JSON.stringify(states[1]), 'king_bran round-start identical state');
    assert(await t.local.evaluate(()=>window.actionError ? 'ERR '+window.actionError : true)===true, 'king_bran no action error');
  }

  // 27. birna: carousel deck berserker/mardroeme, then destination if unit.
  {
    const t = await setup('sk_birna', {reEnable:true});
    for (const p of [A,B]) await p.evaluate(role=>{
      const actor = GwentOnline.playerOf(role);
      actor.deck.addCard(new Card('sk_young_berserker_1', card_dict.sk_young_berserker_1, actor));
    }, t.role);
    await activate(t);
    await t.local.waitForFunction(()=>!!Carousel.curr || !!GwentOnline._continuationCard, null, {timeout:20000});
    await t.local.evaluate(async()=>{
      if (Carousel.curr && !GwentOnline._continuationCard) Carousel.curr.select(new Event('click'));
    });
    await t.local.waitForFunction(()=>!Carousel.curr, null, {timeout:20000});
    // If a unit was selected, a destination carousel/selectRow opens.
    const hasContinuation = await t.local.evaluate(()=>!!GwentOnline._continuationCard);
    if (hasContinuation) {
      await t.local.evaluate(async()=>{
        const c = GwentOnline._continuationCard;
        if (c) await ui.selectRow(board.getRow(c, c.row, c.holder));
      });
    }
    await committed(t,'birna berserker draw');
  }

  // 28. storm (weather card popup): play spe_storm from hand, choose rows.
  // Use a leader with NO turnEnd/placed side-effects (radovid_mad_king is
  // activated-only) so its end-of-turn does not open an extra synced popup
  // that would block the turn handoff after the storm choice.
  {
    const t = await setup('re_radovid_mad_king', {reEnable:true}); // any leader to hold turn
    for (const p of [A,B]) await p.evaluate(role=>{
      const owner = GwentOnline.playerOf(role);
      owner.hand.addCard(new Card('spe_storm', card_dict.spe_storm, owner));
    }, t.role);
    const played = await t.local.evaluate(async()=>{
      const c = player_me.hand.cards.find(x=>x.key==='spe_storm');
      if (!c) return null;
      ui.selectCard(c);
      // Fire selectRow without awaiting: its placed() effect opens a popup
      // that must be resolved (selectYes) before selectRow can return, so
      // awaiting it here would deadlock the evaluate before the test can
      // answer the popup.
      ui.selectRow(weather);
      return c.key;
    });
    assert(!!played, 'storm weather card played');
    if (played) {
      await t.local.waitForFunction(()=>!!Popup.curr, null, {timeout:20000});
      await t.local.evaluate(()=>Popup.curr.selectYes());
      await committed(t,'storm weather popup choice');
    }
  }

  // 29. emhyr_emperor: carousel 4 random opponent hand cards.
  // Run last: its forced action can leak a lingering "Play card/Pass" popup
  // on the opponent's next startTurn (online startTurn is fire-and-forget),
  // which would steal the slot from any popup-based leader case that follows.
  {
    const t = await setup('ne_emhyr_emperor', {reEnable:true});
    await activate(t);
    await t.local.waitForFunction(()=>!!Carousel.curr, null, {timeout:20000});
    await t.local.evaluate(()=>{ if (Carousel.curr) Carousel.curr.select(new Event('click')); });
    await committed(t,'emhyr_emperor forced action carousel');
  }

  // 30. faction-ability confirm popup regression. activateFactionAbility's
  // "Use faction ability?" confirm must be a local-only UI prompt (suppressed
  // popup-wire), never a synced beginDecision, regardless of which player
  // object triggers it. If the suppression leaks, the peer that runs the
  // activate for a remote chooser opens a beginDecision and waits for a
  // popup-choice that never arrives -> "Timed out waiting for popup choice
  // (...:faction:...:activate:popup:0)". Exercise both the currPlayer path
  // (legit use) and the non-currPlayer path (inspecting/cancelling) and verify
  // no desync, no pending popup waiters, and the match stays active.
  for (const scenario of ['curr','noncurr']) {
    const t = await setup('re_radovid_mad_king', {reEnable:true});
    for (const p of [A,B]) await p.evaluate((arg)=>{
      const actor = GwentOnline.playerOf(arg.role);
      actor.deck.faction = 'redania';
      actor.factionAbilityUses = 1;
      const btn = document.getElementById('faction-ability-'+actor.tag);
      if (btn) { btn.classList.remove('hide','fade','noclick'); }
      window.__facErr = null;
      window.__facDone = false;
      window.__sentChoices = [];
      const origSend = GwentOnline.send.bind(GwentOnline);
      GwentOnline.send = function(m){ if(m && m.t==='popup-choice') window.__sentChoices.push(m); return origSend(m); };
    }, {role:t.role});
    const targetPeer = scenario==='curr' ? t.local : t.remote;
    await targetPeer.evaluate(()=>{
      const me = player_me;
      me.activateFactionAbility().then(()=>window.__facDone=true, e=>window.__facErr=String(e));
    });
    await targetPeer.waitForFunction(()=>!!Popup.curr, null, {timeout:20000}).catch(()=>{});
    await targetPeer.evaluate(()=>{ if (Popup.curr) Popup.curr.selectNo(); });
    await targetPeer.waitForFunction(()=>window.__facDone, null, {timeout:20000});
    await A.waitForTimeout(600);
    // No popup-choice should have been sent (confirm popup is local-only).
    const sent = await targetPeer.evaluate(()=>window.__sentChoices);
    assert(sent.length===0, scenario+' faction confirm popup sent no popup-choice ('+sent.length+')');
    // No peer should be left waiting on a faction:activate popup decision.
    const [wa, wb] = await Promise.all([A,B].map(p=>p.evaluate(()=>GwentOnline.waiters.filter(w=>w.types && w.types.includes && w.types.includes('popup-choice')).length || 0)));
    assert(wa===0 && wb===0, scenario+' no peer waits on faction:activate popup (A='+wa+' B='+wb+')');
    assert(await A.evaluate(()=>GwentOnline.active) && await B.evaluate(()=>GwentOnline.active), scenario+' match active after faction confirm cancel');
    assert(await targetPeer.evaluate(()=>!window.__facErr), scenario+' no activate error');
  }

  assert(errs.A.length===0,'no host errors '+errs.A.join(' | '));
  assert(errs.B.length===0,'no guest errors '+errs.B.join(' | '));
  if(failed) throw Error('Leader regression assertions failed');
  console.log('RESULT: LEADER ABILITY REGRESSIONS PASS');
})().catch(e=>{console.error('FATAL',e);process.exitCode=1;}).finally(async()=>{
  if(cleanupBrowser) await cleanupBrowser.close();
  if(cleanupServer) cleanupServer.kill();
});
