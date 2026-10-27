/**
 * coding-files.ts - 文件操作能力：提供有界的源文件读取、精确编辑和代码搜索
 *
 * 所属层级：助手层 - 编码工具
 * 核心功能：
 *   1. readSource —— 按行范围和字节预算分页读取源文件，返回 SHA256 哈希和游标
 *   2. prepareEdit / commitEdit —— 精确文本编辑，先校验再原子提交，防止并发冲突
 *   3. searchSource —— 项目内字面文本搜索，带时间/文件数/字节数多重预算控制
 *   4. sourceBuffer —— 有界文件读取工具函数，确保编辑前文件在安全范围内
 * 依赖关系：
 *   - 被助手工具层调用（read_file / edit_file / search_files 工具的实现）
 *   - 依赖 Node.js 原生 fs / crypto / path 模块
 */
import {openSync,readSync,closeSync,fstatSync,lstatSync,readFileSync,writeFileSync,renameSync,unlinkSync,fsyncSync,readdirSync} from 'node:fs';
import {createHash,randomUUID} from 'node:crypto';
import {join,relative} from 'node:path';

/** 各项文件操作的资源上限，防止单次操作消耗过多内存或 CPU */
export const codingLimits={readFileBytes:8*1024*1024,editFileBytes:2*1024*1024,readBytes:16000,searchBytes:2*1024*1024,searchFiles:400,searchMs:1500,diffCharacters:24000};
/** fileSha - 计算 Buffer 或字符串的 SHA256 哈希值 */
export const fileSha=(value:Buffer|string)=>createHash('sha256').update(value).digest('hex');
/** integer - 将未知输入安全转换为指定范围内的整数 */
const integer=(v:unknown,fallback:number,min:number,max:number)=>{const n=Number(v??fallback);if(!Number.isSafeInteger(n)||n<min||n>max)throw new Error('读取或搜索范围超出 MVP 预算');return n;};
/** token - 解码 base64url 格式的翻页游标（包含行号、字节偏移等状态） */
function token(value:unknown){if(typeof value!=='string'||value.length>2000)throw new Error('游标无效');try{return JSON.parse(Buffer.from(value,'base64url').toString('utf8'));}catch{throw new Error('游标无效');}}
/** cursor - 将状态对象编码为 base64url 格式的翻页游标 */
const cursor=(value:unknown)=>Buffer.from(JSON.stringify(value)).toString('base64url');
/** stable - 比对两次 fstat 结果，确认文件在读取期间未被修改 */
function stable(a:ReturnType<typeof fstatSync>,b:ReturnType<typeof fstatSync>){return a.ino===b.ino&&a.dev===b.dev&&a.size===b.size&&a.mtimeMs===b.mtimeMs&&a.ctimeMs===b.ctimeMs;}

// Hash the bounded source using fixed-size buffers; a range never loads the whole file into context or memory.
/**
 * readSource - 按行范围和字节预算分页读取源文件
 *
 * 特点：
 *   - 使用 64KB 固定缓冲区逐块读取，不会将整个文件加载到内存
 *   - 支持基于游标的分页（cursor），每次只返回预算内的数据
 *   - 读取前后校验文件指纹（SHA256 + stat），防止并发修改导致数据不一致
 *   - 拒绝符号链接和二进制文件
 *
 * @param path - 文件的绝对路径
 * @param args - 读取参数：startLine / endLine / maxBytes / cursor / expectedSha256
 * @returns 包含文件内容、哈希、行号范围、下一页游标等信息的结果对象
 */
export function readSource(path:string,args:Record<string,unknown>){
 if(lstatSync(path).isSymbolicLink())throw new Error('不读取符号链接');
 const fd=openSync(path,'r');try{
  const before=fstatSync(fd);if(!before.isFile()||before.size>codingLimits.readFileBytes)throw new Error('源文件超过 8 MiB 读取上限或不是普通文件');
  // 解析翻页参数：cursor 包含上次的字节偏移和行号；startLine/endLine 指定读取范围
  const page=args.cursor===undefined?null:token(args.cursor),start=integer(args.startLine,page?.line??1,1,1000000),end=integer(args.endLine,1000000,start,1000000),limit=integer(args.maxBytes,codingLimits.readBytes,1,codingLimits.readBytes);
  if(page&&(!Number.isSafeInteger(page.byte)||page.byte<0||page.byte>before.size||typeof page.sha256!=='string'))throw new Error('游标无效');
  // 使用 64KB 缓冲区逐块读取，同时计算哈希、提取目标行范围
  const hash=createHash('sha256'),decoder=new TextDecoder('utf-8',{fatal:true}),buffer=Buffer.alloc(65536),pieces:Buffer[]=[];let line=1,offset=0,returned=0,firstByte=-1,firstLine=0,lastLine=0,n;
  while((n=readSync(fd,buffer,0,buffer.length,null))>0){
   if(offset+n>codingLimits.readFileBytes)throw new Error('读取中源文件超出预算');const chunk=buffer.subarray(0,n);if(chunk.includes(0))throw new Error('文件不是 UTF-8 文本');decoder.decode(chunk,{stream:true});hash.update(chunk);
   // 逐字节扫描，按行号范围和字节预算提取目标内容
   let begin=-1;for(let i=0;i<n;i++){
    const include=line>=start&&line<=end&&(!page||offset+i>=page.byte)&&returned<limit;
    if(include){if(begin<0)begin=i;if(firstByte<0){firstByte=offset+i;firstLine=line;}lastLine=line;returned++;}
    if((!include||i===n-1)&&begin>=0){const stop=include?i+1:i;pieces.push(Buffer.from(chunk.subarray(begin,stop)));begin=-1;}
    if(chunk[i]===10)line++;
   }offset+=n;
  }decoder.decode();
  const sha256=hash.digest('hex');if(!stable(before,fstatSync(fd))||!stable(before,lstatSync(path)))throw new Error('读取期间文件发生变化，请重新读取');
  // 校验文件版本：游标中的哈希或期望哈希必须与当前一致
  if(page&&page.sha256!==sha256||args.expectedSha256!==undefined&&args.expectedSha256!==sha256)throw new Error('文件版本变化，游标过期，请重新读取');
  // 确保返回的内容在 UTF-8 边界上完整（不会截断多字节字符）
  let data=Buffer.concat(pieces);while(data.length){try{new TextDecoder('utf-8',{fatal:true}).decode(data);break;}catch{data=data.subarray(0,data.length-1);if(returned-data.length>3)throw new Error('UTF-8 读取边界无效');}}
  if(returned&&data.length===0)throw new Error('字节预算不足以返回一个完整 UTF-8 字符');
  const content=data.toString('utf8'),nextByte=firstByte<0?before.size:firstByte+data.length,nextLine=firstLine+(content.match(/\n/g)?.length??0),hasMore=nextByte<before.size;
  return {content,sha256,startLine:firstLine||start,endLine:lastLine||start,bytesReturned:data.length,bytesScanned:offset,byteBudget:limit,fileBytes:before.size,hasMore,lineTruncated:data.length>0&&!content.endsWith('\n')&&hasMore,nextCursor:hasMore?cursor({sha256,byte:nextByte,line:nextLine}):null};
 }finally{closeSync(fd);}
}

/**
 * sourceBuffer - 读取整个文件到内存缓冲区（用于编辑场景）
 * 限制文件大小不超过 editFileBytes（默认 2 MiB），拒绝符号链接和二进制文件。
 * @param path - 文件绝对路径
 * @param limit - 最大读取字节数
 * @returns 文件内容的 Buffer
 */
export function sourceBuffer(path:string,limit=codingLimits.editFileBytes){
 const stat=lstatSync(path);if(!stat.isFile()||stat.isSymbolicLink()||stat.size>limit)throw new Error('文件不在有界文本编辑范围（最大 2 MiB）');
 const fd=openSync(path,'r');try{const start=fstatSync(fd),buffer=Buffer.alloc(limit+1);let n=0,read;while(n<=limit&&(read=readSync(fd,buffer,n,buffer.length-n,null))>0)n+=read;if(n>limit||!stable(start,fstatSync(fd))||!stable(start,lstatSync(path)))throw new Error('文件版本变化或超出读取预算');const data=buffer.subarray(0,n);if(data.includes(0))throw new Error('不能编辑二进制文件');new TextDecoder('utf-8',{fatal:true}).decode(data);return data;}finally{closeSync(fd);}
}
/** PreparedEdit - 编辑预处理结果，包含编辑前后的内容、哈希、diff 和统计信息 */
export interface PreparedEdit {before:Buffer;after:Buffer;beforeSha256:string;afterSha256:string;diff:string;diffTruncated:boolean;added:number;removed:number}

/**
 * prepareEdit - 预处理精确编辑操作
 *
 * 校验规则：
 *   1. 文件 SHA256 必须与预期一致（防止编辑冲突）
 *   2. 每次编辑的 oldText 必须在文件中唯一匹配
 *   3. 多个编辑范围不能重叠
 *   4. 编辑后文件大小不超过 2 MiB
 *
 * @param path - 文件绝对路径
 * @param args - 编辑参数：expectedSha256 / edits（oldText + newText 数组）
 * @returns 预处理结果，包含编辑前后的 Buffer、diff 和统计
 */
export function prepareEdit(path:string,args:Record<string,unknown>):PreparedEdit{
 const before=sourceBuffer(path),beforeSha256=fileSha(before);if(args.expectedSha256!==beforeSha256)throw new Error('编辑冲突：文件版本变化，请重新读取');
 if(!Array.isArray(args.edits)||!args.edits.length||args.edits.length>8)throw new Error('需要 1–8 项精确编辑');const original=before.toString('utf8');
 // 逐一校验每个编辑段：oldText 必须唯一匹配，不能重叠
 const ranges=args.edits.map(edit=>{if(!edit||typeof edit.oldText!=='string'||!edit.oldText||edit.oldText.length>20000||typeof edit.newText!=='string'||edit.newText.length>20000)throw new Error('精确编辑文本无效');const at=original.indexOf(edit.oldText);if(at<0||original.indexOf(edit.oldText,at+1)>=0)throw new Error('编辑冲突：旧文本必须唯一匹配');return {at,end:at+edit.oldText.length,oldText:edit.oldText,newText:edit.newText};}).sort((a,b)=>a.at-b.at);
 if(ranges.some((r,i)=>i>0&&ranges[i-1]!.end>r.at))throw new Error('编辑冲突：编辑范围重叠');let content=original;for(const r of [...ranges].reverse())content=content.slice(0,r.at)+r.newText+content.slice(r.end);const after=Buffer.from(content);if(after.length>codingLimits.editFileBytes)throw new Error('编辑后文件超出 2 MiB 上限');
 // 生成统一 diff 格式（简化版），用于展示变更内容
 const diff=ranges.map(r=>`@@ line ${original.slice(0,r.at).split('\n').length} @@\n-${r.oldText.replaceAll('\n','\n-')}\n+${r.newText.replaceAll('\n','\n+')}`).join('\n');
 return {before,after,beforeSha256,afterSha256:fileSha(after),diff:diff.slice(0,codingLimits.diffCharacters),diffTruncated:diff.length>codingLimits.diffCharacters,added:ranges.reduce((n,r)=>n+r.newText.split('\n').length,0),removed:ranges.reduce((n,r)=>n+r.oldText.split('\n').length,0)};
}

/**
 * commitEdit - 原子提交文件编辑
 *
 * 提交流程：
 *   1. 创建临时文件（.apix-edit-UUID），写入编辑后内容并 fsync
 *   2. 再次校验原文件哈希未变（TOCTOU 防护）
 *   3. rename 临时文件到目标路径（原子替换）
 *   4. 最终校验替换后文件哈希与预期一致
 *
 * @param path - 目标文件路径
 * @param edit - prepareEdit 返回的预处理结果
 * @returns 编辑摘要（前后哈希、diff、增删行数）
 */
export function commitEdit(path:string,edit:PreparedEdit){
 const temp=path+'.apix-edit-'+randomUUID();let created=false;
 try{const fd=openSync(temp,'wx',lstatSync(path).mode);created=true;try{writeFileSync(fd,edit.after);fsyncSync(fd);}finally{closeSync(fd);}if(fileSha(sourceBuffer(path))!==edit.beforeSha256)throw new Error('编辑冲突：提交前文件发生变化');renameSync(temp,path);created=false;
  if(fileSha(sourceBuffer(path))!==edit.afterSha256)throw new Error('写入后文件状态无法确认');
 }finally{if(created)unlinkSync(temp);}
 return {beforeSha256:edit.beforeSha256,afterSha256:edit.afterSha256,diff:edit.diff,diffTruncated:edit.diffTruncated,added:edit.added,removed:edit.removed};
}

/**
 * searchSource - 项目内字面文本搜索
 *
 * 搜索策略：
 *   - 递归遍历目录，排除 .git / node_modules / dist 等常见非源码目录
 *   - 排除敏感文件（.env / .pem / .key / 凭据文件等）
 *   - 受时间预算（1500ms）、文件数预算（400）、字节预算（2 MiB）三重限制
 *   - 支持游标分页，搜索结果绑定查询条件和文件版本
 *
 * @param root - 项目根目录
 * @param args - 搜索参数：query / path / maxMatches / contextLines / cursor
 * @param pathFor - 将相对路径转换为绝对路径的回调
 * @returns 搜索结果，包含匹配项、扫描统计、截断原因和下一页游标
 */
export function searchSource(root:string,args:Record<string,unknown>,pathFor:(path:string)=>string){
 if(typeof args.query!=='string'||!args.query||args.query.length>200)throw new Error('搜索需要 1–200 字符的字面文本');const scope=typeof args.path==='string'?args.path:'.',start=performance.now(),entries:{path:string;size:number;mtime:number}[]=[];let files=0,scanBytes=0,partial:string|null=null;
 // excluded - 判断是否应排除该目录/文件名（安全文件 + 构建产物 + 临时文件）
 const excluded=(name:string)=>['.npmrc','model-credentials.json','owner-access.json'].includes(name.toLowerCase())||['.git','node_modules','dist','build','coverage','.next','target','vendor'].includes(name)||name.startsWith('.tmp')||/^\.env(?:\.|$)|^id_(rsa|ed25519)$|\.(pem|key|pfx|p12)$/i.test(name);
 // visit - 递归遍历目录树，收集文件清单（受时间和文件数预算限制）
 function visit(path:string){if(performance.now()-start>codingLimits.searchMs){partial='time_budget';return;}const stat=lstatSync(path);if(stat.isSymbolicLink())return;if(stat.isDirectory()){for(const name of readdirSync(path).sort()){if(excluded(name))continue;if(files>=codingLimits.searchFiles){partial='file_budget';return;}visit(join(path,name));if(partial)return;}}else if(stat.isFile()){files++;entries.push({path:relative(root,path).replaceAll('\\','/'),size:stat.size,mtime:stat.mtimeMs});}}
 visit(pathFor(scope));const inventory=fileSha(JSON.stringify(entries)),page=args.cursor===undefined?null:token(args.cursor),binding=fileSha(JSON.stringify([args.query,scope]));if(page&&(page.binding!==binding||page.inventory!==inventory))throw new Error('搜索范围或文件变化，游标过期');
 const max=integer(args.maxMatches,20,1,100),context=integer(args.contextLines,1,0,3),matches:unknown[]=[];let ordinal=0,nextCursor:string|null=null,skipped=0,outputBytes=0;const version=createHash('sha256');
 for(const entry of entries){if(performance.now()-start>codingLimits.searchMs){partial='time_budget';break;}if(entry.size>256*1024){skipped++;partial??='file_size_budget';continue;}if(scanBytes+entry.size>codingLimits.searchBytes){partial='scan_byte_budget';break;}
  // 读取文件内容并搜索匹配项（逐行扫描，支持 UTF-16 列号）
  const path=pathFor(entry.path);let data:Buffer;try{data=sourceBuffer(path,256*1024);}catch(error){if(error instanceof Error&&/UTF-8|二进制/.test(error.message)){skipped++;partial??='non_text_files';continue;}throw error;}scanBytes+=data.length;version.update(entry.path).update(data);let content;try{content=new TextDecoder('utf-8',{fatal:true,ignoreBOM:true}).decode(data);}catch{skipped++;partial??='non_text_files';continue;}const lines=content.split('\n');
  for(let line=0;line<lines.length;line++){let column=0;while((column=lines[line]!.indexOf(args.query,column))>=0){const index=ordinal++;if(index>=(page?.offset??0)&&matches.length<max&&outputBytes<16000){const snippet=lines.slice(Math.max(0,line-context),line+context+1).join('\n').slice(0,2000);matches.push({path:entry.path,line:line+1,column:column+1,columnUnit:'utf16',snippet,snippetTruncated:lines[line]!.length>2000});outputBytes+=Buffer.byteLength(snippet);}column+=args.query.length;}}
 }
 // 校验搜索内容的版本哈希，确保游标未过期
 const contentVersion=version.digest('hex');if(page&&page.version!==contentVersion)throw new Error('搜索内容发生变化，游标过期');
 const consumed=(page?.offset??0)+matches.length;if(consumed<ordinal)nextCursor=cursor({binding,inventory,version:contentVersion,offset:consumed});
 return {matches,scanComplete:partial===null,truncated:partial!==null||nextCursor!==null,truncationReason:partial??(nextCursor?'match_budget':null),nextCursor,filesScanned:files,bytesScanned:scanBytes,skippedFiles:skipped,limits:codingLimits};
}
