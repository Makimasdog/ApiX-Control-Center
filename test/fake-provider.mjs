let prompt = '';
process.stdin.on('data', chunk => { prompt += chunk.toString(); });
process.stdin.on('end', () => {
  const runtime = process.argv.includes('run') ? 'opencode' : process.argv.includes('--print') ? 'kimi' : 'gemini';
  if (!prompt.includes('ApiX')) { process.stderr.write('Missing ApiX dispatch context'); process.exitCode = 1; return; }
  if (process.env.APIX_FIXTURE_FAIL_RUNTIME === runtime) {
    process.stdout.write(JSON.stringify({type:'error',error:{message:`${runtime} fixture error`}})+'\n');
    return;
  }
  if (runtime === 'gemini') {
    process.stdout.write(JSON.stringify({type:'message',role:'assistant',content:'Gemini result',delta:false})+'\n');
    process.stdout.write(JSON.stringify({type:'result',status:'success',stats:{input_tokens:41,output_tokens:12,cached_tokens:3}})+'\n');
  } else if (runtime === 'opencode') {
    process.stdout.write(JSON.stringify({type:'text',part:{type:'text',text:'Open'}})+'\n');
    process.stdout.write(JSON.stringify({type:'text',part:{type:'text',text:'Code result'}})+'\n');
    process.stdout.write(JSON.stringify({type:'step_finish',part:{tokens:{input:51,output:15,cache:{read:4}}}})+'\n');
  } else {
    process.stdout.write(JSON.stringify({type:'message',role:'assistant',content:[{type:'text',text:'Kimi result'}]})+'\n');
    process.stdout.write(JSON.stringify({type:'result',usage:{input_tokens:61,output_tokens:19,cached_input_tokens:5}})+'\n');
  }
});
