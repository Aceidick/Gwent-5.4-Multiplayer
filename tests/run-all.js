"use strict";
const fs = require('fs');
const path = require('path');
const {spawnSync} = require('child_process');
const root = path.resolve(__dirname,'..');
const out = path.join(root,'test-results');
fs.mkdirSync(out,{recursive:true});
const suites = ['static-audit.js','e2e-online.js','e2e-board-decisions.js','e2e-carousel.js','e2e-turn-input.js','e2e-endscreen.js'];
const results = [];
for (const suite of suites) {
  const started = Date.now();
  const result = spawnSync(process.execPath,[path.join(__dirname,suite)], {
    cwd:root,env:process.env,encoding:'utf8',timeout:300000,maxBuffer:16*1024*1024
  });
  const log = (result.stdout || '') + (result.stderr || '');
  fs.writeFileSync(path.join(out,suite+'.log'),log);
  const entry = {suite,passed:result.status===0,assertions:(log.match(/^PASS /gm)||[]).length,
    seconds:Math.round((Date.now()-started)/1000),error:result.error?.message || null};
  results.push(entry);
  console.log(JSON.stringify(entry));
  if (!entry.passed) break;
}
fs.writeFileSync(path.join(out,'summary.json'),JSON.stringify({version:'1.4.2',time:new Date().toISOString(),results},null,2)+'\n');
process.exitCode = results.length===suites.length && results.every(r=>r.passed) ? 0 : 1;
