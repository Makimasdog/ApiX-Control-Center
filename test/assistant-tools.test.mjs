import {test} from 'node:test';import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,rmSync,symlinkSync} from 'node:fs';import {join,resolve} from 'node:path';import {tmpdir} from 'node:os';
import {fileTool,projectPath,projectFingerprint,projectInstructions,skillsFor,commandTool} from '../dist/src/assistant/assistant-tools.js';
import {assistantTimeline,approvalLabel,toolResultSucceeded} from '../dist/web/assistant-view.js';
test('file tools enforce real project boundaries, full reads, skills and instruction loading',()=>{
  const dir=mkdtempSync(join(tmpdir(),'apix-assistant-tools-')),root=join(dir,'project');mkdirSync(root);
  try{
    writeFileSync(join(root,'AGENTS.md'),'Follow project contracts');fileTool(root,'write_file',{path:'src/a.txt',content:'good'});assert.equal(fileTool(root,'read_file',{path:'src/a.txt'}).content,'good');
    assert.throws(()=>projectPath(root,'../outside',true),/越过/);assert.throws(()=>projectPath(root,'.env',true),/凭据/);
    const outside=join(dir,'outside');mkdirSync(outside);symlinkSync(outside,join(root,'linked'),process.platform==='win32'?'junction':'dir');assert.throws(()=>projectPath(root,'linked/secret',true),/链接/);
    mkdirSync(join(root,'.apix/skills/check'),{recursive:true});writeFileSync(join(root,'.apix/skills/check/SKILL.md'),'---\nname: 检查技能\ndescription: 使用实际证据\nwhen_to_use: 需要验证时\n---\nRead actual evidence; cannot grant permission');
    mkdirSync(join(root,'.apix/skills/plain'),{recursive:true});writeFileSync(join(root,'.apix/skills/plain/SKILL.md'),'# 标题\n第一条实际说明\n第二条');
    const skills=skillsFor(root);assert.equal(skills.length,2);const check=skills.find(s=>s.id==='check');assert.equal(check.name,'检查技能');assert.equal(check.description,'使用实际证据');assert.equal(check.when,'需要验证时');assert.equal(skills.find(s=>s.id==='plain').description,'第一条实际说明');
    assert.equal(fileTool(root,'load_skill',{id:'check'}).authority,'context_only');assert.equal(fileTool(root,'load_skill',{id:'检查技能'}).authority,'context_only');assert.equal(projectInstructions(root)[0].content,'Follow project contracts');
    writeFileSync(join(root,'big'),'x'.repeat(20001));assert.throws(()=>fileTool(root,'read_file',{path:'big'}),/完整/);
  }finally{assert(resolve(dir).startsWith(resolve(tmpdir())));rmSync(dir,{recursive:true,force:true,maxRetries:10,retryDelay:100});}
});
test('actual commands produce exit evidence and fingerprints change with the files',async()=>{
  const root=mkdtempSync(join(tmpdir(),'apix-assistant-command-'));try{
    writeFileSync(join(root,'a.txt'),'first');const first=projectFingerprint(root);writeFileSync(join(root,'a.txt'),'second');assert.notEqual(projectFingerprint(root),first);
    const result=await commandTool(root,{executable:'node',args:['-e',"const fs=require('node:fs');if(fs.readFileSync('a.txt','utf8')!=='second')process.exit(1);console.log('actual check passed')"]},process.env,new AbortController().signal);assert.equal(result.exitCode,0);assert.match(result.output,/actual check passed/);
    const failed=await commandTool(root,{executable:'node',args:['-e','process.exit(2)']},process.env,new AbortController().signal);assert.equal(failed.exitCode,2);
    const secret='fixture-secret-never-publish';const redacted=await commandTool(root,{executable:'node',args:['-e',"process.stdout.write('fixture-secret-');setTimeout(()=>{process.stdout.write('never-publish');process.stdout.write(Buffer.from('中文').subarray(0,2));setTimeout(()=>process.stdout.write(Buffer.from('中文').subarray(2)),10)},10)"]},{...process.env,APIX_TEST_SECRET:secret},new AbortController().signal);
    assert(!redacted.output.includes(secret));assert.match(redacted.output,/<redacted>中文/);
  }finally{rmSync(root,{recursive:true,force:true,maxRetries:10,retryDelay:100});}
});
test('timeline escapes user, tool and model data and does not turn text into controls',()=>{
  const html=assistantTimeline([{id:1,role:'user',kind:'message',body:{content:'<img onerror=alert(1)>'}},{id:2,role:'tool',kind:'tool_result',body:{tool:'<script>',ok:false,result:'<script>'}}]);assert(!html.includes('<img'));assert(!html.includes('<script>'));assert(html.includes('&lt;img'));
  assert.equal(approvalLabel('approval','write_file'),'仅批准这一次');assert.equal(approvalLabel('approval','configure_agents'),'授权此项目并继续');
  assert.equal(toolResultSucceeded({ok:true,result:{exitCode:1}}),false);assert.equal(toolResultSucceeded({ok:true,result:{exitCode:0,truncated:true}}),false);assert.equal(toolResultSucceeded({ok:true,result:{exitCode:0}}),true);
  assert.equal(toolResultSucceeded({ok:true,result:{exitCode:0,passed:false}}),false);for(const facts of [{executionComplete:false},{sideEffectsNeedReview:true},{evidencePersisted:false}])assert.equal(toolResultSucceeded({ok:true,result:{exitCode:0,...facts}}),false);assert.equal(approvalLabel('approval','configure_verification'),'批准此验收契约');
  const evidence=assistantTimeline([{id:3,role:'system',kind:'verification_evidence',body:{checkId:'<script>',verificationStatus:'failed',passed:false,outputRef:'evidence'}}]);assert(evidence.includes('! 可信检查'));assert(!evidence.includes('<script>'));assert(evidence.includes('data-output-reference="evidence"'));
});

test('timeline folds routine progress and protocol repair while keeping failures, user prompts and answers visible',()=>{
  let id=0;
  const event=(kind,role,body,created_at)=>({id:++id,kind,role,body,created_at});
  const markup=assistantTimeline([
    event('message','user',{content:'查找入口'}),
    event('activity','assistant',{content:'检查根目录'}),
    event('tool_started','assistant',{tool:'list_files',args:{}},'2026-11-20T08:00:00.000Z'),
    event('tool_result','tool',{tool:'list_files',ok:true,result:{files:['app.py']}}),
    event('protocol_repair','system',{content:'正在纠正格式'}),
    event('activity','assistant',{content:'定位入口'}),
    event('tool_started','assistant',{tool:'read_file',args:{path:'app.py'}}),
    event('tool_result','tool',{tool:'read_file',ok:true,result:{path:'app.py',outputRef:'source'}},'2026-11-20T08:00:02.100Z'),
    event('tool_result','tool',{tool:'read_file',ok:false,error:'文件不存在'}),
    event('request','assistant',{question:'是否继续'}),
    event('answer','assistant',{content:'完成检查'})
  ]);
  assert.equal((markup.match(/data-execution-record=/g)??[]).length,1);
  assert.equal((markup.match(/class="assistant-message/g)??[]).length,4);
  assert.equal((markup.match(/class="assistant-turn-head/g)??[]).length,1);
  assert(markup.indexOf('class="assistant-turn"')<markup.indexOf('data-execution-record='));
  for(const text of ['2 次工具调用','read_file(app.py)','用时 2.1 秒','1 次格式纠正','定位入口','正在纠正格式','data-output-reference="source"','文件不存在','是否继续','完成检查'])assert(markup.includes(text),text);
  assert(markup.indexOf('文件不存在')>markup.indexOf('data-output-reference="source"'));
});
