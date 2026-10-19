import {startDeliveryFixture} from './delivery-fixture.mjs';
import {npmProjectFiles} from './npm-project-fixture.mjs';
// Fixed local protocol decisions exercise the production service, not autonomous model ability.
export function startNpmFixture(){return startDeliveryFixture({name:'Node npm 真实依赖验收演示',idleMs:90000,startupMs:30000,setup:root=>npmProjectFiles(root,{longLog:true}),decide:(ctx,state)=>{
 const action=(tool,args={})=>({action:'tool',tool,args,message:'本地工程协议夹具：'+tool}),finish={action:'finish',outcome:'completed',message:'真实 npm 副本检查已完成，请审阅任务净差异；这是固定响应工程演示。'},result=t=>ctx.history.filter(e=>e.kind==='tool_result'&&e.body.tool===t).at(-1)?.body.result;
 let steps;
 if(ctx.taskFeedback?.length)steps=[()=>action('read_file',{path:'src/add.cjs'}),()=>action('edit_file',{path:'src/add.cjs',expectedSha256:result('read_file').sha256,edits:[{oldText:'// BUG',newText:'// addition fixed; reviewed documentation'}]}),()=>action('run_check',{checkId:'npm-project'}),()=>finish];
 else steps=[()=>action('run_check',{checkId:'npm-project'}),()=>action('read_output',{operationId:result('run_check').npmValidation.commands.at(-1).operationId,channel:'stderr',mode:'tail'}),()=>action('read_file',{path:'src/add.cjs'}),()=>action('edit_file',{path:'src/add.cjs',expectedSha256:result('read_file').sha256,edits:[{oldText:'number(a)-number(b)',newText:'number(a)+number(b)'}]}),()=>action('run_check',{checkId:'npm-project'}),()=>finish];
 const key=ctx.taskFeedback?.length?'revisionStep':'step',i=state[key]??0;state[key]=i+1;return steps[i]?.()??{action:'finish',outcome:'blocked',message:'工程夹具决策耗尽，请检查证据'};
 }});}
