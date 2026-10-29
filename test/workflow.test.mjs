import {test} from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {createWorkflow} from '../dist/src/coordination/workflow.js';
import {createPermissions} from '../dist/src/coordination/permissions.js';

function fixture(work){
  const db=new DatabaseSync(':memory:');
  db.exec("CREATE TABLE projects(id TEXT PRIMARY KEY);INSERT INTO projects VALUES ('p'),('q');CREATE TABLE employees(id TEXT PRIMARY KEY,deleted_at TEXT);INSERT INTO employees VALUES ('worker',NULL);CREATE TABLE tasks(id TEXT PRIMARY KEY,project_id TEXT,employee_id TEXT,status TEXT);CREATE TABLE events(body TEXT);");
  const store={db,row:(sql,...args)=>db.prepare(sql).get(...args),rows:(sql,...args)=>db.prepare(sql).all(...args),now:()=>new Date().toISOString()};
  const permissions=createPermissions(store,{append(...args){db.prepare('INSERT INTO events VALUES (?)').run(JSON.stringify(args));}});
  const workflow=createWorkflow(store,permissions,()=>[{id:'worker'}]);
  const request=()=>({version:workflow.get('p').version,enabled:true,approved:true,managerVersion:permissions.get('p').version,employees:[{id:'worker',version:permissions.get('p','worker').version}]});
  try{work({db,store,permissions,workflow,request});}finally{db.close();}
}
test('current full permissions allow automation for every active status without invalidating task grants',()=>fixture(({db,permissions,workflow,request})=>{
  permissions.save('p','apix','full_access',0);permissions.save('p','worker','full_access',0);
  for(const status of ['running','starting','stopping','queued','unknown']){
    db.prepare('INSERT INTO tasks VALUES (?,?,?,?)').run(status,'p','worker',status);permissions.grant(status,'p','worker','user');
    const events=db.prepare('SELECT COUNT(*) AS n FROM events').get().n;
    assert.equal(workflow.save('p',request()).enabled,true);
    permissions.assertGranted(status,'p','worker');assert.equal(permissions.get('p').version,1);assert.equal(permissions.get('p','worker').version,1);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM events').get().n,events);assert.equal(db.prepare('SELECT status FROM tasks WHERE id=?').get(status).status,status);
  }
}));
test('permission elevation remains blocked for running, queued and unknown tasks with concrete diagnostics and rollback',()=>fixture(({db,permissions,workflow,request})=>{
  for(const status of ['running','starting','stopping','queued','unknown']){
    db.prepare('INSERT INTO tasks VALUES (?,?,?,?)').run('active','p','worker',status);
    assert.throws(()=>workflow.save('p',request()),error=>error.message.includes('active')&&error.message.includes(status)&&error.message.includes('不能提升'));
    assert.equal(workflow.get('p').version,0);assert.equal(permissions.get('p').version,0);assert.equal(permissions.get('p','worker').version,0);assert.equal(db.prepare('SELECT COUNT(*) AS n FROM events').get().n,0);
    db.exec('DELETE FROM tasks');
  }
}));
test('idle activation changes only necessary permissions and other projects do not block it',()=>fixture(({db,permissions,workflow,request})=>{
  permissions.save('p','apix','full_access',0);db.exec("INSERT INTO tasks VALUES ('elsewhere','q','worker','unknown')");
  workflow.save('p',request());assert.equal(permissions.get('p').version,1);assert.equal(permissions.get('p','worker').version,1);
}));
test('unchanged permissions still require fresh versions, explicit approval and eligible unique employees',()=>fixture(({permissions,workflow,request})=>{
  permissions.save('p','apix','full_access',0);permissions.save('p','worker','full_access',0);
  for(const input of [{...request(),managerVersion:0},{...request(),employees:[{id:'worker',version:0}]},{...request(),approved:false},{...request(),employees:[{id:'worker',version:1},{id:'worker',version:1}]},{...request(),employees:[{id:'missing',version:0}]}])assert.throws(()=>workflow.save('p',input));
  assert.equal(workflow.get('p').version,0);assert.equal(permissions.get('p').version,1);assert.equal(permissions.get('p','worker').version,1);
}));
