import {createServer} from 'node:http';
import {randomUUID} from 'node:crypto';

// One batch owns this gateway; worst-case reservations are retained even when usage is absent.
export async function startEvaluationGateway({baseUrl,apiKey,model,maxCny,maxRequests=24,requestTimeoutMs=90000}){
  if(!apiKey||!Number.isFinite(maxCny)||maxCny<=0||maxCny>50||!Number.isSafeInteger(maxRequests)||maxRequests<1||maxRequests>24)throw new Error('Invalid evaluation budget/configuration');
  const remote=new URL(baseUrl);if(remote.origin!=='https://dashscope.aliyuncs.com'||remote.pathname.replace(/\/$/,'')!=='/compatible-mode/v1'||model!=='deepseek-v4.1-flash-1017')throw new Error('This budget profile only supports the configured DashScope DeepSeek snapshot');
  const route='/'+randomUUID()+'/v1',ledger=[],controllers=new Set();let reservedCny=0;
  const server=createServer(async(req,res)=>{
    if(req.url!==route+'/chat/completions'||req.method!=='POST'){res.writeHead(404);res.end('{}');return;}
    let entry;
    try{
      let raw='';for await(const part of req){raw+=part;if(Buffer.byteLength(raw)>120000)throw new Error('input_budget_exceeded');}
      const input=JSON.parse(raw);
      if(input.model!==model||!Array.isArray(input.messages))throw new Error('model_or_messages_invalid');
      const maxTokens=Math.min(4096,input.max_completion_tokens??input.max_tokens??4096);
      if(!Number.isSafeInteger(maxTokens)||maxTokens<1)throw new Error('output_budget_invalid');
      const inputUpper=Buffer.byteLength(raw)+8192;
      // Conservative double peak rates: 4/16 CNY per million; actual price estimate uses 2/8.
      const reservation=(inputUpper*4+maxTokens*16)/1000000;
      if(ledger.length>=maxRequests||reservedCny+reservation>maxCny)throw new Error('batch_budget_exceeded');
      reservedCny+=reservation;entry={request:ledger.length+1,inputByteUpperBound:inputUpper,maxOutputTokens:maxTokens,reservationCny:reservation,status:'dispatched',usage:null,estimatedCny:null,structuredOutput:input.response_format?.type??null};ledger.push(entry);
      const messages=[...input.messages];
      if(input.response_format?.type==='json_schema')messages.unshift({role:'system',content:'Return only a JSON object conforming to this schema: '+JSON.stringify(input.response_format.json_schema.schema)});
      const controller=new AbortController();controllers.add(controller);const timer=setTimeout(()=>controller.abort(),requestTimeoutMs);
      const disconnect=()=>{if(!res.writableEnded)controller.abort();};res.on('close',disconnect);
      let response,data;
      try{
        response=await fetch(new URL(remote.pathname.replace(/\/$/,'')+'/chat/completions',remote),{method:'POST',redirect:'error',headers:{Authorization:'Bearer '+apiKey,'Content-Type':'application/json'},body:JSON.stringify({model,messages,stream:false,max_tokens:maxTokens,temperature:0,enable_thinking:false,...(input.response_format?{response_format:input.response_format.type==='json_schema'?{type:'json_object'}:input.response_format}:{})}),signal:controller.signal});
        data=await response.json();
      }finally{clearTimeout(timer);controllers.delete(controller);res.removeListener('close',disconnect);}
      entry.httpStatus=response.status;
      if(!response.ok){entry.status='provider_error';entry.errorCode=data.error?.code??null;res.writeHead(response.status);res.end(JSON.stringify({error:{message:'Evaluation provider rejected request',code:entry.errorCode}}));return;}
      entry.status='completed';
      if(Number.isSafeInteger(data.usage?.prompt_tokens)&&Number.isSafeInteger(data.usage?.completion_tokens)){
        entry.usage={inputTokens:data.usage.prompt_tokens,outputTokens:data.usage.completion_tokens};entry.estimatedCny=(entry.usage.inputTokens*2+entry.usage.outputTokens*8)/1000000;
      }
      if(input.stream){
        res.writeHead(200,{'Content-Type':'text/event-stream'});
        res.end('data: '+JSON.stringify({choices:[{index:0,delta:{content:data.choices?.[0]?.message?.content??''},finish_reason:null}]})+'\n\ndata: '+JSON.stringify({choices:[{index:0,delta:{},finish_reason:data.choices?.[0]?.finish_reason??'stop'}],usage:data.usage})+'\n\ndata: [DONE]\n\n');
      }else res.end(JSON.stringify(data));
    }catch(error){if(entry){entry.status='transport_error';entry.errorName=error.name;}if(!res.headersSent)res.writeHead(400);res.end(JSON.stringify({error:{message:entry?'Evaluation transport failed':error.message}}));}
  });
  await new Promise(r=>server.listen(0,'127.0.0.1',r));
  return {baseUrl:'http://127.0.0.1:'+server.address().port+route,model,summary:()=>({currency:'CNY',maxCny,maxRequests,reservedCny,requests:ledger.length,ledger,actualBilledCny:null,priceSource:'https://help.aliyun.com/zh/model-studio/model-pricing',pricingCheckedAt:'2026-11-02',estimateRatesPerMillion:{input:2,output:8},reservationRatesPerMillion:{input:4,output:16}}),async close(){for(const c of controllers)c.abort();server.closeAllConnections();await new Promise(r=>server.close(r));}};
}
