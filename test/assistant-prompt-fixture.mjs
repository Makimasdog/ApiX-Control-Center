/** 本地模拟模型读取两种宿主布局；生产代码不从模型正文解析诊断边界。 */
export function assistantPromptContext(prompt){
 if(!prompt.includes('APIX_PROMPT_LAYOUT stable-prefix-v1\n'))return JSON.parse(prompt.split('当前上下文：')[1].split('\n\n上次回复不是合法 JSON 动作：')[0]);
 const lines=prompt.split('\n'),read=kind=>JSON.parse(lines.find(l=>l.startsWith(kind+' ')).slice(kind.length+1));
 const events=lines.filter(l=>l.startsWith('EVENT ')).map(l=>JSON.parse(l.slice(6))),state=read('CURRENT_STATE'),checkpoint=read('CHECKPOINT'),rules=events.filter(e=>e.kind==='project_instructions').at(-1);
 return {...state,currentTask:{...checkpoint.currentTask,...state.currentTask},context:{...state.context,instructions:rules?.instructions??checkpoint.instructions},history:events.filter(e=>e.id),summary:checkpoint.summary,latestUserRequest:checkpoint.latestUserRequest,initialRequest:checkpoint.initialRequest};
}
