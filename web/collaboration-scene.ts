import {html} from './html.js';

type ActivityKind='dispatch'|'message'|'delivery'|'review';
export type CollaborationActivity={
  planId:string|null;
  events:{id:string;from:string;to:string;kind:ActivityKind;status:string;time:string;preview:string}[];
};
type Activity=CollaborationActivity['events'][number];
type Agent={id:string;name:string};
export type CollaborationSpeech={time:string;markup:string};
const director:Agent={id:'apix-director',name:'ApiX'};
const kinds={dispatch:'任务分配',message:'对话',delivery:'成果交付',review:'验收通过'};
const unavailable=['rejected','failed','expired'];

export function mountCollaborationScene(host:HTMLElement){
  host.innerHTML='<div class="collaboration-status"><strong>协作动态</strong><span></span></div><div class="collaboration-rail"><div class="collaboration-map"><div class="collaboration-avatars"></div><div class="collaboration-wire" hidden aria-hidden="true"><i></i></div></div></div><div class="collaboration-bubble chat-row" role="status" hidden></div><details class="collaboration-recent" hidden><summary>最近往来</summary><ol></ol></details>';
  const avatars=host.querySelector<HTMLElement>('.collaboration-avatars')!;
  const map=host.querySelector<HTMLElement>('.collaboration-map')!;
  const rail=map.parentElement!;
  const wire=host.querySelector<HTMLElement>('.collaboration-wire')!;
  const dot=wire.querySelector<HTMLElement>('i')!;
  const bubble=host.querySelector<HTMLElement>('.collaboration-bubble')!;
  const recent=host.querySelector<HTMLDetailsElement>('.collaboration-recent')!;
  const status=host.querySelector<HTMLElement>('.collaboration-status span')!;
  const dots=new Map<string,HTMLElement>();
  let planId:string|null=null, roster='', history='', shown:Activity|undefined;
  let seen=new Map<string,ActivityKind>(), timer:number|undefined, queue:Activity[]=[];
  let animation:Animation|undefined;
  const canonical=(id:string)=>id==='director'?director.id:id;
  function speech(event:Activity){
    const from=dots.get(canonical(event.from));
    const sender=from?.nextElementSibling?.textContent??event.from;
    const recipient=dots.get(canonical(event.to))?.nextElementSibling?.textContent??event.to;
    const hue=from?.parentElement?.style.getPropertyValue('--avatar-hue')??'225';
    return html`<span class="collaboration-avatar chat-avatar" style="--avatar-hue:${hue}" aria-hidden="true">${from?.textContent}</span><div class="chat-bubble"><small>${sender} → ${recipient} · ${kinds[event.kind]}</small><p class="collaboration-preview">${event.preview}</p></div>`;
  }

  function drawWire(){
    const from=shown&&dots.get(canonical(shown.from)),to=shown&&dots.get(canonical(shown.to));
    wire.hidden=!from||!to||from===to||!shown||unavailable.includes(shown.status);
    if(wire.hidden||!from||!to)return;
    const base=map.getBoundingClientRect(),start=from.getBoundingClientRect(),end=to.getBoundingClientRect();
    const dx=end.left+end.width/2-start.left-start.width/2,dy=end.top+end.height/2-start.top-start.height/2;
    wire.style.left=(start.left-base.left+start.width/2)+'px';
    wire.style.top=(start.top-base.top+start.height/2)+'px';
    wire.style.width=Math.hypot(dx,dy)+'px';
    wire.style.transform='rotate('+Math.atan2(dy,dx)+'rad)';
  }
  new ResizeObserver(drawWire).observe(map);

  function show(event:Activity|undefined,animate=false){
    animation?.cancel();
    shown=event;
    bubble.hidden=!event;
    for(const [id,node] of dots){
      node.parentElement!.classList.toggle('is-sender',!!event&&id===canonical(event.from));
      node.parentElement!.classList.toggle('is-recipient',!!event&&id===canonical(event.to));
    }
    if(event){
      bubble.dataset.kind=event.kind;
      wire.dataset.kind=event.kind;
      bubble.innerHTML=speech(event);
    }else bubble.replaceChildren();
    drawWire();
    if(event&&animate&&!wire.hidden&&!matchMedia('(prefers-reduced-motion: reduce)').matches){
      const sender=dots.get(canonical(event.from))!;
      const left=sender.getBoundingClientRect().left-rail.getBoundingClientRect().left;
      if(left<0||left+sender.offsetWidth>rail.clientWidth)rail.scrollLeft+=left-rail.clientWidth/2;
      animation=dot.animate([{left:'0%',opacity:0},{left:'8%',opacity:1},{left:'100%',opacity:1}],
        {duration:850,easing:'ease-out'});
    }
  }

  function play(){
    const event=queue.shift();
    if(!event){timer=undefined;return;}
    show(event,true);
    timer=window.setTimeout(play,1100);
  }

  return (activity:CollaborationActivity|null,workers:Agent[]=[],summary=''):CollaborationSpeech[]=>{
    host.hidden=!activity?.planId;
    if(!activity?.planId){
      planId=null;seen.clear();queue=[];window.clearTimeout(timer);timer=undefined;show(undefined);
      recent.open=false;
      return [];
    }
    const agents=[director,...new Map(workers.map(agent=>[agent.id,agent])).values()];
    const names=new Map(agents.map(agent=>[agent.id,agent.name]));
    const nextRoster=JSON.stringify(agents);
    const rosterChanged=nextRoster!==roster;
    if(rosterChanged){
      roster=nextRoster;
      avatars.innerHTML=agents.map((agent,index)=>html`<div class="collaboration-agent" data-agent="${agent.id}" title="${agent.name}">
        <span class="collaboration-avatar" aria-hidden="true">${index===0?'✦':Array.from(agent.name)[0]}</span>
        <span class="collaboration-name">${agent.name}</span>
      </div>`).join('');
      dots.clear();
      [...avatars.children].forEach((node,index)=>{
        (node as HTMLElement).style.setProperty('--avatar-hue',String((225+index*137.508)%360));
        dots.set(agents[index]!.id,node.querySelector<HTMLElement>('.collaboration-avatar')!);
      });
    }
    status.textContent=summary;
    const events=activity.events.filter(event=>names.has(canonical(event.from))&&names.has(canonical(event.to)));
    const nextHistory=JSON.stringify(events);
    if(nextHistory!==history||rosterChanged){
      history=nextHistory;
      recent.hidden=!events.length;
      recent.querySelector('ol')!.innerHTML=events.slice(0,8).reverse().map(event=>
        `<li class="chat-row">${speech(event)}</li>`).join('');
    }
    if(planId!==activity.planId){
      planId=activity.planId;seen=new Map(events.map(event=>[event.id,event.kind]));
      queue=[];window.clearTimeout(timer);timer=undefined;recent.open=false;
      show(events[0],!!events[0]&&Date.now()-Date.parse(events[0].time)<2500);
      return transcript();
    }
    const fresh=events.filter(event=>seen.get(event.id)!==event.kind);
    for(const event of fresh)seen.set(event.id,event.kind);
    if(fresh.length)queue=[...queue,...fresh.reverse()].slice(-6);
    if(queue.length&&timer===undefined)play();
    else if(timer===undefined&&(rosterChanged||JSON.stringify(shown)!==JSON.stringify(events[0])))show(events[0]);
    else drawWire();
    return transcript();
    function transcript(){return events.filter(event=>event.kind==='message').slice().reverse().map(event=>({
      time:event.time,markup:'<article class="assistant-message chat-row">'+speech(event)+'</article>',
    }));}
  };
}
