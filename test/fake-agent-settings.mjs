import {setTimeout as delay} from 'node:timers/promises';
import {createInterface} from 'node:readline';
if(process.argv.includes('app-server')){
  for await(const line of createInterface({input:process.stdin})){
    const message=JSON.parse(line);if(message.method==='initialized')continue;
    let result={};
    if(message.method==='account/rateLimits/read')result={rateLimitsByLimitId:{codex:{primary:{usedPercent:23,windowDurationMins:300,resetsAt:1900000000},secondary:{usedPercent:45,windowDurationMins:10080,resetsAt:1900500000}}}};
    else if(message.method==='model/list')result={data:[{model:'fixture-model',displayName:'测试模型',supportedReasoningEfforts:[{reasoningEffort:'low'},{reasoningEffort:'high'}]}]};
    else if(message.method!=='initialize')throw new Error('Unexpected mutable/inference request');
    process.stdout.write(JSON.stringify({id:message.id,result})+'\n');
  }
}else{
  let prompt='';for await(const chunk of process.stdin)prompt+=chunk;
  const report=`员工报告：中文完整，已完成 R1-R3；检查 fit 边界。${JSON.stringify({argv:process.argv.slice(2),pythonUTF8:process.env.PYTHONUTF8,pythonIO:process.env.PYTHONIOENCODING})}`;
  const text=JSON.stringify({type:'item.completed',item:{type:'agent_message',text:report}})+'\n';
  for(const byte of Buffer.from(text)){process.stdout.write(Buffer.from([byte]));await delay(1);}
  for(const byte of Buffer.from('中文标准错误完整')){process.stderr.write(Buffer.from([byte]));await delay(1);}
  process.stdout.write(JSON.stringify({type:'turn.completed',usage:{input_tokens:10,output_tokens:20}}));
}
