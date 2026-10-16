let input = '';
process.stdin.on('data', chunk => input += chunk);
process.stdin.on('end', () => {
  if(input.startsWith('APIX_PLANNING_CLAIM_JSON\n')){
    const args=process.argv;
    for(const flag of ['--bare','--restricted','--tools','--disallowedTools','--strict-mcp-config','--settings','--no-session-persistence'])if(!args.includes(flag))throw new Error('Missing consultation restrictions');
    if(args[args.indexOf('--tools')+1]!=='' || process.env.APIX_AGENT_TOKEN || process.env.APIX_DATA_DIR || process.env.APIX_ALI_API_KEY || process.env.ali_api_key || !/consultations/.test(process.cwd()))throw new Error('Consultation identity or manager environment is not isolated');
    const steps=JSON.parse(input.split('\n任务：')[1].split('\n需要澄清')[0]);
    process.stdout.write(JSON.stringify({type:'result',is_error:false,result:JSON.stringify({claims:steps.map((_,step)=>({step,reason:'fixture: Claude isolated identity and tools disabled',risk:'unverified declaration',minutes:4})),decline:''})})+'\n');return;
  }
  process.stdout.write(JSON.stringify({type:'assistant',message:{content:[{type:'text',text:`Claude result: ${input}`}]}})+'\n');
  process.stdout.write(JSON.stringify({type:'result',is_error:false,result:`Claude result: ${input}`})+'\n');
});
