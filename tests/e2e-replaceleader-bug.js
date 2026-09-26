"use strict";
// Verify replaceLeader wraps new leader's lifecycle hooks (Wild Hunt bug #3 root).
// Simulate the Wild Hunt round-start leader swap and confirm the new leader's
// turnEnd hook is wrapped (has __onlineEffectContext) so it won't run with a
// null "turn" context that diverges the global decision serial.
const { chromium } = require('playwright-core');
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const PORT = '19075';
const URL = `http://127.0.0.1:${PORT}`;
let cleanupBrowser, cleanupServer;
function chromePath() {
  for (const p of ['/home/appuser/.cache/ms-playwright/chromium-1243/chrome-linux64/chrome']) if (fs.existsSync(p)) return p;
  throw new Error('no chrome');
}
(async()=>{
  const server = spawn(process.execPath, [path.join(__dirname,'..','server','server.js')], {env:{...process.env, PORT}, cwd:path.join(__dirname,'..'), stdio:['ignore','pipe','pipe']});
  cleanupServer = server;
  await new Promise(r=>setTimeout(r,800));
  const browser = await chromium.launch({headless:true, executablePath:chromePath(), args:['--no-sandbox']});
  cleanupBrowser = browser;
  const A = await (await browser.newContext()).newPage();
  const B = await (await browser.newContext()).newPage();
  await A.goto(URL); await B.goto(URL);
  await A.click('#button_start_friend'); await B.click('#button_start_friend');
  await A.waitForFunction(()=>typeof dm!=='undefined',null,{timeout:30000});
  await B.waitForFunction(()=>typeof dm!=='undefined',null,{timeout:30000});
  await A.click('#start-pvp-game'); await B.click('#start-pvp-game');
  await A.click('#online-create');
  await A.waitForFunction(()=>/^[2-9A-Z]{5}$/.test(document.getElementById('online-room-code').textContent));
  const code=(await A.textContent('#online-room-code')).trim();
  await B.fill('#online-code-input',code); await B.click('#online-join');
  await B.waitForFunction(()=>OnlineNet.role==='guest');
  await A.click('#online-close'); await B.click('#online-close');
  await A.waitForFunction(()=>!document.getElementById('start-game').disabled);
  await A.click('#start-game'); await B.click('#start-game');
  await A.waitForFunction(()=>GwentOnline.active); await B.waitForFunction(()=>GwentOnline.active);
  await A.waitForFunction(()=>typeof Carousel!=='undefined'&&Carousel.curr);
  await B.waitForFunction(()=>typeof Carousel!=='undefined'&&Carousel.curr);
  await A.evaluate(()=>Carousel.curr&&Carousel.curr.cancel());
  await B.evaluate(()=>Carousel.curr&&Carousel.curr.cancel());
  await A.waitForFunction(()=>game.roundCount===1&&game.currPlayer);
  await B.waitForFunction(()=>game.roundCount===1&&game.currPlayer);
  await A.waitForTimeout(2500);

  const role = await A.evaluate(()=>GwentOnline.roleOfPlayer(game.currPlayer));
  console.log('currPlayer role:', role);

  // Replace the actor's leader with sk_holger (which pushes a turnEnd hook in placed).
  for (const p of [A,B]) await p.evaluate((lr)=>{
    const actor = GwentOnline.playerOf(lr);
    actor.replaceLeader(new Card('sk_holger', card_dict['sk_holger'], actor));
  }, role);

  // Inspect the turnEnd hooks: sk_holger's hook should now be wrapped.
  for (const [tag,p] of [['A',A],['B',B]]) {
    const info = await p.evaluate((lr)=>{
      const actor = GwentOnline.playerOf(lr);
      return game.turnEnd.map((fn,i)=>({ idx:i, wrapped: !!fn?.__onlineOwnerWrapped, ctx: fn?.__onlineEffectContext||null, role: fn?.__onlineOwnerRole||null }));
    }, role);
    console.log(tag, 'turnEnd hooks:', JSON.stringify(info));
  }
})().catch(e=>console.error('FATAL',e)).finally(async()=>{ if(cleanupBrowser) await cleanupBrowser.close(); if(cleanupServer) cleanupServer.kill(); });
