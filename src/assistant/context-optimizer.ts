import type {ToolDefinition} from './tool-registry.js';
import {estimateTokens} from './assistant-context.js';

// 常用编码与验收工具常驻完整参数，避免正常工作流为发现基础工具额外调用模型。
const core=new Set(['search_tools','read_file','search_files','list_files','edit_file','get_diff','read_output','read_context','run_command','verify','run_check','diagnose_project','configure_verification']);
/** 仅精简发给模型的目录；工具注册、参数校验、授权与审批继续由宿主负责。 */
export function optimizedCatalog(tools:ToolDefinition[],saving:boolean,discovered:string[]){
  if(!saving)return {tools,deferred:[],estimatedReductionTokens:0};
  const selected=tools.filter(t=>core.has(t.name)||discovered.includes(t.name));
  // 延迟工具仍保留名称和用途供检索，发现后恢复完整参数，避免模型猜测工具接口。
  const deferred=tools.filter(t=>!selected.includes(t)).map(t=>({name:t.name,description:t.description.slice(0,60)}));
  // 必须扣除发现索引本身的占用；此处只是字节估算差值，不是实际费用或任务总节省。
  return {tools:selected,deferred,estimatedReductionTokens:Math.max(0,estimateTokens(tools)-estimateTokens(selected)-estimateTokens(deferred))};
}
