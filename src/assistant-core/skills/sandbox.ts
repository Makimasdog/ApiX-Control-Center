import {getQuickJS} from 'quickjs-emscripten';
import {invalid} from './manifest.js';

export async function sandboxJavaScript(code:string,input:unknown,signal:AbortSignal){
  const serialized=JSON.stringify(input??null);
  if(serialized.length>12000)throw invalid('沙箱输入过大');
  const engine=await getQuickJS();
  signal.throwIfAborted();
  const vm=engine.newContext();
  try{
    vm.runtime.setMemoryLimit(8*1024*1024);
    vm.runtime.setMaxStackSize(256*1024);
    const deadline=performance.now()+150;
    vm.runtime.setInterruptHandler(()=>signal.aborted||performance.now()>=deadline);
    const result=vm.evalCode('(()=>{const stringify=JSON.stringify;const GuestPromise=Promise;const input=JSON.parse('+JSON.stringify(serialized)+');'+
      'const value=(function(input){"use strict";\n'+code+'\n})(input);if(value instanceof GuestPromise)throw new Error("Expected synchronous result");return stringify(value??null);})()','agent-skill.js',{type:'global'});
    if(result.error){result.error.dispose();throw invalid('沙箱代码失败，或超过运行资源上限');}
    try{
      const output=vm.getString(result.value);
      if(!output||output.length>16000)throw invalid('沙箱结果必须为有界 JSON');
      return {value:JSON.parse(output)};
    }finally{result.value.dispose();}
  }finally{vm.dispose();}
}
