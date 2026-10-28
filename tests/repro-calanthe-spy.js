"use strict";
// Regression test for Queen Calanthe: Lioness of Cintra leader ability + Spy
// unit (PvE). Bug: the ability called autoplay() without a source container
// and then removed the played card from the hand afterwards. The late
// hand.removeCard() spliced the card's DOM element back out of the row it was
// just placed in, so the played card (e.g. a spy) became invisible while still
// counting towards the row score. The AI's automatic turn logic is disabled so
// the tested actions are deterministic; carousel choices are driven directly.

const { chromium } = require('playwright-core');
const { spawn } = require('child_process');
const path = require('path');

const PORT = process.env.TEST_PORT || '18093';
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
    const onr = premade_deck.find(d=>d.faction==='old_realms' && d.leader==='onr_queen_calanthe');
    dm.deckFromJSON(JSON.parse(JSON.stringify(onr)), false);
    dm.startNewGame(1);
  });

  await page.waitForFunction(()=>Carousel.curr, null, {timeout:10000});
  await page.evaluate(()=>Carousel.curr.cancel());
  await page.waitForFunction(()=>game.roundCount>=1 && player_me && player_op && !Carousel.curr, null, {timeout:20000});

  // Deterministic environment: silence notifications and disable the AI's
  // automatic startTurn for the whole test.
  await page.evaluate(()=>{
    window.__origStartTurn = player_op.controller.startTurn;
    window.__origNotif = ui.notification;
    player_op.controller.startTurn = async () => {};
    ui.notification = async () => {};
    game.currPlayer = player_me;
  });

  // Runs the leader ability (real entry point) without awaiting the outer
  // promise, selects pickKey in the carousel that opens, and waits until the
  // whole ability has settled.
  async function runLeaderWithPick(pickKey, preAdd) {
    const base = await page.evaluate(async ([key, preAddSrc])=>{
      window.__leaderDone = false;
      window.__leaderErr = null;
      if (preAddSrc) {
        const add = new Function(preAddSrc);
        add();
      }
      const handBefore = player_me.hand.cards.length;
      const deckBefore = player_me.deck.cards.length;
      player_me.activateLeader(true, true)
        .then(()=>{ window.__leaderDone = true; })
        .catch(e=>{ window.__leaderErr = String(e); window.__leaderDone = true; });
      await sleepUntil(()=>Carousel.curr && Carousel.curr.container && Carousel.curr.container.cards.length > 0, 100);
      const c = Carousel.curr;
      const pos = c.indices.findIndex(i => c.container.cards[i] && c.container.cards[i].key === key);
      c.index = pos >= 0 ? pos : 0;
      c.select(new Event('click'));
      await sleepUntil(()=>window.__leaderDone, 100);
      return { handBefore, deckBefore, err: window.__leaderErr };
    }, [pickKey, preAdd]);
    const after = await page.evaluate(()=>({
      handAfter: player_me.hand.cards.length,
      deckAfter: player_me.deck.cards.length,
      findOnBoard: key => { const c = board.row.flatMap(r=>r.cards).find(x=>x.key===key); return c && {
        row: board.row.findIndex(r=>r.cards.includes(c)),
        holder: c.holder.tag,
        inHand: player_me.hand.cards.includes(c),
        visibleOnBoard: c.currentLocation instanceof Row && c.currentLocation.elem.contains(c.elem)
      }; }
    }));
    return {...base, ...after};
  }

  // ---------- Case 1: leader ability with a spy unit in hand ----------
  let res = await runLeaderWithPick('onr_cintrian_envoy', `
    game.currPlayer = player_me;
    const spy = new Card('onr_cintrian_envoy', card_dict['onr_cintrian_envoy'], player_me);
    player_me.hand.addCard(spy);
  `);
  const spyState = await page.evaluate(key=>{ const c = board.row.flatMap(r=>r.cards).find(x=>x.key===key); return c && {
    row: board.row.findIndex(r=>r.cards.includes(c)),
    holder: c.holder.tag,
    inHand: player_me.hand.cards.includes(c),
    visibleOnBoard: c.currentLocation instanceof Row && c.currentLocation.elem.contains(c.elem)
  }; }, 'onr_cintrian_envoy');
  res.spy = spyState;
  log({case1_leader_spy: res});
  if (res.err) { console.log('CASE1 ERROR: '+res.err); process.exitCode = 1; }
  else {
    assert(res.spy && res.spy.row >= 0 && res.spy.row <= 2, 'Spy is placed on the opponent half (rows 0-2)');
    assert(res.spy && res.spy.holder === 'op', 'Spy holder switched to the opponent');
    assert(res.spy && res.spy.inHand === false, 'Spy is no longer in the hand');
    assert(res.spy && res.spy.visibleOnBoard, 'Spy card element is visible on the board (still in its row DOM)');
    assert(res.deckAfter === res.deckBefore - 3, 'Deck lost 3 cards (2 spy draws + 1 leader draw)');
  }

  // ---------- Case 2: leader ability with a plain unit in hand ----------
  let res2 = await runLeaderWithPick('onr_vissegerd', `
    game.currPlayer = player_me;
    player_me.leaderAvailable = true;
    const unit = new Card('onr_vissegerd', card_dict['onr_vissegerd'], player_me);
    player_me.hand.addCard(unit);
  `);
  res2.unit = await page.evaluate(key=>{ const c = board.row.flatMap(r=>r.cards).find(x=>x.key===key); return c && {
    row: board.row.findIndex(r=>r.cards.includes(c)),
    holder: c.holder.tag,
    inHand: player_me.hand.cards.includes(c),
    visibleOnBoard: c.currentLocation instanceof Row && c.currentLocation.elem.contains(c.elem)
  }; }, 'onr_vissegerd');
  log({case2_leader_unit: res2});
  if (res2.err) { console.log('CASE2 ERROR: '+res2.err); process.exitCode = 1; }
  else {
    assert(res2.unit && res2.unit.row >= 3 && res2.unit.row <= 5, 'Plain unit is placed on own half (rows 3-5)');
    assert(res2.unit && res2.unit.inHand === false, 'Plain unit is no longer in the hand');
    assert(res2.unit && res2.unit.visibleOnBoard, 'Plain unit card element is visible on the board');
    assert(res2.deckAfter === res2.deckBefore - 1, 'Deck lost 1 card (leader draw)');
  }

  await page.close();
  await browser.close();
  server.kill('SIGTERM');
  if (process.exitCode) console.log('FAILURES DETECTED');
  else console.log('ALL OK');
  process.exit(process.exitCode || 0);
})().catch(e=>{ console.error(e); process.exit(1); });
