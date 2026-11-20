import {test} from 'node:test';
import assert from 'node:assert/strict';
import {memoryIndex} from '../dist/src/assistant/project-memory.js';
const note=(title,extra={})=>({title,content:'BODY_ONLY',source:'agent',version:1,kind:'project',status:'active',updated_at:'2026-01-01T00:00:00.000Z',...extra});
test('memory index respects the byte budget, pins user constraints first and reports truncation',()=>{
 const notes=[...Array.from({length:40},(_,i)=>note('普通记忆'+i+'长标题'.repeat(6),{updated_at:`2026-10-${String((i%28)+1).padStart(2,'0')}T00:00:00.000Z`})),note('用户约束',{source:'user',kind:'user'})];
 const index=memoryIndex(notes,400);
 assert(index.bytes<=400);assert(index.lines<200);assert.equal(index.truncated,true);
 assert.equal(index.content.split('\n')[2].startsWith('- 用户约束'),true);assert(!index.content.includes('BODY_ONLY'));
});
test('the default budget keeps the memory index within 5KB and drops the remainder',()=>{
 const index=memoryIndex(Array.from({length:300},(_,i)=>note('主题'+i+'中'.repeat(100))));
 assert(index.bytes<=5000);assert(index.lines<200);assert.equal(index.truncated,true);
});
