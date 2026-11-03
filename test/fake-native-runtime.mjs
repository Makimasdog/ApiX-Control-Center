import {createInterface} from 'node:readline';
if(process.argv.includes('exec')){let prompt='';for await(const chunk of process.stdin)prompt+=chunk;process.stdout.write(JSON.stringify({type:'item.completed',item:{type:'agent_message',text:'CLI 回退完成，保留中文历史'}})+'\n'+JSON.stringify({type:'turn.completed',usage:{input_tokens:5,output_tokens:2}})+'\n');process.exit(0);}
const codex=process.argv.includes('app-server');let turn=0,held=false,resumed=false;
const send=value=>process.stdout.write(JSON.stringify(value)+'\n');
function codexTurn(id,prompt){
  turn++;held=prompt.includes('hold');send({id,result:{turn:{id:'t'+turn}}});send({method:'turn/started',params:{threadId:'session-fixture',turn:{id:'t'+turn}}});
  const finish=()=>{send({method:'item/agentMessage/delta',params:{threadId:'session-fixture',itemId:'output'+turn,delta:'中文公开输出 <script>test</script>'+(resumed?' · 原生延续':'')}});send({method:'thread/tokenUsage/updated',params:{threadId:'session-fixture',tokenUsage:{last:{inputTokens:10,outputTokens:3,cachedInputTokens:2}}}});send({method:'turn/completed',params:{threadId:'session-fixture',turn:{id:'t'+turn,status:'completed'}}});if(prompt.includes('duplicate'))send({method:'turn/completed',params:{threadId:'session-fixture',turn:{id:'t'+turn,status:'completed'}}});};
  if(prompt.includes('disconnect')){process.exit(1);return;}
  if(prompt.includes('ask'))send({id:'question-'+turn,method:'item/tool/requestUserInput',params:{threadId:'session-fixture',turnId:'t'+turn,questions:[{id:'choice',header:'选择',question:'请选择范围',options:[{label:'只读',description:'保持只读'}]}]}});
  else if(prompt.includes('approval'))send({id:'approval-'+turn,method:'item/commandExecution/requestApproval',params:{threadId:'session-fixture',turnId:'t'+turn,command:'node check.mjs'}});
  else if(!held)setTimeout(finish,60);
  globalThis.finish=finish;
}
for await(const line of createInterface({input:process.stdin})){
  const m=JSON.parse(line);
  if(codex){
    if(m.method==='initialize')send({id:m.id,result:{userAgent:'fixture-codex/0.145.0'}});
    else if(m.method==='thread/start'||m.method==='thread/resume'){resumed=m.method==='thread/resume';if(resumed&&process.env.APIX_FAKE_RESUME_DELAY_MS)await new Promise(r=>setTimeout(r,Number(process.env.APIX_FAKE_RESUME_DELAY_MS)));send({id:m.id,result:{thread:{id:'session-fixture'}}});}
    else if(m.method==='turn/start')codexTurn(m.id,m.params.input[0].text);
    else if(m.method==='turn/steer'){if(m.params.input[0].text.includes('unknown-steer'))process.exit(1);send({id:m.id,result:{turnId:'t'+turn}});if(m.params.input[0].text.includes('finish'))setTimeout(()=>globalThis.finish(),20);}
    else if(m.method==='turn/interrupt'){send({id:m.id,result:{}});}
    else if(!m.method&&String(m.id).startsWith('question-')||!m.method&&String(m.id).startsWith('approval-'))setTimeout(()=>globalThis.finish(),20);
  }else{
    if(m.type==='control_request')send({type:'control_response',response:{subtype:'success',request_id:m.request_id,response:m.request.subtype==='initialize'?{commands:[],models:[],account:{}}:{}}});
    if(m.type==='control_response')globalThis.sdkFinish?.();
    if(m.type==='user'){
      const content=typeof m.message.content==='string'?m.message.content:JSON.stringify(m.message.content);if(content.includes('hold'))continue;
      const finish=()=>{
      send({type:'system',subtype:'init',session_id:'sdk-fixture',tools:[],mcp_servers:[],model:'fixture',permissionMode:'default',apiKeySource:'none',uuid:crypto.randomUUID()});
      send({type:'assistant',session_id:'sdk-fixture',parent_tool_use_id:null,uuid:crypto.randomUUID(),message:{id:'msg'+ ++turn,type:'message',role:'assistant',model:'fixture',content:[{type:'text',text:'SDK 中文输出'}],stop_reason:'end_turn',usage:{input_tokens:10,output_tokens:3}}});
      send({type:'result',subtype:'success',is_error:false,result:'SDK 中文输出'+(process.env.APIX_FAKE_TAG??''),session_id:'sdk-fixture',uuid:crypto.randomUUID(),duration_ms:1,duration_api_ms:1,num_turns:1,total_cost_usd:0,usage:{input_tokens:10,output_tokens:3,cache_read_input_tokens:2,cache_creation_input_tokens:0},modelUsage:{},permission_denials:[]});
      };globalThis.sdkFinish=finish;
      if(content.includes('SDK_ASK'))send({type:'control_request',request_id:'sdk-question',request:{subtype:'can_use_tool',tool_name:'AskUserQuestion',tool_use_id:'question-tool',input:{questions:[{question:'请选择范围',header:'范围',options:[{label:'只读',description:'保持只读'}]}]}}});else if(content.includes('SDK_APPROVAL'))send({type:'control_request',request_id:'sdk-approval',request:{subtype:'can_use_tool',tool_name:'Bash',tool_use_id:'command-tool',input:{command:'node check.mjs'}}});else finish();
    }
  }
}
