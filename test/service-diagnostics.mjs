import {fetch} from './local-fetch.mjs';
import {setTimeout as delay} from 'node:timers/promises';

export function serviceDiagnostics(child,env=process.env){
 const secrets=Object.entries(env).filter(([k,v])=>/KEY|TOKEN|SECRET|PASSWORD/i.test(k)&&v&&v.length>=6).map(([,v])=>v);
 const safe=text=>{for(const secret of secrets)text=text.split(secret).join('<redacted>');return text.slice(-4000);};
 const tails={stdout:'',stderr:''},started=performance.now(),retain=4000+Math.max(0,...secrets.map(s=>s.length));
 for(const channel of ['stdout','stderr'])child[channel]?.on('data',data=>tails[channel]=(tails[channel]+data.toString('utf8')).slice(-retain));
 let spawnError;child.on('error',e=>spawnError=e.message);
 return {child,report:(phase,last)=>JSON.stringify({phase,elapsedMs:Math.round(performance.now()-started),pid:child.pid,exitCode:child.exitCode,signal:child.signalCode,spawnError:safe(spawnError??''),last,stdout:safe(tails.stdout),stderr:safe(tails.stderr)})};
}
export async function waitServiceReady(diagnostic,url,{timeoutMs=9000,requestMs=1000}={}){
 const {child}=diagnostic,deadline=performance.now()+timeoutMs;let last={state:'not_requested'};
 while(performance.now()<deadline){
  if(child.exitCode!==null||child.signalCode!==null)throw new Error(diagnostic.report('startup_exited',last));
  const controller=new AbortController(),remaining=deadline-performance.now();
  const timer=setTimeout(()=>controller.abort(),Math.min(requestMs,remaining));const exited=()=>controller.abort();child.once('exit',exited);
  try{const response=await fetch(url,{signal:controller.signal});last={state:'http',status:response.status};if(response.ok)return;}
  catch(e){last={state:'connection_error',name:e.name,code:e.cause?.code??null};}
  finally{controller.abort();clearTimeout(timer);child.removeListener('exit',exited);}
  await delay(Math.min(60,Math.max(0,deadline-performance.now())));
 }
 throw new Error(diagnostic.report('startup_deadline',last));
}
export async function stopService(child){
 if(!child||child.exitCode!==null||child.signalCode!==null)return;
 await new Promise((resolve,reject)=>{const timer=setTimeout(()=>{child.removeListener('close',closed);reject(new Error('fixture cleanup deadline: owned server termination unconfirmed'));},5000);const closed=()=>{clearTimeout(timer);resolve();};child.once('close',closed);try{child.kill();}catch(e){clearTimeout(timer);child.removeListener('close',closed);reject(e);}});
}
