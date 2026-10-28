import {requestHash,diagnosticHostFields,type PromptDescriptor} from '../models/prompt-diagnostics.js';

/** 使用同一组序列化片段构造旧请求与旁路描述；不解析正文里的“history”等字样。 */
export function legacyAssistantPrompt(instruction:string,tools:unknown,value:Record<string,any>){
  const head='APIX_AGENT_LOOP_JSON\n'+instruction,toolText='\n工具目录：'+JSON.stringify(tools),contextText='\n当前上下文：'+JSON.stringify(value);
  const prompt=head+toolText+contextText,a=Buffer.byteLength(head),b=a+Buffer.byteLength(toolText);
  const fieldOrder=[...Object.keys(value).filter(name=>diagnosticHostFields.includes(name)),...diagnosticHostFields.filter(name=>!Object.hasOwn(value,name))];
  const descriptor:PromptDescriptor={schema:1,layout:'legacy-v1',generation:null,promptSha256:requestHash(prompt),regions:[{name:'instruction',start:0,end:a},{name:'tool_catalog',start:a,end:b},{name:'context',start:b,end:Buffer.byteLength(prompt)}],fields:fieldOrder.map(name=>({name,hash:requestHash(JSON.stringify(Object.hasOwn(value,name)?{present:true,value:value[name]}:{present:false}))})),frames:(value.history??[]).map((e:{id:number})=>({eventId:e.id,hash:requestHash(JSON.stringify(e))}))};
  return {prompt,descriptor};
}
