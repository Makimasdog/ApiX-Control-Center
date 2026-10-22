import {test} from 'node:test';
import assert from 'node:assert/strict';
import {layoutWorkflow,taskTone} from '../dist/web/workflow-graph.js';
const tasks=ids=>ids.map(id=>({id,prompt:id,employee_id:'employee',status:'queued'}));
const edge=(from,to)=>({depends_on_id:from,task_id:to});
test('diamond dependencies preserve edges, layers and parallel branches without node overlaps',()=>{
 const input=tasks(['a','b','c','d']),graph=layoutWorkflow(input,[edge('a','b'),edge('a','c'),edge('b','d'),edge('c','d'),edge('a','b')]);
 assert.equal(graph.edges.length,5);assert.equal(graph.missing,0);assert.equal(graph.unresolved,0);
 const find=id=>graph.nodes.find(n=>n.id===id);
 assert(find('a').x<find('b').x);assert.equal(find('b').x,find('c').x);assert(find('c').x<find('d').x);
 for(const a of graph.nodes)for(const b of graph.nodes)if(a.id!==b.id)assert(a.x+a.width<=b.x||b.x+b.width<=a.x||a.y+a.height<=b.y||b.y+b.height<=a.y);
 assert.deepEqual(layoutWorkflow(input,[edge('a','b'),edge('a','c'),edge('b','d'),edge('c','d'),edge('a','b')]),graph);
 assert(graph.edges.every(e=>!e.path.includes('NaN')));
});
test('empty, independent and long workflows remain finite and retain every task',()=>{
 for(const ids of [[],['a'],Array.from({length:80},(_,i)=>String(i))]){
  const input=tasks(ids),dependencies=ids.slice(1).map((id,i)=>edge(ids[i],id)),g=layoutWorkflow(input,dependencies);
  assert.equal(g.nodes.length,ids.length);assert(g.width>0&&g.height>0);assert.equal(g.unresolved,0);assert.equal(g.edges.length,ids.length);
 }
 const graph=layoutWorkflow(tasks(['a','b','c']),[]);assert(graph.nodes.every(n=>n.x===graph.nodes[0].x));assert.equal(new Set(graph.nodes.map(n=>n.y)).size,3);
});
test('cycles, missing references and self-loops are surfaced without inventing successful execution',()=>{
 const graph=layoutWorkflow(tasks(['a','b','c']),[edge('a','b'),edge('b','a'),edge('b','c'),edge('missing','a')]);
 assert.equal(graph.unresolved,3);assert.equal(graph.missing,1);assert.equal(graph.nodes.length,3);assert(graph.edges.every(e=>!e.path.includes('NaN')));
 assert.equal(layoutWorkflow(tasks(['a']),[edge('a','a')]).unresolved,1);
});
test('completed stays pending acceptance; unknown and failed remain attention states',()=>{
 assert.equal(taskTone('completed'),'waiting');assert.equal(taskTone('accepted'),'done');
 for(const status of ['unknown','failed','blocked','needs_revision'])assert.equal(taskTone(status),'attention');
 assert.equal(taskTone('running'),'active');assert.equal(taskTone('unexpected'),'attention');
});
