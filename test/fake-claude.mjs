let input = '';
process.stdin.on('data', chunk => input += chunk);
process.stdin.on('end', () => {
  process.stdout.write(JSON.stringify({type:'assistant',message:{content:[{type:'text',text:`Claude result: ${input}`}]}})+'\n');
  process.stdout.write(JSON.stringify({type:'result',is_error:false,result:`Claude result: ${input}`})+'\n');
});
