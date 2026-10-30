export interface RunEvent {id:number;runId:string;kind:string;occurredAt:string;payload:Record<string,any>}
export interface RunNode {id:string;kind:string;text:string;status?:string}
export function foldAgentRun(runId:string,events:RunEvent[]):RunNode[]{
  const unique=new Map(events.filter(e=>e.runId===runId).map(e=>[e.id,e])),nodes=new Map<string,RunNode>();
  for(const e of [...unique.values()].sort((a,b)=>a.id-b.id)){
    const p=e.payload;
    if(e.kind==='output.delta'){const id='output:'+p.turnId+':'+p.nodeId,node=nodes.get(id)??{id,kind:'output',text:''};node.text+=p.text??'';nodes.set(id,node);}
    else if(e.kind==='tool.started'||e.kind==='tool.finished'){const id='tool:'+p.turnId+':'+p.toolCallId;nodes.set(id,{id,kind:'tool',text:p.name+' · '+(p.summary??''),status:e.kind==='tool.started'?'执行中':p.status??'未知'});}
    else if(e.kind==='turn.started'||e.kind==='turn.finished'){const id='turn:'+p.turnId;nodes.set(id,{id,kind:'turn',text:'处理回合',status:e.kind==='turn.started'?'运行中':p.status??'未知'});}
    else if(e.kind==='runtime.error')nodes.set('error:'+e.id,{id:'error:'+e.id,kind:'error',text:p.message??'运行失败'});
  }
  return [...nodes.values()];
}
