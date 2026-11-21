import {writeFileSync,readFileSync,existsSync} from 'node:fs';
import {execFileSync} from 'node:child_process';
import {setTimeout as delay} from 'node:timers/promises';
import {generateFiles} from './evaluation-model.mjs';

// Deterministic employee decisions; all IO goes through the real worker process/workspace/mailbox.
let prompt='';
for await(const chunk of process.stdin)prompt+=chunk;
const mode=process.argv[2];
const realModel=process.argv[3]?{baseUrl:process.argv[3],model:process.argv[4]}:null;
if(mode==='fail'){
  writeFileSync('partial.txt','preserve recovery evidence\n');
  process.stderr.write('AssertionError: expected working addition, observed subtraction\n');
  process.exitCode=1;
}else if(mode==='hold'){
  writeFileSync('started.txt','owned worker started');
  await new Promise(()=>setInterval(()=>{},1000));
}else if(prompt.startsWith('APIX_EVAL_IMPLEMENT')){
  if(realModel)await generateFiles('implement',realModel.baseUrl,realModel.model);
  else writeFileSync('sum.mjs','export const sum=(a,b)=>a+b;\n');
  console.log('implemented sum.mjs');
}else if(prompt.startsWith('APIX_EVAL_TEST')||prompt.startsWith('APIX_EVAL_DOC')){
  const headers={Authorization:'Bearer '+process.env.APIX_AGENT_TOKEN,'Content-Type':'application/json'};
  const deadline=Date.now()+60000;let guidance;
  while(Date.now()<deadline&&!guidance){
    const response=await fetch(process.env.APIX_MAILBOX_URL+'/messages',{headers});
    if(!response.ok)throw new Error('mailbox read failed: '+response.status);
    for(const message of await response.json()){
      for(const action of ['ack','complete']){
        const reply=await fetch(process.env.APIX_MAILBOX_URL+'/messages/'+message.id+'/'+action,{method:'POST',headers,body:'{}'});
        if(!reply.ok)throw new Error('mailbox '+action+' failed: '+reply.status);
      }
      if(message.payload?.content?.includes('APIX_EVAL_GUIDANCE')||JSON.stringify(message.payload).includes('APIX_EVAL_GUIDANCE'))guidance=message.id;
    }
    if(!guidance)await delay(60);
  }
  if(!guidance)throw new Error('guidance deadline');
  if(!existsSync('sum.mjs'))throw new Error('frozen dependency absent');
  if(prompt.startsWith('APIX_EVAL_TEST')){
    if(realModel)await generateFiles('test',realModel.baseUrl,realModel.model);
    else writeFileSync('verify.mjs',"import assert from 'node:assert/strict';import {sum} from './sum.mjs';for(const [a,b] of [[2,3],[-3,7],[0,0],[.5,1.25]])assert.equal(sum(a,b),a+b);console.log('APIX_EVAL_VERIFIED');\n");
    execFileSync(process.execPath,['verify.mjs'],{stdio:'inherit',windowsHide:true,timeout:5000});
  }else if(realModel)await generateFiles('docs',realModel.baseUrl,realModel.model);
  else writeFileSync('review.md','APIX_EVAL_GUIDANCE_OK\n'+readFileSync('sum.mjs','utf8'));
  console.log('guidance completed '+guidance);
}else if(prompt.startsWith('APIX_EVAL_INTEGRATE')){
  execFileSync(process.execPath,['verify.mjs'],{stdio:'inherit',windowsHide:true,timeout:5000});
  if(!readFileSync('review.md','utf8').includes('APIX_EVAL_GUIDANCE_OK'))throw new Error('documentation handoff absent');
  if(realModel)await generateFiles('integrate',realModel.baseUrl,realModel.model);
  else writeFileSync('integration.md','verified both frozen branches\n');
  console.log('integration completed');
}else{
  if(!existsSync('partial.txt'))throw new Error('partial recovery evidence missing');
  console.log('recovered '+readFileSync('partial.txt','utf8'));
}
