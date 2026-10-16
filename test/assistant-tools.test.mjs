import {test} from 'node:test';import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,rmSync,symlinkSync} from 'node:fs';import {join,resolve} from 'node:path';import {tmpdir} from 'node:os';
import {fileTool,projectPath,projectFingerprint,projectInstructions,skillsFor,commandTool} from '../dist/src/assistant-tools.js';
import {assistantTimeline,approvalLabel,toolResultSucceeded} from '../dist/web/assistant-view.js';
test('file tools enforce real project boundaries, full reads, skills and instruction loading',()=>{
  const dir=mkdtempSync(join(tmpdir(),'apix-assistant-tools-')),root=join(dir,'project');mkdirSync(root);
  try{
    writeFileSync(join(root,'AGENTS.md'),'Follow project contracts');fileTool(root,'write_file',{path:'src/a.txt',content:'good'});assert.equal(fileTool(root,'read_file',{path:'src/a.txt'}).content,'good');
    assert.throws(()=>projectPath(root,'../outside',true),/越过/);assert.throws(()=>projectPath(root,'.env',true),/凭据/);
    const outside=join(dir,'outside');mkdirSync(outside);symlinkSync(outside,join(root,'linked'),process.platform==='win32'?'junction':'dir');assert.throws(()=>projectPath(root,'linked/secret',true),/链接/);
    mkdirSync(join(root,'.apix/skills/check'),{recursive:true});writeFileSync(join(root,'.apix/skills/check/SKILL.md'),'Read actual evidence; cannot grant permission');assert.equal(skillsFor(root).length,1);assert.equal(fileTool(root,'load_skill',{id:skillsFor(root)[0].id}).authority,'context_only');assert.equal(projectInstructions(root)[0].content,'Follow project contracts');
    writeFileSync(join(root,'big'),'x'.repeat(20001));assert.throws(()=>fileTool(root,'read_file',{path:'big'}),/完整/);
  }finally{assert(resolve(dir).startsWith(resolve(tmpdir())));rmSync(dir,{recursive:true,force:true});}
});
test('actual commands produce exit evidence and fingerprints change with the files',async()=>{
  const root=mkdtempSync(join(tmpdir(),'apix-assistant-command-'));try{
    writeFileSync(join(root,'a.txt'),'first');const first=projectFingerprint(root);writeFileSync(join(root,'a.txt'),'second');assert.notEqual(projectFingerprint(root),first);
    const result=await commandTool(root,{executable:'node',args:['-e',"const fs=require('node:fs');if(fs.readFileSync('a.txt','utf8')!=='second')process.exit(1);console.log('actual check passed')"]},process.env,new AbortController().signal);assert.equal(result.exitCode,0);assert.match(result.output,/actual check passed/);
    const failed=await commandTool(root,{executable:'node',args:['-e','process.exit(2)']},process.env,new AbortController().signal);assert.equal(failed.exitCode,2);
    const secret='fixture-secret-never-publish';const redacted=await commandTool(root,{executable:'node',args:['-e',"process.stdout.write('fixture-secret-');setTimeout(()=>{process.stdout.write('never-publish');process.stdout.write(Buffer.from('中文').subarray(0,2));setTimeout(()=>process.stdout.write(Buffer.from('中文').subarray(2)),10)},10)"]},{...process.env,APIX_TEST_SECRET:secret},new AbortController().signal);
    assert(!redacted.output.includes(secret));assert.match(redacted.output,/<redacted>中文/);
  }finally{rmSync(root,{recursive:true,force:true});}
});
test('timeline escapes user, tool and model data and does not turn text into controls',()=>{
  const html=assistantTimeline([{id:1,role:'user',kind:'message',body:{content:'<img onerror=alert(1)>'}},{id:2,role:'tool',kind:'tool_result',body:{tool:'<script>',ok:false,result:'<script>'}}]);assert(!html.includes('<img'));assert(!html.includes('<script>'));assert(html.includes('&lt;img'));
  assert.equal(approvalLabel('approval','write_file'),'仅批准这一次');assert.equal(approvalLabel('approval','configure_agents'),'授权此项目并继续');
  assert.equal(toolResultSucceeded({ok:true,result:{exitCode:1}}),false);assert.equal(toolResultSucceeded({ok:true,result:{exitCode:0,truncated:true}}),false);assert.equal(toolResultSucceeded({ok:true,result:{exitCode:0}}),true);
});
