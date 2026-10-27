import type {ToolDefinition} from './tool-registry.js';
import {estimateTokens} from './assistant-context.js';

const core=new Set(['search_tools','read_file','search_files','list_files','edit_file','get_diff','read_output','read_context','run_command','verify','run_check','diagnose_project','configure_verification']);
export function optimizedCatalog(tools:ToolDefinition[],saving:boolean,discovered:string[]){
  if(!saving)return {tools,deferred:[],estimatedReductionTokens:0};
  const selected=tools.filter(t=>core.has(t.name)||discovered.includes(t.name));
  const deferred=tools.filter(t=>!selected.includes(t)).map(t=>({name:t.name,description:t.description.slice(0,60)}));
  return {tools:selected,deferred,estimatedReductionTokens:Math.max(0,estimateTokens(tools)-estimateTokens(selected)-estimateTokens(deferred))};
}
