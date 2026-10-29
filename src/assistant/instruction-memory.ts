/**
 * instruction-memory.ts - 指令记忆：AGENTS.md 等指令文件的分层加载与持久化管理
 *
 * 所属层级：助手层 - 记忆系统
 * 核心功能：
 *   1. 分层加载指令文件——按优先级加载 managed / user-private / local-private / directory / project 层
 *   2. @import 递归解析——支持指令文件通过 @import 导入其他文件（最多 5 层深度）
 *   3. 外部文件审批——项目外文件需经用户确认后才加载内容
 *   4. 敏感内容检测——阻止包含密钥、密码等敏感信息的指令文件
 *   5. 路径规则匹配——.claude/rules 和 .apix/rules 目录下的规则文件按路径模式过滤
 * 依赖关系：
 *   - 被助手主循环调用，在构建提示词前加载指令上下文
 *   - 依赖 [→ 见 src/assistant/assistant-tools.ts] 的 projectPath 安全路径解析
 *   - 依赖 [→ 见 src/assistant/project-memory.ts] 的 sensitiveMemory 敏感内容检测
 */
import {existsSync,readFileSync,statSync,realpathSync,readdirSync} from 'node:fs';
import {resolve,relative,dirname,join,isAbsolute} from 'node:path';
import {createHash} from 'node:crypto';
import {projectPath} from './assistant-tools.js';
import {sensitiveMemory} from './project-memory.js';

/** 指令加载选项：用户私有文件、管理文件、外部审批列表、路径列表 */
export interface InstructionOptions {userFile?:string;managedFile?:string;externalApprovals?:string[];paths?:string[]}
/** 单个指令文件的加载结果，包含路径、层级、内容、版本等信息 */
export interface InstructionFile {path:string;layer:string;bytes:number;lines:number;truncated:boolean;content:string;authority:string;approval?:string;blocked?:string;version:string;updatedAt:string}
/**
 * loadInstructions - 加载项目的所有指令文件
 *
 * 加载顺序和层级（从低到高）：
 *   - project：根目录的 AGENTS.md / CLAUDE.md / APIX.md
 *   - directory：子目录中的同名文件
 *   - local-private：.local.md 后缀的私有文件
 *   - path-rule：.claude/rules 和 .apix/rules 下的规则文件（按路径模式过滤）
 *   - user-private：用户指定的私有指令文件
 *   - managed：管理员指定的指令文件
 *
 * @param root - 项目根目录
 * @param options - 加载选项
 * @returns 按加载顺序排列的指令文件列表
 */
export function loadInstructions(root:string,options:InstructionOptions={}){
  const files:InstructionFile[]=[],seen=new Set<string>();let total=0,attempts=0;
  root=realpathSync.native(root);
  /**
   * load - 递归加载单个指令文件
   * @param input - 文件路径（相对或绝对）
   * @param layer - 层级标签（managed / user-private / project / directory / local-private / path-rule）
   * @param depth - 当前递归深度（最大 5 层）
   * @param parents - 已加载的文件路径链（用于检测循环导入）
   * @param explicit - 是否为显式指定（显式指定的外部文件直接加载，无需审批）
   */
  function load(input:string,layer:string,depth=0,parents:string[]=[],explicit=false){
    if(++attempts>128)throw new Error('指令文件数量超过 128 次加载上限');
    if(depth>5)throw new Error('指令导入超过 5 层');
    // 解析路径并判断是否为项目外文件
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
    // 计算审批哈希：外部文件需要用户确认此哈希后才加载内容
    const approval=createHash('sha256').update(path+'\0'+content).digest('hex');
    // 外部未审批文件：记录为 blocked，不加载内容
    if(external&&!explicit&&!options.externalApprovals?.includes(approval)){files.push({...meta,path:rel,layer,bytes,lines,truncated:false,content:'',authority:'reference_only',approval,blocked:'项目外导入待用户确认；内容未加载'});return;}
    // 敏感内容检测：阻止包含密钥、密码等的文件
    if(sensitiveMemory(content))throw new Error('指令文件包含疑似敏感内容，已阻止加载');
    if((total+=bytes)>64000)throw new Error('分层指令总量超过 64000 字节');seen.add(path);
    // Imports precede the importing file, so the more specific file wins textual conflicts.
    // 解析 @import 指令，递归加载导入的文件
    for(const line of content.split(/\r?\n/)){const match=line.match(/^\s*@(?:"([^"]+)"|(\S+))\s*$/);if(match)load(resolve(dirname(path),match[1]??match[2]!),layer,depth+1,[...parents,path]);}
    files.push({...meta,path:external?path:relative(root,path).replaceAll('\\','/'),layer,bytes,lines,truncated:false,content,authority:'reference_only'});
  }
  // 第一步：加载显式指定的 managed 和 user-private 文件
  for(const [layer,file] of [['managed',options.managedFile],['user-private',options.userFile]])if(file)load(file,layer!,0,[],true);
  // 第二步：收集路径规则需要检查的目录层级
  const paths=(options.paths??[]).slice(0,50).map(p=>{projectPath(root,p);return p.replaceAll('\\','/');});
  const dirs=new Set(['']);for(const p of paths){let dir=statSync(projectPath(root,p)).isDirectory()?p:dirname(p);while(dir!=='.'){dirs.add(dir);const next=dirname(dir);if(next===dir)break;dir=next;}}
  // 第三步：按目录层级从浅到深扫描指令文件
  for(const dir of [...dirs].sort((a,b)=>a.split(/[\\/]/).length-b.split(/[\\/]/).length||a.localeCompare(b))){
    // 扫描标准指令文件名：AGENTS.md / CLAUDE.md / APIX.md 等
    for(const name of ['AGENTS.md','CLAUDE.md','APIX.md','APIX.local.md','CLAUDE.local.md']){const file=join(dir,name);if(existsSync(resolve(root,file)))load(file,name.includes('.local.')?'local-private':dir?'directory':'project');}
    // 扫描 .claude/rules 和 .apix/rules 目录下的规则文件（按 paths frontmatter 过滤）
    for(const base of ['.claude/rules','.apix/rules']){const directory=join(dir,base);if(!existsSync(resolve(root,directory)))continue;const safe=projectPath(root,directory);
      for(const name of readdirSync(safe).sort()){if(!name.endsWith('.md'))continue;const file=projectPath(root,join(directory,name));if(statSync(file).size>16000)throw new Error('规则文件超过 16000 字节');const header=readFileSync(file,'utf8').match(/^---\r?\n([\s\S]*?)\r?\n---/);
        // 解析 frontmatter 中的 paths 字段，判断规则是否适用于当前路径集合
        if(header){const rule=header[1]!.match(/paths:\s*(?:\[([^\]]+)\]|\r?\n((?:\s+-[^\n]+\n?)+))/);if(!rule)throw new Error('规则 frontmatter 需要 paths 列表');const patterns=(rule[1]??rule[2]!).split(/,|\r?\n/).map(s=>s.trim().replace(/^-\s*/, '').replace(/^['"]|['"]$/g,'')).filter(Boolean);if(!patterns.some(pattern=>paths.some(p=>glob(pattern,relative(dir||'.',p).replaceAll('\\','/')))))continue;}
        load(join(directory,name),'path-rule');
      }
    }
  }
  return files;
}
/**
 * glob - 简单的 glob 模式匹配（支持 * 和 ** 通配符）
 * @param pattern - glob 模式
 * @param path - 待匹配路径
 * @returns 是否匹配
 */
function glob(pattern:string,path:string){const escaped=pattern.replace(/[.+^${}()|[\]\\]/g,'\\$&').replace(/\*\*\//g,'\u0001').replace(/\*\*/g,'\u0002').replace(/\*/g,'[^/]*').replace(/\?/g,'[^/]').replace(/\u0001/g,'(?:.*/)?').replace(/\u0002/g,'.*');return new RegExp('^'+escaped+'$').test(path);}
