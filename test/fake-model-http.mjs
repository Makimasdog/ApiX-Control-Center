import {createServer} from 'node:http';import {spawn} from 'node:child_process';import {fileURLToPath} from 'node:url';
// Reuse deterministic fixture decisions behind HTTP; this helper is never imported by ApiX.
export async function startModelFixture(env={}){
  const calls=[],children=new Set();const server=createServer(async(req,res)=>{
    let raw='';for await(const chunk of req)raw+=chunk;const body=JSON.parse(raw);calls.push({url:req.url,body,headers:req.headers});
    const prompt=body.input??body.messages?.at(-1)?.content??'';
    if(prompt.includes('fixture-http-hold')){const call=calls.at(-1);res.writeHead(200,{'Content-Type':'text/event-stream'});res.flushHeaders();res.on('close',()=>{call.aborted=true;});return;}
    if(body.model==='fixture-manager-quota'){res.writeHead(429);res.end('{}');return;}
    const api=req.url.endsWith('/responses')?'responses':req.url.endsWith('/messages')?'anthropic':'chat';
    const stream=body.stream===true;let answer='',buffer='',failed=false,ended=false,streamed=false;
    if(stream)res.setHeader('Content-Type','text/event-stream');
    const frame=value=>res.write('data: '+(typeof value==='string'?value:JSON.stringify(value))+'\n\n');
    const delta=text=>{if(stream){streamed=true;frame(api==='chat'?{choices:[{index:0,delta:{content:text}}]}:api==='responses'?{type:'response.output_text.delta',delta:text}:{type:'content_block_delta',delta:{type:'text_delta',text}});}};
    const childEnv={...process.env,...env};delete childEnv.APIX_AGENT_TOKEN;
    const child=spawn(process.execPath,[fileURLToPath(new URL('./fake-pi.mjs',import.meta.url)),'--no-tools','--no-context-files','--no-extensions','--no-skills','--append-system-prompt','fixture host protocol'],{env:childEnv,windowsHide:true,stdio:['pipe','pipe','pipe']});children.add(child);
    child.stderr.on('data',chunk=>{if(String(chunk).includes('insufficient_quota'))failed='quota';else failed=true;});
    child.stdout.on('data',chunk=>{buffer+=chunk;let i;while((i=buffer.indexOf('\n'))>=0){const line=buffer.slice(0,i);buffer=buffer.slice(i+1);let item;try{item=JSON.parse(line);}catch{continue;}
      if(item.type==='message_update')delta(item.assistantMessageEvent?.delta??'');
      if(item.type==='message_end'){answer=(item.message?.content??[]).filter(c=>c.type==='text').map(c=>c.text).join('');failed||=['error','aborted'].includes(item.message?.stopReason);}
      if(['agent_settled','agent_end'].includes(item.type))child.stdin.end();
    }});
    const finish=()=>{children.delete(child);if(ended)return;ended=true;
      if(failed||!answer){if(stream){frame({type:'error',error:{...(failed==='quota'?{code:'insufficient_quota'}:{}),message:'fixture model failure'}});res.end();}else{res.writeHead(failed==='quota'?429:500);res.end('{}');}return;}
      const result=api==='chat'?{choices:[{finish_reason:'stop',message:{content:answer}}]}:api==='responses'?{status:'completed',output:[{type:'message',role:'assistant',content:[{type:'output_text',text:answer}]}]}:{stop_reason:'end_turn',content:[{type:'text',text:answer}]};
      if(stream){if(!streamed)delta(answer);if(api==='chat'){frame({choices:[{index:0,delta:{},finish_reason:'stop'}]});frame('[DONE]');}else if(api==='responses')frame({type:'response.completed',response:result});else{frame({type:'message_delta',delta:{stop_reason:'end_turn'}});frame({type:'message_stop'});}res.end();}else res.end(JSON.stringify(result));
    };
    child.on('error',()=>{failed=true;finish();});child.on('close',finish);res.on('close',()=>{if(!ended){ended=true;child.kill();}});
    child.stdin.on('error',()=>{});child.stdin.write(JSON.stringify({type:'prompt',message:prompt})+'\n');
  });
  await new Promise(r=>server.listen(0,'127.0.0.1',r));return {calls,baseUrl:`http://127.0.0.1:${server.address().port}/v1`,async close(){for(const child of children)child.kill();server.closeAllConnections();await new Promise(r=>server.close(r));}};
}
