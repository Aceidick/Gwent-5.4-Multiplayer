"use strict";
// Regression test for "Aamad, the Wise" (ofir_aamad) leader ability feedback.
// Bug: every draw added +1 to player.total but the visible total score DOM was
// never updated (only board.updateLeader ran) and no counter existed, so the
// player could not tell whether the passive ability was active at all.
// Fix: draws go through player.updateTotal(1) (syncs DOM) and a dedicated
// badge (#aamad-bonus-<tag>) shows the accumulated round bonus, resetting on
// round start and player reset.
const { chromium } = require('playwright-core');
const { spawn } = require('child_process');
const path = require('path');
const PORT = process.env.TEST_PORT || '18097';
const URL = `http://127.0.0.1:${PORT}`;
function assert(v, label) { console.log(`${v?'PASS':'FAIL'} ${label}`); if (!v) process.exitCode = 1; }
const log = o => console.log(JSON.stringify(o));

(async()=>{
  const server = spawn(process.execPath, [path.join(__dirname,'..','server','server.js')],
    {env:{...process.env, PORT}, cwd:path.join(__dirname,'..'), stdio:['ignore','pipe','pipe']});
  await new Promise(r=>setTimeout(r,800));
  const browser = await chromium.launch({headless:true, executablePath:'/home/appuser/.cache/ms-playwright/chromium_headless_shell-1243/chrome-headless-shell-linux64/chrome-headless-shell', args:['--no-sandbox']});
  const page = await (await browser.newContext({viewport:{width:1920,height:1080}})).newPage();
  page.on('pageerror', e=>{ console.log('PAGE ERROR:', String(e)); process.exitCode = 1; });
  await page.goto(URL);
  await page.waitForFunction(()=>typeof dm!=='undefined'&&typeof premade_deck!=='undefined', null, {timeout:20000});
  await page.evaluate(()=>{
    const ofir = premade_deck.find(d=>d.faction==='ofir' && d.leader==='ofir_aamad_wise');
    dm.deckFromJSON(JSON.parse(JSON.stringify(ofir)), false);
    dm.startNewGame(1);
  });
  await page.waitForFunction(()=>Carousel.curr, null, {timeout:10000});
  await page.evaluate(()=>Carousel.curr.cancel());
  await page.waitForFunction(()=>game.roundCount>=1 && player_me && player_op && !Carousel.curr, null, {timeout:20000});

  const state = await page.evaluate(()=>{
    const badge = document.getElementById('aamad-bonus-me');
    const score = document.getElementById('score-total-me').children[0];
    return {
      hasBadge: !!badge,
      badgeHidden: badge && badge.classList.contains('hide'),
      badgeText: badge && badge.innerHTML,
      scoreText: score.innerHTML,
      aamadBonus: player_me.aamadBonus,
      total: player_me.total,
      patched: !!(player_me.deck.draw && player_me.deck.draw._isPatched)
    };
  });
  log({after_game_start: state});
  assert(state.patched, 'Aamad deck.draw is patched at game start');
  assert(state.hasBadge, 'Aamad bonus badge element exists');
  // The opening hand is drawn before the gameStart effect installs the patch,
  // so the badge correctly starts hidden at +0.
  assert(state.aamadBonus === 0, 'Bonus starts at 0 (opening hand predates the patch)');
  assert(state.badgeHidden === true, 'Badge starts hidden while bonus is 0');

  // One extra draw (same path Ofiri Envoy uses) must increment score DOM + badge.
  const afterDraw = await page.evaluate(async ()=>{
    await player_me.deck.draw(player_me.hand);
    const badge = document.getElementById('aamad-bonus-me');
    return {
      aamadBonus: player_me.aamadBonus,
      total: player_me.total,
      scoreText: document.getElementById('score-total-me').children[0].innerHTML,
      badgeText: badge.innerHTML,
      badgeHidden: badge.classList.contains('hide')
    };
  });
  log({after_extra_draw: afterDraw});
  assert(afterDraw.aamadBonus === 1, 'Extra draw raises aamadBonus to 1');
  assert(afterDraw.total === 1, 'Extra draw raises total model to 1');
  assert(String(afterDraw.scoreText) === '1', 'Extra draw raises the visible total score (bonus is visible)');
  assert(afterDraw.badgeText === '+1' && afterDraw.badgeHidden === false, 'Badge shows +1 and is visible');

  // Round start must reset bonus, badge and keep DOM score in sync.
  const afterRound = await page.evaluate(async ()=>{
    await game.runEffects(game.roundStart);
    await board.updateScores();
    const badge = document.getElementById('aamad-bonus-me');
    return {
      aamadBonus: player_me.aamadBonus,
      total: player_me.total,
      scoreText: document.getElementById('score-total-me').children[0].innerHTML,
      badgeHidden: badge.classList.contains('hide')
    };
  });
  log({after_round_start: afterRound});
  assert(afterRound.aamadBonus === 0, 'Round start resets aamadBonus to 0');
  assert(afterRound.total === 0, 'Round start subtracts the bonus from total');
  assert(afterRound.badgeHidden === true, 'Badge hides after round reset');
  assert(String(afterRound.scoreText) === '0', 'Visible score returns to 0 after round reset');

  // Player.reset (restart/give-up path) must also clear bonus and hide badge.
  const afterReset = await page.evaluate(()=>{
    player_me.aamadBonus = 3;
    player_me.updateTotal(3);
    updateAamadCounterUI(player_me, false);
    const before = {
      badgeHidden: document.getElementById('aamad-bonus-me').classList.contains('hide')
    };
    player_me.reset();
    const badge = document.getElementById('aamad-bonus-me');
    return {
      beforeVisible: before.badgeHidden === false,
      aamadBonus: player_me.aamadBonus,
      badgeHidden: badge.classList.contains('hide'),
      scoreText: document.getElementById('score-total-me').children[0].innerHTML
    };
  });
  log({after_player_reset: afterReset});
  assert(afterReset.beforeVisible, 'Badge visible before reset when bonus set manually');
  assert(afterReset.aamadBonus === 0, 'Player.reset clears aamadBonus');
  assert(afterReset.badgeHidden === true, 'Player.reset hides the badge');

  await browser.close();
  server.kill();
  process.exit(process.exitCode || 0);
})().catch(e=>{ console.error('FATAL', e); process.exit(1); });
