"use strict";
// Regression test for the two reported player-vs-computer issues with Skellige
// leader Holger an Dimun: Blackhand against a Novigrad AI (Sigismund Dijkstra):
// 1. After playing the LAST card, the Holger end-of-turn strength edit popup
//    must still be offered (leader ability usable after the last card).
// 2. After the player uses the Holger edit, the AI's next turn must proceed
//    without freezing (regression: ControllerAI.cull called this.playCull,
//    crashing the AI turn chain when the AI played the Cull special card).
const { chromium } = require('playwright-core');
const { spawn } = require('child_process');
const path = require('path');
const PORT = process.env.TEST_PORT || '18081';
const URL = `http://127.0.0.1:${PORT}`;

function assert(v, label) { console.log(`${v?'PASS':'FAIL'} ${label}`); if (!v) process.exitCode = 1; }
const wait = ms => new Promise(r=>setTimeout(r,ms));

(async()=>{
  const server = spawn(process.execPath, [path.join(__dirname,'..','server','server.js')],
    {env:{...process.env, PORT}, cwd:path.join(__dirname,'..'), stdio:['ignore','pipe','pipe']});
  await new Promise(r=>setTimeout(r,800));
  const browser = await chromium.launch({headless:true, executablePath:'/home/appuser/.cache/ms-playwright/chromium-1243/chrome-linux64/chrome', args:['--no-sandbox']});
  const page = await (await browser.newContext({viewport:{width:1920,height:1080}})).newPage();
  const pageErrors=[];
  page.on('pageerror', e=>{ pageErrors.push(String(e)); console.log('PAGE ERROR:', String(e)); });

  await page.goto(URL);
  await page.waitForFunction(()=>typeof dm!=='undefined'&&typeof premade_deck!=='undefined', null, {timeout:20000});
  await page.evaluate(()=>{
    const sk = premade_deck.find(d=>d.leader==='sk_holger');
    dm.deckFromJSON(JSON.parse(JSON.stringify(sk)), false);
    const nv = premade_deck.find(d=>d.leader==='nv_sigismund2' && d.cards.some(c=>c[0]==='nv_hubert_rejk'));
    dm.start_op_deck = JSON.parse(JSON.stringify(nv));
    dm.start_op_deck.cards = dm.start_op_deck.cards.map(c=>({index:c[0], count:c[1]}));
    dm.start_op_deck.leader = {index:'nv_sigismund2', card:card_dict.nv_sigismund2};
    game.randomOPDeck = false;
    dm.startNewGame(1);
  });
  // Cancel the opening redraw carousel
  await page.waitForFunction(()=>Carousel.curr, null, {timeout:10000});
  await page.evaluate(()=>Carousel.curr.cancel());
  await page.waitForFunction(()=>game.roundCount>=1 && player_me && player_op && !Carousel.curr, null, {timeout:20000});
  console.log('Opp leader:', await page.evaluate(()=>player_op.leader.name), '| AI:', await page.evaluate(()=>player_op.controller instanceof ControllerAI));

  // Round 1: the human passes immediately; the AI takes the round.
  await page.evaluate(async ()=>{
    const wait = ms => new Promise(r=>setTimeout(r,ms));
    for (let i=0;i<60 && game.roundCount===1;i++) {
      if (game.currPlayer === player_me && !player_me.passed) await player_me.passRound();
      await wait(250);
    }
  });
  await page.waitForFunction(()=>game.roundCount===2, null, {timeout:30000});

  // Round 2: give the player three units; the AI keeps its Novigrad deck
  // (including Hubert Rejk and its special cards such as Cull).
  await page.evaluate(()=>{
    player_me.capabilities.cardEdit = 2;
    while (player_me.hand.cards.length) player_me.deck.addCard(player_me.hand.cards.pop());
    const units = Object.keys(card_dict).filter(k=>card_dict[k].deck==='skellige'&&card_dict[k].row==='close'&&Number(card_dict[k].strength)>0);
    const four = units.find(k=>Number(card_dict[k].strength)===4) || units[0];
    [four, ...units.filter(k=>k!==four).slice(0,2)].forEach(k=>{
      player_me.hand.addCard(new Card(k, card_dict[k], player_me));
    });
    board.updateScores();
  });

  // Play round 2 like a human: play each card, answer the Holger popup each
  // time (including after the LAST card), finish the edit, then wait for the
  // AI to act and the round to end.
  const result = await page.evaluate(async ()=>{
    const wait = ms => new Promise(r=>setTimeout(r,ms));
    const timeout = Date.now() + 90000;
    const events = [];
    let sawPopupAfterLastCard = false;
    let played = 0;
    while (Date.now() < timeout) {
      if (game.roundCount !== 2) { events.push('round->'+game.roundCount); break; }
      const myTurn = game.currPlayer === player_me && !player_me.passed;
      if (ui.underCardPowerEdit) {
        const target = player_me.getAllRowCards().find(c=>c.basePower===4) || player_me.getAllRowCards()[0];
        if (target) ui.selectCard(target);
        let w=0; while(!NumberValuePopup.curr && w<6000){await wait(100);w+=100;}
        if (NumberValuePopup.curr) { document.getElementById('number-popup-value').value='10'; NumberValuePopup.curr.done(); events.push('edit->10'); }
        await wait(200);
        continue;
      }
      if (Popup.curr) {
        events.push('popup: '+document.getElementById('popup').children[0].children[0].innerHTML);
        Popup.curr.selectYes();
        await wait(200);
        continue;
      }
      if (myTurn && player_me.hand.cards.length > 0) {
        const card = player_me.hand.cards[0];
        const isLast = player_me.hand.cards.length === 1;
        const p = player_me.playCard(card);
        played++;
        events.push('play #'+played+' '+card.key+(isLast?' (LAST)':''));
        if (isLast) {
          // Wait for the Holger popup after the last card
          let w=0; while(!Popup.curr && !ui.underCardPowerEdit && w<10000){await wait(100);w+=100;}
          sawPopupAfterLastCard = !!Popup.curr || ui.underCardPowerEdit;
        }
        await p;
      } else if (myTurn && !player_me.passed) {
        events.push('me passes');
        await player_me.passRound();
      } else {
        await wait(150);
      }
    }
    return {
      events,
      sawPopupAfterLastCard,
      round: game.roundCount,
      endScreen: !document.getElementById('end-screen').classList.contains('hide'),
      healthMe: player_me.health,
    };
  });
  for (const e of result.events) console.log('  '+e);
  console.log('Final: round', result.round, 'endScreen', result.endScreen, 'my health', result.healthMe);
  assert(result.sawPopupAfterLastCard, 'Holger popup offered after the last card is played');
  assert(result.round === 3 || result.endScreen, 'game progressed past round 2 without freezing');
  assert(!pageErrors.some(e=>e.includes('playCull')), 'AI turn chain no longer crashes on playCull');
  assert(pageErrors.length===0, 'no page errors: ' + pageErrors.join(' | '));

  await browser.close();
  server.kill();
  process.exit(process.exitCode||0);
})().catch(e=>{console.error('FATAL', e); process.exitCode=1; process.exit(1);});
