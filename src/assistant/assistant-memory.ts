/**
 * 会话记忆持久化 (Session Memory) — 跨轮次记忆管理，支持关键词召回
 *
 * 所属层级：助手层 - 记忆管理
 * 核心功能：
 *   1. RecallNote 接口 — 定义记忆笔记的数据结构
 *   2. terms — 分词函数，支持英文单词和中文双字（bigram）提取
 *   3. recallNotes — 基于关键词匹配的笔记召回，按相关度评分排序
 * 依赖关系：
 *   - 被 [→ 见 src/assistant/project-memory.ts] 调用
 *   - 被 [→ 见 src/assistant/assistant-loop.ts] 的 assemble 调用
 */
/** RecallNote — 记忆笔记接口，对应 assistant_notes 表的一行 */
export interface RecallNote {title:string;content:string;source:string;version:number;kind:string;status:string;updated_at:string}
/**
 * terms - 分词函数，提取文本中的关键词
 * @param value - 待分词的文本
 * @returns 关键词集合（英文单词 + 中文双字 bigram）
 * 设计意图：中文用 bigram 而非分词器，英文用完整单词，简单且足够用于相关度匹配
 */
function terms(value:string){return new Set((value.toLowerCase().match(/[a-z0-9_]{2,}|[\u3400-\u9fff]{2,}/g)??[]).flatMap(word=>/[\u3400-\u9fff]/.test(word)?Array.from({length:Math.max(0,word.length-1)},(_,i)=>word.slice(i,i+2)):[word]));}
/**
 * recallNotes - 基于关键词匹配的笔记召回
 * @param query - 查询文本（通常是用户的最新消息）
 * @param notes - 所有可用的笔记列表
 * @param budget - 召回内容的字符预算（默认 6000）
 * @returns 按相关度排序的笔记列表，最多 5 条，总字符数不超过预算
 * 设计意图：标题匹配权重 4 分，正文匹配 1 分，用户/反馈类型额外加 1 分；
 * 超过 24 小时未更新的笔记标记为 stale。
 */
export function recallNotes(query:string,notes:RecallNote[],budget=6000){
  const input=terms(query);let remaining=budget;
  return notes.filter(n=>n.status==='active').map(n=>{const title=terms(n.title),body=terms(n.content);let score=0;for(const term of input)score+=(title.has(term)?4:0)+(body.has(term)?1:0);if(['user','feedback'].includes(n.kind))score+=1;return {note:n,score};}).filter(n=>n.score>0).sort((a,b)=>b.score-a.score||b.note.updated_at.localeCompare(a.note.updated_at)||a.note.title.localeCompare(b.note.title)).slice(0,5).flatMap(({note:n,score})=>{if(n.content.length>remaining)return [];remaining-=n.content.length;return [{...n,score,stale:Date.now()-Date.parse(n.updated_at)>86400000,authority:'reference_only'}];});
}
