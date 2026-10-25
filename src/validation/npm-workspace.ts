import {mkdtempSync,mkdirSync,lstatSync,openSync,closeSync,readSync,writeSync} from 'node:fs';
import {join,dirname,resolve,sep} from 'node:path';
import {sourceManifest,treeEvidence,boundedNames,boundedJson,nodeProjectLimits} from './node-project.js';
import {contractCurrent,type VerificationContract} from '../assistant/assistant-verification.js';

function copySource(from:string,to:string,size:number){const input=openSync(from,'r');let output:number|undefined,total=0;try{output=openSync(to,'wx');const buffer=Buffer.alloc(65536);let n;while((n=readSync(input,buffer,0,buffer.length,null))){if((total+=n)>size)throw new Error('复制期间源码超过预算');let offset=0;while(offset<n)offset+=writeSync(output,buffer,offset,n-offset);}if(total!==size)throw new Error('复制期间源码变化');}finally{closeSync(input);if(output!==undefined)closeSync(output);}}
export function prepareNpmWorkspace(directory:string,source:string,contract:VerificationContract){
  if(!contract.npm||!contractCurrent(source,contract))throw new Error('npm 配置已失效，请重新批准');const npm=contract.npm;
  mkdirSync(directory,{recursive:true});const entries=boundedNames(directory,20);if(entries.length>=20)throw new Error('已保留 20 次验证副本，请核对诊断资料后手工整理');let bytes=0;
  for(const name of entries){const path=join(directory,name);if(!lstatSync(path).isDirectory()||lstatSync(path).isSymbolicLink())throw new Error('验证存储包含未知资料');bytes+=treeEvidence(path,60000,384*1024*1024).bytes;}
  if(bytes>1024*1024*1024)throw new Error('验证副本总容量超过 1 GiB，请手工整理');
  const manifest=sourceManifest(source,npm.artifacts),fingerprint=manifest.hash,owned=mkdtempSync(join(directory,'run-')),workspace=join(owned,'workspace');mkdirSync(workspace);
  if(!resolve(owned).startsWith(resolve(directory)+sep))throw new Error('验证目录越界');
  for(const file of manifest.files){const target=join(workspace,file.path);mkdirSync(dirname(target),{recursive:true});copySource(join(source,file.path),target,file.size);}
  if(sourceManifest(workspace,npm.artifacts).hash!==manifest.hash||sourceManifest(source,npm.artifacts).hash!==manifest.hash||!contractCurrent(source,contract))throw new Error('复制期间源码变化，未启动安装');
  return {manifest,fingerprint,owned,workspace};
}
export function npmDependencies(workspace:string){
  const dependencies=treeEvidence(join(workspace,'node_modules'),nodeProjectLimits.dependencyFiles,nodeProjectLimits.dependencyBytes);
  for(const f of dependencies.files){if(/(?:^|[\\/])binding\.gyp$|\.node$/i.test(f.path))throw new Error('已安装依赖包含不支持的原生扩展');if(/(?:^|[\\/])package\.json$/.test(f.path)){const pkg=boundedJson(join(workspace,'node_modules',f.path));if(['preinstall','install','postinstall','prepare'].some(n=>pkg.scripts?.[n]))throw new Error('已安装依赖要求安装脚本，准备不完整');}}
  return {...dependencies,files:dependencies.files.length};
}
