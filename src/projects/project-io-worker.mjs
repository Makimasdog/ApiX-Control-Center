/**
 * 项目 IO 工作线程 - 在独立线程中执行文件系统密集型操作，避免阻塞主线程
 *
 * 所属层级：项目层
 * 核心功能：
 *   - 接收主线程发来的操作指令，分发到对应函数执行
 *   - 支持 18 种操作：基线管理、指纹计算、文件哈希、Git 状态检查、NPM 工作区准备等
 *   - 安全限制：只允许只读文件工具（read_file / list_files / search_files / load_skill）
 * 依赖关系：
 *   - 被 ← [→ 见 src/projects/project-io.ts] 作为 Worker 线程池的工作节点
 *   - 依赖 → [→ 见 src/projects/project-baseline.mjs] 基线与版本操作
 *   - 依赖 → [→ 见 src/assistant/assistant-tools.ts] 项目指纹、指令、技能查询
 *   - 依赖 → [→ 见 src/assistant/coding-files.ts] 文件内容读取与哈希
 *   - 依赖 → [→ 见 src/assistant/assistant-verification.ts] 验证契约相关
 *   - 依赖 → [→ 见 src/assistant/assistant-delivery.ts] 交付快照
 *   - 依赖 → [→ 见 src/validation/node-project.ts] Node 项目诊断
 *   - 依赖 → [→ 见 src/validation/npm-workspace.ts] NPM 工作区准备
 */
import {parentPort} from 'node:worker_threads';
import {projectBaseline,projectSourceVersion} from './project-baseline.mjs';
import {projectFingerprint,skillsFor,projectInstructions,fileTool,projectPath} from '../../dist/src/assistant/assistant-tools.js';
import {sourceBuffer,fileSha} from '../../dist/src/assistant/coding-files.js';
import {existsSync} from 'node:fs';
import {executableOnPath} from '../infrastructure/executable.mjs';
import {verificationContract,contractCurrent,verificationFingerprint} from '../../dist/src/assistant/assistant-verification.js';
import {reviewSnapshot} from '../../dist/src/assistant/assistant-delivery.js';
import {sourceManifest,treeEvidence,diagnoseNodeProject,boundedJson} from '../../dist/src/validation/node-project.js';
import {prepareNpmWorkspace,npmDependencies} from '../../dist/src/validation/npm-workspace.js';

/**
 * readProjectTool - 受限的文件读取工具，只允许只读操作
 * @param root - 项目根目录
 * @param tool - 工具名称，必须是 read_file / list_files / search_files / load_skill 之一
 * @param args - 工具参数
 * @returns 文件读取结果
 */
function readProjectTool(root,tool,args){if(!['read_file','list_files','search_files','load_skill'].includes(tool))throw new Error('文件后台检查只允许只读工具');return fileTool(root,tool,args);}
/**
 * codingHashes - 批量计算项目文件的 SHA256 哈希
 * @param root - 项目根目录
 * @param paths - 文件相对路径列表
 * @returns 哈希数组（失败项为 null）
 */
function codingHashes(root,paths){return paths.map(path=>{try{return fileSha(sourceBuffer(projectPath(root,path)));}catch{return null;}});}
/**
 * codingRecovery - 验证文件可读性并重新计算项目指纹，用于恢复场景
 * @param root - 项目根目录
 * @param paths - 需要验证的文件路径列表
 * @returns 项目指纹
 */
function codingRecovery(root,paths){for(const path of paths){const file=projectPath(root,path,true);if(existsSync(file))sourceBuffer(file);}return projectFingerprint(root);}
/**
 * executablesOnPath - 批量检查指定可执行程序是否存在于 PATH 中
 * @param names - 程序名称列表
 * @param path - 要搜索的 PATH 环境变量值
 * @returns [程序名, 是否找到] 的元组数组
 */
function executablesOnPath(names,path){return names.map(name=>[name,executableOnPath(name,{PATH:path})]);}
/** 操作映射表：将主线程发来的操作名称映射到实际函数 */
const operations={projectBaseline,projectSourceVersion,projectFingerprint,projectInstructions,skillsFor,readProjectTool,codingHashes,codingRecovery,executablesOnPath,verificationContract,contractCurrent,verificationFingerprint,reviewSnapshot,sourceManifest,treeEvidence,diagnoseNodeProject,boundedJson,prepareNpmWorkspace,npmDependencies};
// 消息处理：接收 {operation, args} 指令，执行后将结果或错误回传给主线程
parentPort.on('message',({operation,args})=>{
  try{if(!Object.hasOwn(operations,operation))throw new Error('未知项目文件检查');parentPort.postMessage({result:operations[operation](...args)});}
  catch(error){parentPort.postMessage({error:{message:String(error.message),code:error.code}});}
});
