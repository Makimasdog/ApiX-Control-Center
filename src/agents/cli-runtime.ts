import {spawn} from 'node:child_process';
import {randomUUID} from 'node:crypto';
import type {RunHandle,RuntimeInput,RuntimeTransportEvent} from './runtime-contract.js';

/** 保持旧 CLI 的参数、UTF-8 解码、末行解析及 Pi abort 行为；只迁出通信与进程操作。 */
export function openCliRuntime(input:RuntimeInput):RunHandle {
  const child=spawn(input.command.executable,[...input.command.prefix,...input.args],{cwd:input.cwd,env:input.env,windowsHide:true,stdio:['pipe','pipe','pipe']});
  const queue:RuntimeTransportEvent[]=[];let wake:(()=>void)|undefined,ended=false,buffer='',closing:Promise<{evidence:'root_exited'|'unknown'}>|undefined;
  const emit=(event:RuntimeTransportEvent)=>{queue.push(event);wake?.();wake=undefined;};
  const isActive=()=>!ended;
  const closeInput=()=>{if(child.stdin.writable)child.stdin.end();};
  const kill=()=>{if(isActive())child.kill();};
  const interrupt=()=>{
    if(!isActive())return;
    if(input.runtime==='pi'&&child.stdin.writable)child.stdin.write(JSON.stringify({id:randomUUID(),type:'abort'})+'\n');else kill();
    setTimeout(kill,3000).unref();
  };
  child.stdout.setEncoding('utf8');child.stderr.setEncoding('utf8');
  child.stdout.on('data',(chunk:string)=>{
    if(input.format==='plain'){emit({kind:'output',text:chunk});return;}
    buffer+=chunk;let index:number;const items:RuntimeTransportEvent[]=[];
    while((index=buffer.indexOf('\n'))!==-1){const line=buffer.slice(0,index).replace(/\r$/,'');buffer=buffer.slice(index+1);if(!line.trim())continue;
      try{items.push({kind:'native',item:JSON.parse(line)});}catch{items.push({kind:'unparsed',text:line.slice(0,3000)});}
    }
    if(items.length)emit({kind:'batch',items});
  });
  child.stderr.on('data',(text:string)=>emit({kind:'stderr',text}));
  child.stdin.on('error',error=>emit({kind:'stdin_error',message:error.message}));
  child.on('error',error=>emit({kind:'error',message:error.message}));
  child.on('close',(code,signal)=>{
    if(ended)return;
    if(buffer.trim()){try{emit({kind:'native',item:JSON.parse(buffer)});}catch{emit({kind:'trailing',text:buffer.slice(0,3000)});}}
    ended=true;emit({kind:'closed',code,signal});
  });
  async function* events(){for(;;){while(queue.length)yield queue.shift()!;if(ended)return;await new Promise<void>(resolve=>wake=resolve);}}
  function close(){return closing??=new Promise(resolve=>{
    if(ended){resolve({evidence:'root_exited'});return;}
    const timer=setTimeout(()=>resolve({evidence:'unknown'}),5000);timer.unref();
    child.once('close',()=>{clearTimeout(timer);resolve({evidence:'root_exited'});});interrupt();
  });}
  // 先装好所有监听；异步 spawn 错误仍由同一个事件流收尾。
  if(input.runtime==='pi')child.stdin.write(JSON.stringify({id:input.runId,type:'prompt',message:input.prompt})+'\n');else child.stdin.end(input.prompt);
  return {events:events(),pid:child.pid??null,isActive,closeInput,interrupt,close};
}
