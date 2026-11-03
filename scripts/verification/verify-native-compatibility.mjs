import assert from 'node:assert/strict';
import {spawn,execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {mkdtemp,mkdir,readFile,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {query} from '@anthropic-ai/claude-agent-sdk';
import {createRuntimeAdapters} from '../../dist/src/agents/runtime-adapters.js';
import {stopRuntimeTree} from '../../dist/src/agents/native-runtime.js';
import {executableOnPath} from '../../src/infrastructure/executable.mjs';
const output=await mkdtemp(join(tmpdir(),'apix-native-compatibility-')),database=new DatabaseSync(':memory:');
const adapters=createRuntimeAdapters({db:database,row:(q,...p)=>database.prepare(q).get(...p),rows:(q,...p)=>database.prepare(q).all(...p),now:()=>new Date().toISOString()},executableOnPath);
const environment=Object.fromEntries(Object.entries(process.env).filter(([key])=>!/KEY|TOKEN|SECRET|PASSWORD|BASE_URL/i.test(key)));
const report={observedAt:new Date().toISOString(),platform:process.platform,node:process.versions.node,paidTurns:0,output,codex:{},claude:{}};
for(const runtime of ['codex','claude']){
 const probeStarted=performance.now();const command=adapters.command(runtime);if(!command){report[runtime]={state:'unavailable'};continue;}
 const {stdout}=await promisify(execFile)(command.executable,[...command.prefix,'--version'],{windowsHide:true,timeout:15000});report[runtime].version=stdout.trim().slice(0,100);
 if(runtime==='codex'){
  const schema=join(output,'codex-schema');await promisify(execFile)(command.executable,[...command.prefix,'app-server','generate-json-schema','--out',schema],{windowsHide:true,timeout:20000});
  const client=await readFile(join(schema,'ClientRequest.json'),'utf8'),server=await readFile(join(schema,'ServerRequest.json'),'utf8');
  report.codex.methods=Object.fromEntries(['thread/start','thread/resume','turn/start','turn/steer','turn/interrupt'].map(method=>[method,client.includes('"'+method+'"')]));assert(Object.values(report.codex.methods).every(Boolean));report.codex.questionSchema=server.includes('item/tool/requestUserInput');
  const handshakeStarted=performance.now();const home=join(output,'codex-home');await mkdir(home);const child=spawn(command.executable,[...command.prefix,'-c','project_doc_max_bytes=0','-c','agents.enabled=false','-c','features.multi_agent=false','app-server','--listen','stdio://'],{cwd:output,env:{...environment,CODEX_HOME:home},windowsHide:true,detached:process.platform!=='win32',stdio:['pipe','pipe','pipe']});let buffer='',timer;
  try{report.codex.initialize=await new Promise((resolve,reject)=>{timer=setTimeout(()=>reject(new Error('握手超时')),15000);child.on('error',reject);child.stdout.setEncoding('utf8');child.stderr.resume();child.stdout.on('data',chunk=>{buffer+=chunk;let i;while((i=buffer.indexOf('\n'))>=0){const line=buffer.slice(0,i);buffer=buffer.slice(i+1);const value=JSON.parse(line);if(value.id===1){if(value.error)reject(new Error('握手被拒绝'));else resolve(true);}}});child.stdin.write(JSON.stringify({id:1,method:'initialize',params:{clientInfo:{name:'apix_readonly_probe',version:'0.3.2'},capabilities:{}}})+'\n');});}finally{clearTimeout(timer);report.codex.initializeMs=Math.round(performance.now()-handshakeStarted);const stopStarted=performance.now();report.codex.stopEvidence=await stopRuntimeTree(child);report.codex.stopMs=Math.round(performance.now()-stopStarted);}
 }else{
  const handshakeStarted=performance.now();const home=join(output,'claude-home');await mkdir(home);let release,child,timer;
  const session=query({prompt:(async function*(){await new Promise(resolve=>release=resolve);})(),options:{cwd:output,pathToClaudeCodeExecutable:command.prefix[0]??command.executable,env:{...environment,CLAUDE_CONFIG_DIR:home,ANTHROPIC_API_KEY:'apix-offline-probe'},settingSources:[],settings:{disableAllHooks:true},tools:[],spawnClaudeCodeProcess(options){child=spawn(options.command,options.args,{cwd:options.cwd,env:options.env,windowsHide:true,detached:process.platform!=='win32',stdio:['pipe','pipe','pipe']});return child;}}});
  try{const commands=await Promise.race([session.supportedCommands(),new Promise((_,reject)=>timer=setTimeout(()=>reject(new Error('SDK 握手超时')),15000))]);report.claude.initialize=true;report.claude.commandCount=commands.length;report.claude.sdkVersion='0.3.314';}catch(error){report.claude.initialize=false;report.claude.error=error.message;}finally{clearTimeout(timer);report.claude.rootExitedBeforeClose=child?.exitCode!==null||child?.signalCode!==null;report.claude.initializeMs=Math.round(performance.now()-handshakeStarted);const stopStarted=performance.now();report.claude.stopEvidence=await stopRuntimeTree(child);report.claude.stopMs=Math.round(performance.now()-stopStarted);report.claude.exitCode=child?.exitCode??null;report.claude.signal=child?.signalCode??null;release?.();session.close();}
 }
 report[runtime].probeElapsedMs=Math.round(performance.now()-probeStarted);
}
database.close();await writeFile(join(output,'report.json'),JSON.stringify(report,null,2));console.log(JSON.stringify(report));
