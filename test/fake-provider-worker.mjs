// No inference: report only whether the scoped fixture credential reached this worker.
for await(const chunk of process.stdin){}
const text=JSON.stringify({scopedKey:process.env.APIX_PROVIDER_KEY==='fixture-provider-worker-key',ambientKeyPresent:!!process.env.OPENAI_API_KEY,otherAgentKeyPresent:!!process.env.ANTHROPIC_AUTH_TOKEN,args:process.argv.slice(2)});
process.stdout.write(JSON.stringify({type:'item.completed',item:{type:'agent_message',text}})+'\n');
process.stdout.write(JSON.stringify({type:'turn.completed',usage:{input_tokens:1,output_tokens:1}})+'\n');
