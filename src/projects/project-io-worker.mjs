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

function readProjectTool(root,tool,args){if(!['read_file','list_files','search_files','load_skill'].includes(tool))throw new Error('文件后台检查只允许只读工具');return fileTool(root,tool,args);}
function codingHashes(root,paths){return paths.map(path=>{try{return fileSha(sourceBuffer(projectPath(root,path)));}catch{return null;}});}
function codingRecovery(root,paths){for(const path of paths){const file=projectPath(root,path,true);if(existsSync(file))sourceBuffer(file);}return projectFingerprint(root);}
function executablesOnPath(names,path){return names.map(name=>[name,executableOnPath(name,{PATH:path})]);}
const operations={projectBaseline,projectSourceVersion,projectFingerprint,projectInstructions,skillsFor,readProjectTool,codingHashes,codingRecovery,executablesOnPath,verificationContract,contractCurrent,verificationFingerprint,reviewSnapshot,sourceManifest,treeEvidence,diagnoseNodeProject,boundedJson,prepareNpmWorkspace,npmDependencies};
parentPort.on('message',({operation,args})=>{
  try{if(!Object.hasOwn(operations,operation))throw new Error('未知项目文件检查');parentPort.postMessage({result:operations[operation](...args)});}
  catch(error){parentPort.postMessage({error:{message:String(error.message),code:error.code}});}
});
