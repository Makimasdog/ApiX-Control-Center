import {existsSync,statSync,realpathSync,mkdirSync,readdirSync} from 'node:fs';
import {homedir} from 'node:os';
import {isAbsolute,resolve,dirname,parse,join} from 'node:path';

export function projectDirectory(value,create=false){
  const input=String(value??'').trim().replace(/^"(.*)"$/,'$1');
  if(!input || !isAbsolute(input))throw new Error('请选择文件夹，或输入项目的绝对路径');
  const path=resolve(input);
  if(!existsSync(path)){
    if(!create)throw new Error('项目目录不存在；请选择已有目录，或勾选创建目录');
    mkdirSync(path,{recursive:true});
  }
  if(!statSync(path).isDirectory())throw new Error('项目路径必须是文件夹，不能是文件');
  return realpathSync(path);
}

export function browseFolders(value){
  const path=projectDirectory(value||homedir());
  const roots=process.platform==='win32'?Array.from({length:26},(_,i)=>`${String.fromCharCode(65+i)}:\\`).filter(p=>existsSync(p)):[parse(path).root];
  const directories=[];
  for(const entry of readdirSync(path,{withFileTypes:true})){
    try{if(entry.isDirectory() || entry.isSymbolicLink()&&statSync(join(path,entry.name)).isDirectory())directories.push({name:entry.name,path:join(path,entry.name)});}catch{/* Inaccessible entries cannot be selected. */}
  }
  directories.sort((a,b)=>a.name.localeCompare(b.name));
  return {path,parent:dirname(path),home:homedir(),roots,directories};
}
