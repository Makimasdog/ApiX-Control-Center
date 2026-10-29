// No inference: report only whether the scoped fixture credential reached this worker.
import {readFileSync} from 'node:fs';
for await(const chunk of process.stdin){}
const args=process.argv.slice(2),claude=args.includes('--settings');
const settings=claude?JSON.parse(readFileSync(args[args.indexOf('--settings')+1],'utf8')):null;
const text=JSON.stringify({scopedKey:(claude?process.env.ANTHROPIC_API_KEY:process.env.APIX_PROVIDER_KEY)==='fixture-provider-worker-key',settingsKey:settings?.env?.ANTHROPIC_API_KEY==='fixture-provider-worker-key',ambientKeyPresent:!!process.env.OPENAI_API_KEY,otherAgentKeyPresent:!!process.env.ANTHROPIC_AUTH_TOKEN,args});
if(claude)process.stdout.write(JSON.stringify({type:'result',result:text,is_error:false,usage:{input_tokens:1,output_tokens:1}})+'\n');
else{process.stdout.write(JSON.stringify({type:'item.completed',item:{type:'agent_message',text}})+'\n');process.stdout.write(JSON.stringify({type:'turn.completed',usage:{input_tokens:1,output_tokens:1}})+'\n');}
