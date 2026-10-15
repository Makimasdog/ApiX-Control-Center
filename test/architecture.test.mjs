import {test} from 'node:test';
import assert from 'node:assert/strict';
import {parseArchitecture,bindArchitecture,parseAutonomyPolicy,autonomyDefaults} from '../dist/src/architecture.js';
import {autonomySummary} from '../dist/web/autonomy-view.js';
const checks=[{id:'tests',args:['verify.mjs'],timeoutMs:1000}];
const module=(id='core',paths=['src/core'])=>({id,name:id,paths,dependsOn:[],risk:'high',difficulty:3,workload:{inputTokens:2000,outputTokens:1000,calls:2},interfaces:[{name:'read',consumer:'external',protocol:'HTTP',request:{type:'object'},response:{type:'string'}}],dataStructures:[{name:'value',schema:{type:'string'}}],acceptance:['返回字符串并覆盖错误路径'],checkIds:['tests']});
test('architecture rejects cyclic, missing, overlapping and unauthorized contracts before implementation',()=>{
  const architecture=parseArchitecture({summary:'contract',modules:[module()]},checks);
  assert.match(architecture.digest,/^[a-f0-9]{64}$/);
  assert.throws(()=>parseArchitecture({summary:'contract',modules:[module(),module('other',['src/core/sub'])]},checks),/重叠/);
  assert.throws(()=>parseArchitecture({summary:'contract',modules:[{...module(),dependsOn:['other']},{...module('other',['src/other']),dependsOn:['core']}]},checks),/循环/);
  assert.throws(()=>parseArchitecture({summary:'contract',modules:[{...module(),interfaces:[{name:'bad',consumer:'missing',protocol:'HTTP',request:{type:'object'},response:{type:'string'}}]}]},checks),/消费者/);
  assert.throws(()=>parseArchitecture({summary:'contract',modules:[{...module(),checkIds:['not-approved']}]},checks),/授权/);
  assert.throws(()=>parseArchitecture({summary:'contract',modules:[{...module(),paths:['../escape']}]},checks),/相对路径/);
  assert.throws(()=>parseArchitecture({summary:'contract',modules:[module(),{...module('other',['src/other']),dataStructures:[{name:'value',schema:{type:'number'}}]}]},checks),/模块间不一致/);
});
test('implementation binds all modules and appends a final integration over frozen inputs',()=>{
  const architecture=parseArchitecture({summary:'contract',modules:[module(),{...module('api',['src/api']),dependsOn:['core']}]},checks);
  const steps=[{moduleId:'core',prompt:'core',employeeId:'a',dependsOn:[]},{moduleId:'api',prompt:'api',employeeId:'b',dependsOn:[0]}];
  const bound=bindArchitecture(architecture,steps,12);assert.equal(bound.length,3);assert.equal(bound[2].moduleId,'integration');assert.deepEqual(bound[2].dependsOn,[0,1]);assert.equal(bound[0].scheduling.estimateMinor,12);assert.equal(bound[0].scheduling.difficulty,3);
  assert.throws(()=>bindArchitecture(architecture,steps.slice(0,1),null),/覆盖/);
  assert.throws(()=>bindArchitecture(architecture,[steps[0],{...steps[1],dependsOn:[]}],null),/依赖/);
  assert.throws(()=>bindArchitecture(architecture,[{...steps[0],scheduling:{writePaths:['src/other']}},steps[1]],null),/超出/);
});
test('autonomy policy accepts only explicitly configured relative Node scripts and finite loop bounds',()=>{
  const input={...autonomyDefaults,enabled:true,checks};assert.equal(parseAutonomyPolicy(input,1).version,1);
  for(const args of [['-e','process.exit(0)'],['../outside.js'],['C:/outside.js'],['/outside.js'],['verify.cmd']])assert.throws(()=>parseAutonomyPolicy({...input,checks:[{...checks[0],args}]},1),/入口/);
  assert.throws(()=>parseAutonomyPolicy({...input,maxRepairs:11},1),/修复/);assert.throws(()=>parseAutonomyPolicy({...input,checks:[]},1),/至少/);
});
test('autonomy UI escapes model contracts, findings and repair instructions',()=>{
  const architecture=parseArchitecture({summary:'<img src=x onerror=alert(1)>',modules:[module()]},checks);
  const html=autonomySummary({state:'attention',reason:'<script>bad</script>',architecture,tasks:[],checks:[{id:'c',task_id:'t',status:'failed',fingerprint:'f',body:{output:'<script>x</script>'}}],repairs:[{id:'r',task_id:'t',attempt:1,employee_id:'a',instruction:'<svg onload=x>',status:'prepared'}]});
  assert(!html.includes('<script>'));assert(!html.includes('<img'));assert(!html.includes('<svg'));assert(html.includes('&lt;img'));assert(html.includes('实际验收证据'));
});

test('schemas reject malformed keywords, unresolved references and unknown dialects before freezing',()=>{
  for(const invalid of [{type:'wrong'},{type:'object',required:'x'},{type:'object',properties:{x:{type:123}}},{type:'object',requred:['x']},{$ref:'#/$defs/Missing'},{type:'string',format:'unknown-format'},{$schema:'__proto__',type:'string'},{$schema:'https://example.invalid/schema',type:'string'}]){
    assert.throws(()=>parseArchitecture({summary:'contract',modules:[{...module(),dataStructures:[{name:'bad',schema:invalid}]}]},checks),/schema/);
  }
});
test('schemas accept nested contracts and local references without leaking identifiers across contracts',()=>{
  const valid={$id:'https://example.invalid/reused',type:'object',properties:{email:{type:'string',format:'email'},item:{$ref:'#/$defs/Item'}},required:['item'],$defs:{Item:{type:'object',properties:{id:{type:'integer'}},required:['id'],additionalProperties:false}}};
  for(const schema of [valid,valid,{$schema:'http://json-schema.org/draft-07/schema#',type:'array',items:[{type:'string'}]}])assert(parseArchitecture({summary:'contract',modules:[{...module(),dataStructures:[{name:'value',schema}]}]},checks).digest);
  assert.throws(()=>parseArchitecture({summary:'contract',modules:[{...module(),dataStructures:[{name:'bad',schema:{$ref:'https://example.invalid/reused'}}]}]},checks),/schema/);
});
