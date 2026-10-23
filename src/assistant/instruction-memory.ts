import {existsSync,readFileSync,statSync,realpathSync,readdirSync} from 'node:fs';
import {resolve,relative,dirname,join,isAbsolute} from 'node:path';
import {createHash} from 'node:crypto';
import {projectPath} from './assistant-tools.js';
import {sensitiveMemory} from './project-memory.js';

export interface InstructionOptions {userFile?:string;managedFile?:string;externalApprovals?:string[];paths?:string[]}
export interface InstructionFile {path:string;layer:string;bytes:number;lines:number;truncated:boolean;content:string;authority:string;approval?:string;blocked?:string;version:string;updatedAt:string}
export function loadInstructions(root:string,options:InstructionOptions={}){
  const files:InstructionFile[]=[],seen=new Set<string>();let total=0,attempts=0;
  root=realpathSync.native(root);
  function load(input:string,layer:string,depth=0,parents:string[]=[],explicit=false){
    if(++attempts>128)throw new Error('指令文件数量超过 128 次加载上限');
    if(depth>5)throw new Error('指令导入超过 5 层');
    const absolute=resolve(root,input),rel=relative(root,absolute),external=rel==='..'||rel.startsWith('..'+(process.platform==='win32'?'\\':'/'))||isAbsolute(rel);
    let path:string;
    if(external){
      // An external file must still pass the same credential-name and symlink boundary checks.
      path=projectPath(dirname(absolute),absolute.slice(dirname(absolute).length+1));
    }else path=projectPath(root,rel||'.');
    path=realpathSync.native(path);
    if(parents.includes(path))throw new Error('指令导入存在循环');if(seen.has(path))return;
    const stat=statSync(path);if(!stat.isFile()||stat.size>16000)throw new Error('指令文件超过 16000 字节上限或不是普通文件');
    const content=readFileSync(path,'utf8'),bytes=Buffer.byteLength(content),lines=content.split('\n').length;
    const meta={version:createHash('sha256').update(content).digest('hex'),updatedAt:stat.mtime.toISOString()};
    const approval=createHash('sha256').update(path+'\0'+content).digest('hex');
    if(external&&!explicit&&!options.externalApprovals?.includes(approval)){files.push({...meta,path:rel,layer,bytes,lines,truncated:false,content:'',authority:'reference_only',approval,blocked:'项目外导入待用户确认；内容未加载'});return;}
    if(sensitiveMemory(content))throw new Error('指令文件包含疑似敏感内容，已阻止加载');
    if((total+=bytes)>64000)throw new Error('分层指令总量超过 64000 字节');seen.add(path);
    // Imports precede the importing file, so the more specific file wins textual conflicts.
    for(const line of content.split(/\r?\n/)){const match=line.match(/^\s*@(?:"([^"]+)"|(\S+))\s*$/);if(match)load(resolve(dirname(path),match[1]??match[2]!),layer,depth+1,[...parents,path]);}
    files.push({...meta,path:external?path:relative(root,path).replaceAll('\\','/'),layer,bytes,lines,truncated:false,content,authority:'reference_only'});
  }
  for(const [layer,file] of [['managed',options.managedFile],['user-private',options.userFile]])if(file)load(file,layer!,0,[],true);
  const paths=(options.paths??[]).slice(0,50).map(p=>{projectPath(root,p);return p.replaceAll('\\','/');});
  const dirs=new Set(['']);for(const p of paths){let dir=statSync(projectPath(root,p)).isDirectory()?p:dirname(p);while(dir!=='.'){dirs.add(dir);const next=dirname(dir);if(next===dir)break;dir=next;}}
  for(const dir of [...dirs].sort((a,b)=>a.split(/[\\/]/).length-b.split(/[\\/]/).length||a.localeCompare(b))){
    for(const name of ['AGENTS.md','CLAUDE.md','APIX.md','APIX.local.md','CLAUDE.local.md']){const file=join(dir,name);if(existsSync(resolve(root,file)))load(file,name.includes('.local.')?'local-private':dir?'directory':'project');}
    for(const base of ['.claude/rules','.apix/rules']){const directory=join(dir,base);if(!existsSync(resolve(root,directory)))continue;const safe=projectPath(root,directory);
      for(const name of readdirSync(safe).sort()){if(!name.endsWith('.md'))continue;const file=projectPath(root,join(directory,name));if(statSync(file).size>16000)throw new Error('规则文件超过 16000 字节');const header=readFileSync(file,'utf8').match(/^---\r?\n([\s\S]*?)\r?\n---/);
        if(header){const rule=header[1]!.match(/paths:\s*(?:\[([^\]]+)\]|\r?\n((?:\s+-[^\n]+\n?)+))/);if(!rule)throw new Error('规则 frontmatter 需要 paths 列表');const patterns=(rule[1]??rule[2]!).split(/,|\r?\n/).map(s=>s.trim().replace(/^-\s*/, '').replace(/^['"]|['"]$/g,'')).filter(Boolean);if(!patterns.some(pattern=>paths.some(p=>glob(pattern,relative(dir||'.',p).replaceAll('\\','/')))))continue;}
        load(join(directory,name),'path-rule');
      }
    }
  }
  return files;
}
function glob(pattern:string,path:string){const escaped=pattern.replace(/[.+^${}()|[\]\\]/g,'\\$&').replace(/\*\*\//g,'\u0001').replace(/\*\*/g,'\u0002').replace(/\*/g,'[^/]*').replace(/\?/g,'[^/]').replace(/\u0001/g,'(?:.*/)?').replace(/\u0002/g,'.*');return new RegExp('^'+escaped+'$').test(path);}
