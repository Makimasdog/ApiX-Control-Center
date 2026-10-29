/**
 * NPM 工作区准备 - 为验证流程创建隔离的工作区副本，复制源码并生成证据清单
 *
 * 所属层级：校验层
 * 核心功能：
 *   - prepareNpmWorkspace：创建隔离的验证工作区
 *     - 限制验证副本数量（最多 20 个）和总容量（最多 1 GiB）
 *     - 从源项目复制文件到新的临时目录
 *     - 复制前后进行三重哈希校验，确保源码未被并发修改
 *   - npmDependencies：扫描已安装的 node_modules 目录
 *     - 检测不支持的原生扩展（.node / binding.gyp）
 *     - 检测安装生命周期脚本（安全策略禁止）
 * 依赖关系：
 *   - 依赖 → [→ 见 src/validation/node-project.ts] sourceManifest / treeEvidence 等扫描工具
 *   - 依赖 → [→ 见 src/assistant/assistant-verification.ts] 验证契约检查
 *   - 被 ← [→ 见 src/projects/project-io-worker.mjs] 通过 IO 线程池调用
 *   - 被 ← [→ 见 src/validation/npm-validation.ts] 校验流程调用
 */
import {mkdtempSync,mkdirSync,lstatSync,openSync,closeSync,readSync,writeSync} from 'node:fs';
import {join,dirname,resolve,sep} from 'node:path';
import {sourceManifest,treeEvidence,boundedNames,boundedJson,nodeProjectLimits} from './node-project.js';
import {contractCurrent,type VerificationContract} from '../assistant/assistant-verification.js';

/**
 * copySource - 安全地复制单个源文件（使用 O_EXCL 防止覆盖，复制后校验大小一致）
 * @param from - 源文件路径
 * @param to - 目标文件路径
 * @param size - 预期的文件大小（用于校验复制完整性）
 */
function copySource(from:string,to:string,size:number){const input=openSync(from,'r');let output:number|undefined,total=0;try{output=openSync(to,'wx');const buffer=Buffer.alloc(65536);let n;while((n=readSync(input,buffer,0,buffer.length,null))){if((total+=n)>size)throw new Error('复制期间源码超过预算');let offset=0;while(offset<n)offset+=writeSync(output,buffer,offset,n-offset);}if(total!==size)throw new Error('复制期间源码变化');}finally{closeSync(input);if(output!==undefined)closeSync(output);}}
/**
 * prepareNpmWorkspace - 创建隔离的 NPM 验证工作区
 *
 * 流程：
 *   1. 验证契约有效性
 *   2. 检查验证副本数量和总容量限制
 *   3. 生成源项目清单（manifest）和指纹
 *   4. 创建临时目录并复制源文件
 *   5. 三重校验：复制后工作区哈希 == 清单哈希 && 源项目哈希 == 清单哈希 && 契约仍有效
 * @param directory - 验证存储根目录（存放所有验证副本）
 * @param source - 源项目路径
 * @param contract - 验证契约
 * @returns {manifest, fingerprint, owned, workspace} 清单、指纹、隔离目录和工作区路径
 */
export function prepareNpmWorkspace(directory:string,source:string,contract:VerificationContract){
  if(!contract.npm||!contractCurrent(source,contract))throw new Error('npm 配置已失效，请重新批准');const npm=contract.npm;
  mkdirSync(directory,{recursive:true});const entries=boundedNames(directory,20);if(entries.length>=20)throw new Error('已保留 20 次验证副本，请核对诊断资料后手工整理');let bytes=0;
  // 统计已有验证副本的总容量
  for(const name of entries){const path=join(directory,name);if(!lstatSync(path).isDirectory()||lstatSync(path).isSymbolicLink())throw new Error('验证存储包含未知资料');bytes+=treeEvidence(path,60000,384*1024*1024).bytes;}
  if(bytes>1024*1024*1024)throw new Error('验证副本总容量超过 1 GiB，请手工整理');
  // 生成源项目清单和指纹
  const manifest=sourceManifest(source,npm.artifacts),fingerprint=manifest.hash,owned=mkdtempSync(join(directory,'run-')),workspace=join(owned,'workspace');mkdirSync(workspace);
  // 安全检查：确保隔离目录在验证存储范围内
  if(!resolve(owned).startsWith(resolve(directory)+sep))throw new Error('验证目录越界');
  // 逐文件复制源码到工作区
  for(const file of manifest.files){const target=join(workspace,file.path);mkdirSync(dirname(target),{recursive:true});copySource(join(source,file.path),target,file.size);}
  // 三重校验：确保复制期间源码未被并发修改，且契约仍然有效
  if(sourceManifest(workspace,npm.artifacts).hash!==manifest.hash||sourceManifest(source,npm.artifacts).hash!==manifest.hash||!contractCurrent(source,contract))throw new Error('复制期间源码变化，未启动安装');
  return {manifest,fingerprint,owned,workspace};
}
/**
 * npmDependencies - 扫描已安装的 node_modules 目录，验证依赖完整性
 * @param workspace - 工作区路径
 * @returns 依赖证据清单（文件数、哈希等），但 files 字段为数量而非数组
 * @throws 检测到原生扩展或安装脚本时抛出错误
 */
export function npmDependencies(workspace:string){
  const dependencies=treeEvidence(join(workspace,'node_modules'),nodeProjectLimits.dependencyFiles,nodeProjectLimits.dependencyBytes);
  // 逐个检查已安装的依赖：禁止原生扩展和安装生命周期脚本
  for(const f of dependencies.files){if(/(?:^|[\\/])binding\.gyp$|\.node$/i.test(f.path))throw new Error('已安装依赖包含不支持的原生扩展');if(/(?:^|[\\/])package\.json$/.test(f.path)){const pkg=boundedJson(join(workspace,'node_modules',f.path));if(['preinstall','install','postinstall','prepare'].some(n=>pkg.scripts?.[n]))throw new Error('已安装依赖要求安装脚本，准备不完整');}}
  return {...dependencies,files:dependencies.files.length};
}
