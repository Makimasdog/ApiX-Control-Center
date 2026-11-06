import {html} from './html.js';

export type RuntimeInteraction={
  id:string;runId:string;kind:'question'|'approval';permissionVersion:string;expiresAt:string;
  state:string;answerDelivery:string;employee?:string;
  request:{operation?:string;summary?:string;answerFormat?:'claude'|'codex';questions?:{
    id?:string;question:string;options?:{label:string;description?:string}[];
  }[]};
};
const operationLabels:Record<string,string>={
  'item/commandExecution/requestApproval':'运行命令','item/fileChange/requestApproval':'修改文件',
  Bash:'运行命令',Read:'读取文件',Glob:'查找文件',Grep:'搜索内容',Edit:'编辑文件',Write:'写入文件',
};

export function interactionForm(item:RuntimeInteraction,send:(path:string,body:unknown)=>Promise<{delivery:string}>,refresh:()=>void,report:(error:unknown)=>void){
  const form=document.createElement('form');
  form.dataset.interaction=item.id;
  const title=item.kind==='question'?'员工提问':'操作审批';
  const operation=item.request.operation??'';
  form.innerHTML=html`<h3>${item.employee?item.employee+' · ':''}${title}</h3><small>Run ${item.runId.slice(0,8)} · ${new Date(item.expiresAt).toLocaleString('zh-CN')} 前有效</small>`
    +(item.kind==='approval'
      ?html`<p>${operationLabels[operation]??operation} · ${item.request.summary}</p><button type="submit" class="outline-button" name="decision" value="approve">仅批准本次</button> <button type="submit" class="outline-button" name="decision" value="deny">拒绝</button>`
      :(item.request.questions??[]).map(q=>html`<label>${q.question}<small>${(q.options??[]).map(option=>option.label+(option.description?'：'+option.description:'')).join('；')}</small><textarea name="${q.id??q.question}" required maxlength="4000"></textarea></label>`).join('')
        +'<button type="submit" class="outline-button">提交回答</button>');
  let previousAnswer='',requestId='',sending=false;
  form.addEventListener('submit',async event=>{
    event.preventDefault();
    const submitter=event.submitter as HTMLButtonElement|null;
    if(sending||submitter?.disabled||item.kind==='approval'&&!submitter)return;
    const answer=item.kind==='approval'?{decision:submitter!.value}:{answers:Object.fromEntries(
      [...new FormData(form)].map(([key,value])=>[key,item.request.answerFormat==='claude'?String(value):{answers:[String(value)]}])
    )};
    const serialized=JSON.stringify(answer);
    if(previousAnswer!==serialized){previousAnswer=serialized;requestId=crypto.randomUUID();}
    const buttons=form.querySelectorAll('button');
    sending=true;
    for(const button of buttons)button.disabled=true;
    try{
      const result=await send(`/api/runs/${encodeURIComponent(item.runId)}/interactions/${encodeURIComponent(item.id)}/answer`,{requestId,answer,expectedPermissionVersion:item.permissionVersion});
      if(result.delivery!=='accepted')report(new Error('答案已保存，员工运行时接收情况需核对。'));
    }catch(error){
      report(error);
      sending=false;
      for(const button of buttons)button.disabled=false;
    }finally{refresh();}
  });
  return form;
}
