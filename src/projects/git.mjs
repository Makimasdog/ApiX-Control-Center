import {execFile} from 'node:child_process';

let active=0;const queue=[];
function drain(){
  while(active<4&&queue.length){
    const job=queue.shift();clearTimeout(job.timer);const timeout=job.deadline-performance.now();
    if(timeout<=0){job.reject(Object.assign(new Error('Git 排队超时，请重新检查'),{code:'ETIMEDOUT'}));continue;}
    active++;
    try{
      const child=execFile('git',job.args,{cwd:job.cwd,encoding:'utf8',maxBuffer:10000000,windowsHide:true,...job.options,timeout:Math.ceil(timeout)},(error,stdout,stderr)=>{
        active--;if(error){error.stderr=stderr;job.reject(error);}else job.resolve(stdout);drain();
      });
      if(child.stdin){child.stdin.on('error',()=>{});child.stdin.end(job.input);}
    }catch(error){active--;job.reject(error);}
  }
}
export function git(cwd,args,{input,...options}={}){
  return new Promise((resolve,reject)=>{
    if(queue.length>=64){reject(Object.assign(new Error('Git 操作繁忙，请稍后重试'),{code:'GIT_BUSY'}));return;}
    const budget=options.timeout??20000,job={cwd,args,input,options,resolve,reject,deadline:performance.now()+budget,timer:null};
    job.timer=setTimeout(()=>{const index=queue.indexOf(job);if(index!==-1){queue.splice(index,1);reject(Object.assign(new Error('Git 排队超时，请重新检查'),{code:'ETIMEDOUT'}));}},budget);
    queue.push(job);drain();
  });
}
