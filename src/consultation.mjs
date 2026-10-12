import {spawn} from 'node:child_process';

// No execution sandbox claim: this adapter removes CLI tools, hooks and project discovery.
export function consultClaude(command,prompt,cwd,model='') {
  const args=['--bare','--restricted','-p','--tools','','--disallowedTools','*','--strict-mcp-config','--mcp-config','{"mcpServers":{}}','--settings','{"disableAllHooks":true}','--setting-sources','','--no-session-persistence','--output-format','stream-json','--verbose',...(model?['--model',model]:[])];
  const env={...process.env};for(const key of ['APIX_AGENT_TOKEN','APIX_PROJECT_ID','APIX_AGENT_ID','APIX_TASK_ID','APIX_RUN_ID','APIX_MAILBOX_URL'])delete env[key];
  return new Promise((resolve,reject)=>{
    const child=spawn(command.executable,[...command.prefix,...args],{cwd,env,stdio:['pipe','pipe','pipe'],windowsHide:true});
    let buffer='';let answer='';let failed=false;let stderr='';let finished=false;let size=0;
    const timer=setTimeout(()=>{failed=true;stderr='规划参与者超时';child.kill();},90000);
    child.stdout.on('data',chunk=>{
      buffer+=chunk.toString('utf8');size+=chunk.length;if(size>100000){failed=true;stderr='规划输出过大';child.kill();return;}
      let index;while((index=buffer.indexOf('\n'))!==-1){const line=buffer.slice(0,index);buffer=buffer.slice(index+1);
        try{const item=JSON.parse(line);if(item.type==='result'){failed ||= item.is_error===true;answer=typeof item.result==='string'?item.result:'';}
          if(item.type==='assistant' && item.message?.content?.some(c=>c.type==='tool_use')){failed=true;stderr='规划适配器报告工具调用，已停止';child.kill();}
        }catch{ /* Non-protocol diagnostics are not treated as proposals. */ }
      }
    });
    child.stderr.on('data',c=>stderr=(stderr+c.toString('utf8')).slice(-1000));
    function finish(error){if(finished)return;finished=true;clearTimeout(timer);if(error)reject(error);else resolve(answer);}
    child.on('error',finish);child.stdin.on('error',error=>{failed=true;stderr=error.message;});
    child.on('close',code=>finish(code===0 && !failed && answer.trim()?null:new Error(stderr || 'Claude 未返回可用的无工具规划提案；需支持 bare/restricted 模式的 CLI')));
    child.stdin.end(prompt);
  });
}
