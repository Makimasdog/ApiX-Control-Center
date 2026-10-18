import {createHash} from 'node:crypto';
import {projectPath,projectFingerprint} from './assistant-tools.js';
import {parseAutonomyPolicy,autonomyDefaults,type CheckCommand} from './architecture.js';
import {object} from './contracts.js';
import {existsSync,realpathSync} from 'node:fs';
import {dirname,relative,resolve} from 'node:path';

export interface VerificationContract {version:string;source:'user_approved';authorized:true;checks:CheckCommand[];writablePaths:string[];protectedFingerprint:string;runtime:{executable:string;nodeVersion:string}}
export function verificationContract(root:string,input:Record<string,unknown>):VerificationContract {
  const checks=parseAutonomyPolicy({...autonomyDefaults,enabled:true,checks:input.checks},1).checks;
  if(checks.some(c=>c.timeoutMs>120000||c.args.length>40||c.args.some(a=>a.length>2000)))throw new Error('检查参数超出命令执行器限制');
  if(!Array.isArray(input.writablePaths)||!input.writablePaths.length||input.writablePaths.length>40)throw new Error('必须明确批准 1–40 个可修改文件或目录');
  function canonical(path:string){const target=projectPath(root,path,true);let parent=target;while(!existsSync(parent))parent=dirname(parent);return relative(realpathSync.native(root),resolve(realpathSync.native(parent),relative(parent,target))).replaceAll('\\','/');}
  const writablePaths=input.writablePaths.map(p=>{if(typeof p!=='string'||!p||p.length>1000||p.includes('\\')||p.split('/').some(s=>!s||s==='.'||s==='..'))throw new Error('可修改范围必须为项目相对路径');return canonical(p);});
  const key=(p:string)=>process.platform==='win32'?p.toLowerCase():p;
  for(const c of checks){projectPath(root,c.args[0]);const script=key(canonical(c.args[0]!));if(writablePaths.some(p=>script===key(p)||script.startsWith(key(p)+'/')))throw new Error('验收脚本不得位于可修改范围');}
  // Freeze helpers/configuration/dependencies too, including normally hidden command output paths.
  // Fail closed at the existing scan limits rather than silently trusting an incomplete script closure.
  const body={source:'user_approved' as const,authorized:true as const,checks,writablePaths,protectedFingerprint:projectFingerprint(root,writablePaths,true),runtime:{executable:process.execPath,nodeVersion:process.version}};
  return {...body,version:createHash('sha256').update(JSON.stringify(body)).digest('hex')};
}
export function contractCurrent(root:string,c:VerificationContract){return verificationContract(root,{...c}).version===c.version;}
export function checkPassed(result:unknown){const r=object(result);return r.exitCode===0&&r.timedOut===false&&r.aborted===false&&r.unknown===false;}
