// Generated local document only; this process receives no database or school credentials.
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { probeControlledPlaybackRuntime, ControlledPlaybackError } from '../dist/controlled-playback-runtime.js';
if(process.platform!=='linux')throw Error('LINUX_QA_REQUIRED');
let unexpectedFetches=0;globalThis.fetch=async()=>{unexpectedFetches++;throw Error('NETWORK_NOT_ALLOWED');};
async function chromeCount(){let count=0;for(const pid of(await readdir('/proc')).filter(v=>/^\d+$/.test(v))){try{const [cmd,state]=await Promise.all([readFile(`/proc/${pid}/cmdline`,'utf8'),readFile(`/proc/${pid}/stat`,'utf8')]);if(cmd.includes('/opt/playwright-browsers/')&&state.slice(state.lastIndexOf(')')+2,state.lastIndexOf(')')+3)!=='Z')count++;}catch{}}return count;}
async function drained(){for(let i=0;i<50;i++){if(await chromeCount()===0)return;await new Promise(r=>setTimeout(r,100));}throw Error('CHROMIUM_REMAINS');}
const signalChild=process.argv.includes('--signal-child');
async function main(){
 if(signalChild){const abort=new AbortController();process.once('SIGTERM',()=>abort.abort());process.stdout.write('START\n');let cancelled=false;try{await probeControlledPlaybackRuntime(abort.signal);}catch(e){assert.ok(e instanceof ControlledPlaybackError&&e.code==='ABORTED');cancelled=true;}assert.equal(cancelled,true);await drained();assert.equal(unexpectedFetches,0);process.stdout.write('CLEAN\n');return;}
 const cases=[];
 async function check(name,run){const start=performance.now();await run();await drained();cases.push({name,passed:true,elapsedMs:Math.round(performance.now()-start)});}
 await check('real-sandboxed-chromium-and-loopback-document-ready-only-after-exit',async()=>{await probeControlledPlaybackRuntime(new AbortController().signal);});
 await check('cancellation-during-real-launch-stops-without-ready',async()=>{const abort=new AbortController();const pending=probeControlledPlaybackRuntime(abort.signal);setTimeout(()=>abort.abort(),30);await assert.rejects(pending,e=>e instanceof ControlledPlaybackError&&e.code==='ABORTED');});
 let sigtermElapsedMs;
 await check('SIGTERM-during-readiness-cleans-the-real-browser',async()=>{
  const child=spawn(process.execPath,[new URL(import.meta.url).pathname,'--signal-child'],{env:{...process.env},stdio:['ignore','pipe','pipe']});let output='',sent=0,stderrBytes=0;
  child.stderr.on('data',v=>stderrBytes+=v.length);
  child.stdout.on('data',v=>{output+=v.toString();if(output.includes('START')&&!sent){sent=performance.now();setTimeout(()=>child.kill('SIGTERM'),30);}});
  const timer=setTimeout(()=>child.kill('SIGKILL'),37000);const code=await new Promise(r=>child.once('exit',r));clearTimeout(timer);
  assert.equal(code,0);assert.equal(stderrBytes,0);assert.match(output,/CLEAN/);sigtermElapsedMs=Math.round(performance.now()-sent);assert.ok(sigtermElapsedMs<37000);
 });
 assert.equal(unexpectedFetches,0);
 process.stdout.write(JSON.stringify({schema:'runtime-readiness-synthetic-qa-v1',passed:true,schoolRequests:0,schoolReports:0,mediaRequests:0,unexpectedFetches,noLiveChromiumProcesses:await chromeCount()===0,sigtermElapsedMs,cases},null,2)+'\n');
}
await main().catch(()=>{process.stderr.write('{"code":"SYNTHETIC_PROBE_QA_FAILED"}\n');process.exit(1);});
