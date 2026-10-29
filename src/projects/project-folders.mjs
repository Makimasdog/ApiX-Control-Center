/**
 * 项目目录管理 - 验证、解析和浏览项目文件夹路径
 *
 * 所属层级：项目层
 * 核心功能：
 *   - projectDirectory：验证并规范化项目目录路径（支持创建不存在的目录）
 *   - sameProjectDirectory：判断两个路径是否指向同一目录（处理符号链接和大小写）
 *   - browseFolders：浏览指定目录下的子文件夹列表，供前端目录选择器使用
 * 依赖关系：
 *   - 被 ← control-plane.mjs / server.mjs 调用，处理用户输入的项目路径
 */
import {existsSync,statSync,realpathSync,mkdirSync,readdirSync} from 'node:fs';
import {homedir} from 'node:os';
import {isAbsolute,resolve,dirname,parse,join} from 'node:path';

/**
 * projectDirectory - 验证并返回规范化的项目目录绝对路径
 * @param value - 用户输入的路径（字符串），会自动去除引号和空白
 * @param create - 目录不存在时是否自动创建，默认 false
 * @returns 经过 realpath 解析的绝对路径
 * @throws 路径为空、非绝对路径、不存在、不是目录等情况均抛出错误
 */
export function projectDirectory(value,create=false){
  const input=String(value??'').trim().replace(/^"(.*)"$/,'$1');
  if(!input || !isAbsolute(input))throw new Error('请选择文件夹，或输入项目的绝对路径');
  const path=resolve(input);
  if(!existsSync(path)){
    if(!create)throw new Error('项目目录不存在；请选择已有目录，或勾选创建目录');
    mkdirSync(path,{recursive:true});
  }
  if(!statSync(path).isDirectory())throw new Error('项目路径必须是文件夹，不能是文件');
  // 返回真实路径（解析所有符号链接）
  return realpathSync.native(path);
}

/**
 * sameProjectDirectory - 判断两个路径是否指向同一个物理目录
 * @param left - 第一个路径
 * @param right - 第二个路径
 * @returns true 表示指向同一目录；Windows 上忽略大小写
 */
export function sameProjectDirectory(left,right){
  try{const a=realpathSync.native(left),b=realpathSync.native(right);return process.platform==='win32'?a.toLowerCase()===b.toLowerCase():a===b;}catch{return false;}
}

/**
 * browseFolders - 列出指定目录下的子文件夹，供前端目录浏览器使用
 * @param value - 要浏览的目录路径，为空时使用用户主目录
 * @returns 包含当前路径、父目录、主目录、磁盘根目录列表、子文件夹列表的对象
 */
export function browseFolders(value){
  const path=projectDirectory(value||homedir());
  // Windows 列出所有存在的盘符根目录，其他系统只返回文件系统根
  const roots=process.platform==='win32'?Array.from({length:26},(_,i)=>`${String.fromCharCode(65+i)}:\\`).filter(p=>existsSync(p)):[parse(path).root];
  const directories=[];
  // 遍历当前目录下的所有条目，只保留目录（包括指向目录的符号链接）
  for(const entry of readdirSync(path,{withFileTypes:true})){
    try{if(entry.isDirectory() || entry.isSymbolicLink()&&statSync(join(path,entry.name)).isDirectory())directories.push({name:entry.name,path:join(path,entry.name)});}catch{/* 无法访问的条目跳过 */}
  }
  directories.sort((a,b)=>a.name.localeCompare(b.name));
  return {path,parent:dirname(path),home:homedir(),roots,directories};
}
