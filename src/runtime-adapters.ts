import { existsSync, readFileSync, statSync } from 'node:fs';
import { dirname, extname, isAbsolute, join, resolve, sep } from 'node:path';
import type { Store, AgentCapabilities } from './contracts.js';
import { object, text } from './contracts.js';

export interface Command { executable: string; prefix: string[] }
interface CustomAdapter { id: string; name: string; executable: string; args_json: string; format: 'plain' | 'jsonl'; mailbox: number }
const builtins = [
  {id:'pi',name:'Pi 员工',stateSource:'Pi RPC'},
  {id:'codex',name:'Codex CLI',stateSource:'Codex JSONL'},
  {id:'claude',name:'Claude Code',stateSource:'Claude stream-json'},
  {id:'gemini',name:'Gemini CLI',stateSource:'Gemini stream-json'},
  {id:'opencode',name:'OpenCode',stateSource:'OpenCode JSON'},
  {id:'kimi',name:'Kimi Code',stateSource:'Kimi stream-json'},
];
const npmPackages: Record<string,string[]> = {pi:['@earendil-works/pi-coding-agent','@mariozechner/pi-coding-agent'],codex:['@openai/codex'],claude:['@anthropic-ai/claude-code'],gemini:['@google/gemini-cli'],opencode:['opencode-ai']};

function executableCommand(path: string): Command {
  return /\.[cm]?js$/i.test(path) ? {executable:process.execPath,prefix:[path]} : {executable:path,prefix:[]};
}

function entryCommand(path: string): Command | null {
  try { return isAbsolute(path) && !/\.(cmd|bat|ps1)$/i.test(path) && statSync(path).isFile() ? executableCommand(path) : null; }
  catch { return null; }
}

function npmShimCommand(id: string, shim: string): Command | null {
  for (const packageName of npmPackages[id] ?? []) {
    const packageDir = join(dirname(shim),'node_modules',packageName);
    try {
      const manifest = JSON.parse(readFileSync(join(packageDir,'package.json'),'utf8')) as {bin?:string|Record<string,string>};
      const bin = typeof manifest.bin === 'string' ? manifest.bin : manifest.bin?.[id];
      if (!bin || isAbsolute(bin)) continue;
      const entry = resolve(packageDir,bin);
      if (!entry.startsWith(resolve(packageDir) + sep) || !['.exe','.js','.mjs','.cjs'].includes(extname(entry).toLowerCase())) continue;
      const command=entryCommand(entry);if(command)return command;
    } catch { /* Try the other official package name. */ }
  }
  return null;
}
export function createRuntimeAdapters(store: Store, findExecutable: (name: string) => string | null) {
  const { db, row, rows } = store;
  db.exec('CREATE TABLE IF NOT EXISTS apix_adapters(id TEXT PRIMARY KEY,name TEXT NOT NULL,executable TEXT NOT NULL,args_json TEXT NOT NULL,format TEXT NOT NULL)');
  if(!rows<{name:string}>('PRAGMA table_info(apix_adapters)').some(c=>c.name==='mailbox')) db.exec('ALTER TABLE apix_adapters ADD COLUMN mailbox INTEGER NOT NULL DEFAULT 0');
  function command(id: string): Command | null {
    const env = process.env[`APIX_${id.toUpperCase()}_ENTRY`];
    if (env) return entryCommand(env);
    const custom = row<CustomAdapter>('SELECT * FROM apix_adapters WHERE id=?',id);
    if (custom) return existsSync(custom.executable) ? { executable: custom.executable, prefix: JSON.parse(custom.args_json) as string[] } : null;
    const name = id === 'claude' ? 'claude' : id;
    const found = findExecutable(name);
    if (!found) return null;
    if (process.platform === 'win32' && /\.cmd$/i.test(found)) return npmShimCommand(id,found);
    return {executable:found,prefix:[]};
  }
  function catalog(): AgentCapabilities[] {
    return [...builtins,
      ...rows<CustomAdapter>('SELECT * FROM apix_adapters').map(c=>({id:c.id,name:c.name,stateSource:`自定义适配器 · ${c.format}`,mailbox:c.mailbox===1}))]
      .map(c=>({...c,mailbox:'mailbox' in c && c.mailbox===true,available:!!command(c.id),managed:true,observable:true,cancellable:true,resumable:false}));
  }
  function register(input: unknown) {
    const v = object(input); const id = text(v.id,50); const name = text(v.name,100); const executable = text(v.executable,1000);
    if (!/^[a-z][a-z0-9-]*$/.test(id) || builtins.some(b=>b.id===id)) throw new Error('适配器 ID 无效或属于内置运行时');
    if (!isAbsolute(executable) || !existsSync(executable) || /\.(cmd|bat|ps1)$/i.test(executable)) throw new Error('请选择已存在的可执行文件；脚本请通过 node.exe 等解释器和参数启动');
    if (!Array.isArray(v.args) || v.args.some(a=>typeof a!=='string') || v.args.length>30) throw new Error('参数必须为字符串数组');
    if (!['plain','jsonl'].includes(String(v.format))) throw new Error('输出格式应为 plain 或 jsonl');
    if(v.mailbox!==undefined && typeof v.mailbox!=='boolean') throw new Error('mailbox 支持声明必须为布尔值');
    if (row("SELECT id FROM tasks WHERE runtime=? AND status IN ('awaiting_approval','queued','running','stopping','unknown') LIMIT 1", id)) throw new Error('适配器有待处理任务，不能更换执行命令');
    db.prepare('INSERT INTO apix_adapters VALUES (?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET name=excluded.name,executable=excluded.executable,args_json=excluded.args_json,format=excluded.format,mailbox=excluded.mailbox').run(id,name,executable,JSON.stringify(v.args),String(v.format),v.mailbox===true?1:0);
    return catalog().find(c=>c.id===id);
  }
  function args(id: string, fullAccess: boolean, skipGit: boolean): string[] {
    if (id === 'pi') return ['--mode','rpc','--no-session','--no-extensions'];
    if (id === 'codex') return ['exec','--json','--ephemeral',...(fullAccess ? ['--dangerously-bypass-approvals-and-sandbox'] : ['--sandbox','workspace-write']),...(skipGit ? ['--skip-git-repo-check'] : []),'-'];
    if (id === 'claude') return ['-p','--output-format','stream-json','--verbose',...(fullAccess ? ['--dangerously-skip-permissions'] : ['--permission-mode','dontAsk','--allowedTools','Read,Glob,Grep,Edit,Write,Bash'])];
    if (id === 'gemini') return ['--output-format','stream-json',...(fullAccess ? ['--yolo'] : ['--approval-mode','auto_edit'])];
    if (id === 'opencode') return ['run','--format','json'];
    if (id === 'kimi') return ['--print','--output-format=stream-json'];
    return [];
  }
  function format(id: string) { return row<CustomAdapter>('SELECT * FROM apix_adapters WHERE id=?',id)?.format ?? 'jsonl'; }
  function supportsModel(id:string){return ['pi','codex','claude'].includes(id);}
  function modelArgs(id:string,model:string){if(!model)return [];if(!supportsModel(id))throw new Error('当前适配器尚未验证显式模型选择，不能依据声明费率自动路由');return ['--model',model];}
  return { command, catalog, register, args, modelArgs,supportsModel,format };
}
