export interface RecallNote {title:string;content:string;source:string;version:number;kind:string;status:string;updated_at:string}
function terms(value:string){return new Set((value.toLowerCase().match(/[a-z0-9_]{2,}|[\u3400-\u9fff]{2,}/g)??[]).flatMap(word=>/[\u3400-\u9fff]/.test(word)?Array.from({length:Math.max(0,word.length-1)},(_,i)=>word.slice(i,i+2)):[word]));}
export function recallNotes(query:string,notes:RecallNote[],budget=6000){
  const input=terms(query);let remaining=budget;
  return notes.filter(n=>n.status==='active').map(n=>{const title=terms(n.title),body=terms(n.content);let score=0;for(const term of input)score+=(title.has(term)?4:0)+(body.has(term)?1:0);if(['user','feedback'].includes(n.kind))score+=1;return {note:n,score};}).filter(n=>n.score>0).sort((a,b)=>b.score-a.score||b.note.updated_at.localeCompare(a.note.updated_at)||a.note.title.localeCompare(b.note.title)).slice(0,5).flatMap(({note:n,score})=>{if(n.content.length>remaining)return [];remaining-=n.content.length;return [{...n,score,stale:Date.now()-Date.parse(n.updated_at)>86400000,authority:'reference_only'}];});
}
