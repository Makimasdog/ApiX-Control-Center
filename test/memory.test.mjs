import {test} from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {createMemory} from '../dist/src/coordination/memory.js';
test('history stays bounded, older pages retain snapshots and searches preserve Unicode literal matching',()=>{
  const db=new DatabaseSync(':memory:');db.exec("CREATE TABLE projects(id TEXT PRIMARY KEY);INSERT INTO projects VALUES ('p'),('other')");
  try{
    const memory=createMemory({db,row:(sql,...params)=>db.prepare(sql).get(...params),rows:(sql,...params)=>db.prepare(sql).all(...params),now:()=>new Date().toISOString()});
    memory.append('p','s','coordination.snapshot',{marker:'snapshot'});
    for(let i=0;i<450;i++)memory.append('p','s','event',{text:'ÄPIΧ 中文 %_ '+i});
    memory.append('other','s','event',{text:'other'});
    const newest=memory.stateAt('p','s');assert.equal(newest.events.length,200);assert.equal(newest.state.marker,'snapshot');assert(newest.previousAt);
    const older=memory.stateAt('p','s',newest.previousAt);assert.equal(older.events.length,200);assert(older.events.at(-1).sequence<newest.events[0].sequence);
    const oldest=memory.stateAt('p','s',older.previousAt);assert.equal(oldest.events.length,51);assert.equal(oldest.previousAt,null);assert.equal(oldest.state.marker,'snapshot');
    assert.equal(memory.search('p','äpiχ').length,50);assert.equal(memory.search('p','%_').length,50);assert.deepEqual(memory.search('p','other'),[]);
    assert.throws(()=>memory.stateAt('p','s',-1),/序号/);
  }finally{db.close();}
});
