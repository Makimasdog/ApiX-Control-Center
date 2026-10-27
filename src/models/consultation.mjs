/**
 * 协商协议 - 多 Agent 协商选择模型的协议实现，通过子进程调用 Claude CLI 获取无工具规划提案
 *
 * 所属层级：模型层（src/models/）
 * 核心功能：
 *   1. consultClaude() 启动 Claude CLI 子进程，以 bare/restricted 模式运行
 *   2. 禁用所有工具和 MCP 服务器，确保只返回纯文本规划提案
 *   3. 解析流式 JSON 输出，提取 result 类型的最终答复
 *   4. 安全保护：超时控制（90 秒）、输出大小限制、禁止工具调用
 * 依赖关系：
 *   - 依赖 infrastructure/environment.mjs 构建子进程环境
 *   - 被 src/coordination/ 层调用以执行多 Agent 规划协商
 */
import {spawn} from 'node:child_process';
import {workerEnvironment} from '../infrastructure/environment.mjs';

/**
 * consultClaude - 通过 Claude CLI 子进程执行无工具规划协商
 * 使用 --bare --restricted 模式，禁用所有工具和钩子，只返回纯文本提案
 * @param command - CLI 命令配置（executable 和 prefix）
 * @param prompt - 发送给 Claude 的提示词
 * @param cwd - 子进程工作目录
 * @param model - 模型 ID（可选）
 * @param managerKey - 应用级密钥
 * @param prepared - 预准备的环境和配置（可选）
 * @returns Claude 返回的纯文本提案
 */
// No execution sandbox claim: this adapter removes CLI tools, hooks and project discovery.
export function consultClaude(command,prompt,cwd,model='',managerKey='',prepared=null) {
  // 构建 CLI 参数：禁用工具、禁用 MCP、禁用钩子、流式 JSON 输出
  const args=['--bare','--restricted','-p','--tools','','--disallowedTools','*','--strict-mcp-config','--mcp-config','{"mcpServers":{}}','--settings',prepared?.consultSettings??'{"disableAllHooks":true}','--setting-sources','','--no-session-persistence','--output-format','stream-json','--verbose',...(model?['--model',model]:[])];
  const env=prepared?.env??workerEnvironment(process.env,'claude',managerKey);
  return new Promise((resolve,reject)=>{
    const child=spawn(command.executable,[...command.prefix,...args],{cwd,env,stdio:['pipe','pipe','pipe'],windowsHide:true});
    let buffer='';let answer='';let failed=false;let stderr='';let finished=false;let size=0;
    // 90 秒超时保护
    const timer=setTimeout(()=>{failed=true;stderr='规划参与者超时';child.kill();},90000);
    child.stdout.on('data',chunk=>{
      buffer+=chunk.toString('utf8');size+=chunk.length;if(size>100000){failed=true;stderr='规划输出过大';child.kill();return;}
      let index;while((index=buffer.indexOf('\n'))!==-1){const line=buffer.slice(0,index);buffer=buffer.slice(index+1);
        try{const item=JSON.parse(line);if(item.type==='result'){failed ||= item.is_error===true;answer=typeof item.result==='string'?item.result:'';}
          // 安全保护：如果模型试图调用工具，立即终止
          if(item.type==='assistant' && item.message?.content?.some(c=>c.type==='tool_use')){failed=true;stderr='规划适配器报告工具调用，已停止';child.kill();}
        }catch{ /* Non-protocol diagnostics are not treated as proposals. */ }
      }
    });
    child.stderr.on('data',c=>stderr=(stderr+c.toString('utf8')).slice(-1000));
    function finish(error){if(finished)return;finished=true;clearTimeout(timer);if(error)reject(error);else resolve(answer);}
    child.on('error',finish);child.stdin.on('error',error=>{failed=true;stderr=error.message;});
    child.on('close',code=>finish(code===0 && !failed && answer.trim()?null:new Error(stderr || 'Claude 未返回可用的无工具规划提案；需支持 bare/restricted 模式的 CLI')));
    // 将提示词通过 stdin 发送给子进程
    child.stdin.end(prompt);
  });
}
