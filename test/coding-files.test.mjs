import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,writeFileSync,readFileSync,rmSync,mkdirSync,symlinkSync} from 'node:fs';
import {tmpdir} from 'node:os';import {join,resolve} from 'node:path';
import {createHash} from 'node:crypto';
import {fileTool} from '../dist/src/assistant/assistant-tools.js';
const sha=text=>createHash('sha256').update(text).digest('hex');
function fixture(work){const root=mkdtempSync(join(tmpdir(),'apix-coding-files-'));try{return work(root);}finally{assert(resolve(root).startsWith(resolve(tmpdir())));rmSync(root,{recursive:true,force:true});}}
test('literal search paginates stable matches, excludes credentials and reports staleness',()=>fixture(root=>{
 writeFileSync(join(root,'a.ts'),'alpha\nBUG one\nBUG two\n');writeFileSync(join(root,'.env'),'BUG secret');mkdirSync(join(root,'dist'));writeFileSync(join(root,'dist/generated.js'),'BUG generated');
 const first=fileTool(root,'search_files',{query:'BUG',maxMatches:1});assert.equal(first.matches.length,1);assert.equal(first.matches[0].line,2);assert(first.nextCursor);const second=fileTool(root,'search_files',{query:'BUG',maxMatches:1,cursor:first.nextCursor});assert.equal(second.matches[0].line,3);assert.equal(second.matches[0].path,'a.ts');writeFileSync(join(root,'a.ts'),'changed');assert.throws(()=>fileTool(root,'search_files',{query:'BUG',cursor:first.nextCursor}),/变化|过期/);
}));
test('range reads a UTF-8 CRLF source over 100 KiB, then edits only unique requested bytes',()=>fixture(root=>{
 const original='// 用户保留\r\n'+'const filler = 1;\r\n'.repeat(7000)+'return wrong;';writeFileSync(join(root,'big.ts'),original);
 const r=fileTool(root,'read_file',{path:'big.ts',startLine:7001,endLine:7002});assert(r.content.includes('return wrong;'));assert(r.bytesReturned<200);assert.equal(r.sha256,sha(original));
 const e=fileTool(root,'edit_file',{path:'big.ts',expectedSha256:r.sha256,edits:[{oldText:'return wrong;',newText:'return correct;'}]});assert.equal(e.beforeSha256,r.sha256);assert.equal(readFileSync(join(root,'big.ts'),'utf8'),original.replace('return wrong;','return correct;'));
 assert.throws(()=>fileTool(root,'edit_file',{path:'big.ts',expectedSha256:r.sha256,edits:[{oldText:'return correct;',newText:'stale'}]}),/冲突|版本/);
}));
test('ambiguous and overlapping edits never partially write',()=>fixture(root=>{
 writeFileSync(join(root,'a'),'repeat repeat unique');const input={path:'a',expectedSha256:sha('repeat repeat unique'),edits:[{oldText:'unique',newText:'changed'},{oldText:'repeat',newText:'bad'}]};assert.throws(()=>fileTool(root,'edit_file',input),/唯一|冲突/);assert.equal(readFileSync(join(root,'a'),'utf8'),'repeat repeat unique');
}));
test('range cursors preserve UTF-8, CRLF and a long unterminated line and reject changed pages',()=>fixture(root=>{
 const original='中文🚀'.repeat(100)+'\r\nlast';writeFileSync(join(root,'long.ts'),original);let content='',cursor;
 do{const r=fileTool(root,'read_file',{path:'long.ts',maxBytes:17,...(cursor?{cursor}:{startLine:1})});assert(r.bytesReturned<=17);content+=r.content;cursor=r.nextCursor;}while(cursor);assert.equal(content,original);
 const first=fileTool(root,'read_file',{path:'long.ts',startLine:1,maxBytes:17});writeFileSync(join(root,'long.ts'),original+'external');assert.throws(()=>fileTool(root,'read_file',{path:'long.ts',cursor:first.nextCursor}),/变化|过期/);
}));
test('search declares partial scans and never follows a junction outside the project',()=>fixture(root=>{
 const outside=mkdtempSync(join(tmpdir(),'apix-search-outside-'));try{writeFileSync(join(root,'large.ts'),'x'.repeat(300000));writeFileSync(join(root,'binary.bin'),Buffer.from([0,1]));writeFileSync(join(outside,'secret'),'NEEDLE');symlinkSync(outside,join(root,'alias'),process.platform==='win32'?'junction':'dir');const r=fileTool(root,'search_files',{query:'NEEDLE'});assert.equal(r.scanComplete,false);assert.equal(r.matches.length,0);assert(r.truncationReason);assert.throws(()=>fileTool(root,'read_file',{path:'alias/secret'}),/链接|边界/);}finally{assert(resolve(outside).startsWith(resolve(tmpdir())));rmSync(outside,{recursive:true,force:true});}
}));
