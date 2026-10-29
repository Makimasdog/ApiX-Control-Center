/**
 * Node 项目校验 - 验证 Node.js 项目的结构、依赖和运行环境是否符合 ApiX 托管执行要求
 *
 * 所属层级：校验层
 * 核心功能：
 *   - npmRuntime：定位并验证宿主 npm CLI 入口（固定版本要求）
 *   - sourceManifest：生成项目源码清单（文件路径、大小、SHA256），用于完整性校验
 *   - inspectNpmProject：深度检查 package.json / lockfile 是否符合安全策略
 *   - npmProfile：生成完整的 npm 执行配置（安装参数、脚本序列、受信路径）
 *   - diagnoseNodeProject：输出项目诊断报告（状态、阻塞项、运行时信息）
 *   - treeEvidence：扫描依赖/产物目录的证据清单
 * 依赖关系：
 *   - 依赖 → [→ 见 src/execution/command-capabilities.ts] 命令托管能力检查
 *   - 依赖 → [→ 见 src/assistant/assistant-tools.ts] projectPath 路径安全工具
 *   - 依赖 → [→ 见 src/infrastructure/project-scan.ts] 扫描限制配置
 *   - 被 ← [→ 见 src/projects/project-io-worker.mjs] 通过 IO 线程池调用
 *   - 被 ← [→ 见 src/validation/npm-workspace.ts] 工作区准备依赖
 */
import {createHash} from 'node:crypto';
import {existsSync,lstatSync,readFileSync,realpathSync,openSync,readSync,closeSync,opendirSync} from 'node:fs';
import {join,dirname,relative,resolve,isAbsolute,delimiter} from 'node:path';
import {spawnSync} from 'node:child_process';
import {commandCapabilities} from '../execution/command-capabilities.js';
import {projectPath} from '../assistant/assistant-tools.js';
import {projectScanLimits} from '../infrastructure/project-scan.js';

/** 项目扫描的各项容量限制 */
export const nodeProjectLimits={sourceFiles:projectScanLimits.items,sourceBytes:projectScanLimits.bytes,dependencyFiles:40000,dependencyBytes:256*1024*1024,artifactFiles:6000,artifactBytes:32*1024*1024};
/** digest - 计算字符串或 Buffer 的 SHA256 哈希 */
export const digest=(v:string|Buffer)=>createHash('sha256').update(v).digest('hex');
/** credentialName - 判断文件名是否为敏感凭据文件（.npmrc、密钥、.env 等） */
export const credentialName=(n:string)=>['.npmrc','model-credentials.json','owner-access.json'].includes(n.toLowerCase())||/^\.env(?:\.|$)|^id_(rsa|ed25519)$|\.(pem|key|pfx|p12)$/i.test(n);
/**
 * boundedNames - 列出目录下的文件名，受数量上限保护
 * @param path - 目录路径
 * @param limit - 最大条目数
 * @returns 排序后的文件名数组
 */
export function boundedNames(path:string,limit:number){const dir=opendirSync(path),names:string[]=[];try{let entry;while((entry=dir.readSync())){if(names.length>=limit)throw new Error('目录扫描超过项目文件预算，扫描未完成');names.push(entry.name);}}finally{dir.closeSync();}return names.sort();}
/** NPM 执行配置：包含安装参数、脚本序列、运行时信息等 */
export interface NpmProfile {schemaVersion:1;artifacts:string[];trustedPaths:string[];installArgs:string[];scripts:{id:string;sequence:string[];commands:{name:string;command:string;npmArgs:string[]}[]}[];network:boolean;runtime:ReturnType<typeof npmRuntime>;installPolicy:'ci-ignore-scripts-v1';environmentPolicy:'minimal-v1'}
// No project code, npm configuration or user startup file is evaluated during discovery.
/**
 * npmRuntime - 定位并验证宿主 npm CLI 入口
 *
 * 在 Node.js 安装目录和 PATH 中查找固定的 npm-cli.js 入口，验证 Node 和 npm 版本兼容性。
 * @returns 运行时信息对象（node 路径、npm 路径、版本号、SHA256）
 */
export function npmRuntime(){
 // 从 Node.js 安装目录和 PATH 环境变量中查找 npm-cli.js
 const candidates=[join(dirname(process.execPath),'node_modules/npm/bin/npm-cli.js'),...(process.env.PATH??'').split(delimiter).filter(p=>isAbsolute(p)).map(p=>join(p,'node_modules/npm/bin/npm-cli.js'))];
 const cli=candidates.find(p=>existsSync(p));if(!cli)throw new Error('未发现固定 npm CLI 入口');
 const path=realpathSync.native(cli),pkg=JSON.parse(readFileSync(join(dirname(path),'../package.json'),'utf8'));
 // 验证 Node.js 版本（22.19+ 或 24.22+）和 npm 版本（10.x 或 11.x）
 const [major,minor]=process.versions.node.split('.').map(Number);if(!(major===22&&minor!>=19||major===24&&minor!>=22)||!/^1[01]\./.test(pkg.version))throw new Error('支持 Node 22.19–22.x / 24.22+ 和 npm 10.x / 11.x');
 return {node:realpathSync.native(process.execPath),nodeVersion:process.version,npm:path,npmVersion:String(pkg.version),npmSha256:digest(readFileSync(path))};
}
/**
 * projectGitStatus - 检查项目的 Git 状态（使用项目外的宿主 Git）
 * @param root - 项目根目录
 * @returns Git 状态信息（是否被跟踪、是否完成扫描、变更文件数等）
 */
function projectGitStatus(root:string){
 // 查找项目目录之外的宿主 Git 可执行文件（确保不是项目自带的 git）
 const hostGit=(process.env.PATH??'').split(delimiter).filter(isAbsolute).map(path=>join(path,process.platform==='win32'?'git.exe':'git')).filter(existsSync).map(path=>realpathSync.native(path)).find(path=>{const rel=relative(root,path);return rel==='..'||rel.startsWith('..'+(process.platform==='win32'?'\\':'/'))||isAbsolute(rel);});
 if(!hostGit)return {tracked:null,complete:false,reason:'未发现项目外的宿主 Git 入口',changedTrackedPaths:null};
 // 使用严格的环境变量隔离，避免项目配置干扰 Git 行为
 const env:NodeJS.ProcessEnv={GIT_CONFIG_GLOBAL:process.platform==='win32'?'NUL':'/dev/null',GIT_CONFIG_NOSYSTEM:'1',GIT_OPTIONAL_LOCKS:'0',LC_ALL:'C'};for(const key of ['SystemRoot','WINDIR'])if(process.env[key])env[key]=process.env[key];
 const git=spawnSync(hostGit,['--no-optional-locks','-c','core.fsmonitor=false','status','--porcelain=v1','--ignore-submodules=all','--no-renames'],{cwd:root,env,encoding:'utf8',timeout:3000,maxBuffer:65536,windowsHide:true});
 const notGit=!git.error&&git.status!==0&&/not a git repository/i.test(git.stderr??'');return {executable:hostGit,tracked:git.status===0?true:notGit?false:null,complete:!git.error&&(git.status===0||notGit),changedTrackedPaths:git.status===0?git.stdout.split(/\r?\n/).filter(Boolean).length:null};
}
/**
 * boundedJson - 安全读取 JSON 文件（限制大小、禁止符号链接）
 * @param path - 文件路径
 * @returns 解析后的 JSON 对象
 */
export function boundedJson(path:string){const stat=lstatSync(path);if(!stat.isFile()||stat.isSymbolicLink()||stat.size>1024*1024)throw new Error('项目 JSON 超出 1 MiB 或包含链接');return JSON.parse(readFileSync(path,'utf8'));}
/**
 * sourceManifest - 生成项目源码清单（排除 .git / node_modules / 凭据 / 产物目录）
 * @param root - 项目根目录
 * @param artifacts - 产物目录列表（如 ['dist', 'coverage']），这些目录不纳入清单
 * @param mutable - 可变文件列表（不计算哈希，只记录路径）
 * @returns 文件清单和总体哈希
 */
export function sourceManifest(root:string,artifacts:string[]=[],mutable:string[]=[]){
 root=realpathSync.native(root);const files:{path:string;sha256:string;size:number}[]=[];let items=0,bytes=0;
 // Windows 上路径比较忽略大小写
 const key=(p:string)=>process.platform==='win32'?p.toLowerCase():p;
 const contains=(paths:string[],p:string)=>paths.some(a=>key(p)===key(a)||key(p).startsWith(key(a)+'/'));
 function visit(dir:string){for(const name of boundedNames(dir,nodeProjectLimits.sourceFiles-items)){
  const path=join(dir,name),rel=relative(root,path).replaceAll('\\','/');
  if(name==='.git'||name==='node_modules'||credentialName(name)||contains(artifacts,rel))continue;
  if(++items>nodeProjectLimits.sourceFiles)throw new Error('源码扫描超过 20000 项，扫描未完成');
  const stat=lstatSync(path);if(stat.isSymbolicLink())throw new Error('源码范围包含链接，不支持');
  if(stat.isDirectory()){visit(path);continue;}if(!stat.isFile())throw new Error('不支持的源码文件类型');
  if((bytes+=stat.size)>nodeProjectLimits.sourceBytes)throw new Error('源码扫描超过 256 MiB，扫描未完成');
  // 可变文件只记录路径不计算哈希
  if(!contains(mutable,rel))files.push({path:rel,size:stat.size,sha256:hashFile(path,stat.size)});
 }}visit(root);return {files,items,bytes,hash:digest(JSON.stringify(files))};
}
/**
 * hashFile - 计算文件的 SHA256 哈希，受大小预算保护
 * @param path - 文件路径
 * @param limit - 最大读取字节数
 * @returns 十六进制哈希字符串
 */
export function hashFile(path:string,limit:number){const fd=openSync(path,'r'),hash=createHash('sha256');let size=0;try{const buffer=Buffer.alloc(65536);let n;while((n=readSync(fd,buffer,0,buffer.length,null))){if((size+=n)>limit)throw new Error('扫描期间文件超出预算');hash.update(buffer.subarray(0,n));}}finally{closeSync(fd);}return hash.digest('hex');}
/**
 * treeEvidence - 扫描目录生成证据清单（依赖/产物目录）
 * @param root - 扫描根目录
 * @param filesLimit - 文件数量上限
 * @param bytesLimit - 总字节数上限
 * @param live - 是否为实时扫描（实时模式不计算哈希）
 * @returns 证据清单（文件数、总字节、哈希、文件列表）
 */
export function treeEvidence(root:string,filesLimit:number,bytesLimit:number,live=false){let items=0,bytes=0;const files:{path:string;size:number;sha256:string}[]=[];
 function visit(dir:string){for(const name of boundedNames(dir,filesLimit-items)){try{const path=join(dir,name),s=lstatSync(path);if(++items>filesLimit)throw new Error('依赖/产物扫描超过文件预算');if(s.isSymbolicLink()){ // npm .bin links are local read-only evidence, never followed.
   // 符号链接只记录目标路径，不跟随（防止越界）
   const rel=relative(root,realpathSync.native(path));if(rel==='..'||rel.startsWith('..'+(process.platform==='win32'?'\\':'/'))||isAbsolute(rel))throw new Error('依赖链接越界');files.push({path:relative(root,path),size:0,sha256:digest('link:'+rel)});
  }else if(s.isDirectory())visit(path);else if(s.isFile()){if((bytes+=s.size)>bytesLimit)throw new Error('依赖/产物扫描超过容量预算');files.push({path:relative(root,path),size:s.size,sha256:live?'':hashFile(path,s.size)});}else throw new Error('依赖/产物文件类型不支持');}catch(e){if(!live||(e as NodeJS.ErrnoException).code!=='ENOENT')throw e;}}}
 if(existsSync(root)){const stat=lstatSync(root);if(stat.isSymbolicLink()||!stat.isDirectory())throw new Error('依赖/产物根必须为普通目录，不能为链接');visit(root);}return {items,bytes,hash:digest(JSON.stringify(files)),files};
}
/**
 * inspectNpmProject - 深度检查项目是否符合 ApiX 托管执行的安全策略
 *
 * 检查项包括：不支持 workspaces / 其他包管理器 / 安装钩子 / 外部依赖 / 原生扩展等。
 * @param root - 项目根目录
 * @returns 检查结果（包名、脚本序列、受信路径、是否需要网络等）
 */
export function inspectNpmProject(root:string){
 root=realpathSync.native(root);const p=boundedJson(join(root,'package.json')),lock=boundedJson(join(root,'package-lock.json')),scripts=p.scripts??{};
 // 拒绝 workspaces、其他包管理器、依赖覆盖、项目 npm 配置或原生扩展
 if(p.workspaces||p.overrides||p.resolutions||p.packageManager&&!/^npm@10\./.test(p.packageManager)||['pnpm-lock.yaml','yarn.lock','npm-shrinkwrap.json','.npmrc','.yarnrc.yml','binding.gyp'].some(n=>existsSync(join(root,n))))throw new Error('不支持 workspaces、其他包管理器、依赖覆盖、项目 npm 配置或原生扩展；需独立核对');
 // 要求 lockfileVersion 3 且包名/版本与 package.json 一致
 if(lock.lockfileVersion!==3||!lock.packages?.['']||p.name!==lock.name||p.version!==lock.version)throw new Error('需要匹配的 npm lockfileVersion 3');
 // 校验 package.json 与 lockfile 的依赖声明一致
 for(const field of ['dependencies','devDependencies','optionalDependencies','peerDependencies'])if(JSON.stringify(Object.entries(p[field]??{}).sort())!==JSON.stringify(Object.entries(lock.packages[''][field]??{}).sort()))throw new Error('package/lockfile 依赖不匹配');
 // 拒绝安装生命周期脚本（安全策略）
 if(['preinstall','install','postinstall','prepare','prepublish'].some(n=>scripts[n]))throw new Error('首版不支持安装生命周期脚本；不会自动开启');
 const entries=Object.entries(lock.packages) as [string,any][];if(entries.length>10000)throw new Error('依赖计划超过 10000 包预算');let requiresNetwork=false;
 // 校验每个依赖的版本规格：只允许明确的 semver 或 vendor tgz
 for(const [,value] of entries)for(const field of ['dependencies','devDependencies','optionalDependencies','peerDependencies'])for(const spec of Object.values(value[field]??{}))if(typeof spec!=='string'||!(/^[~^]?\d+\.\d+\.\d+(?:-[a-zA-Z0-9.-]+)?$/.test(spec)||/^file:vendor\/[a-zA-Z0-9_.-]+\.tgz$/.test(spec)))throw new Error('首版仅支持明确 semver 版本或范围及 vendor tgz，不支持外部/动态依赖规格');
 // 校验每个依赖包的来源：禁止 workspace/link/安装脚本，只允许 npm 公共 registry 或 vendor tgz
 for(const [path,value] of entries){if(!path)continue;if(!/^node_modules\//.test(path)||path.split('/').includes('..')||value.link||value.hasInstallScript)throw new Error('不支持 workspace/link 或依赖安装脚本/原生扩展');
  if(typeof value.resolved!=='string'||typeof value.integrity!=='string'||!value.integrity.startsWith('sha512-'))throw new Error('依赖缺少固定来源或 SHA512 完整性');
  if(value.resolved.startsWith('file:')){const rel=value.resolved.slice(5);if(!/^vendor\/[a-zA-Z0-9_.-]+\.tgz$/.test(rel)||!existsSync(join(root,rel))||lstatSync(join(root,rel)).isSymbolicLink())throw new Error('仅支持项目 vendor 内已批准的 tgz 本地来源');}
  else{const url=new URL(value.resolved);if(url.protocol!=='https:'||url.hostname!=='registry.npmjs.org'||url.username||url.password||url.search||url.hash)throw new Error('不支持外部依赖来源；仅允许 npm 公共 registry');requiresNetwork=true;}
 }
 // 校验 scripts 字段的名称和内容
 for(const [name,value] of Object.entries(scripts))if(!/^[a-zA-Z0-9:_-]{1,60}$/.test(name)||typeof value!=='string'||value.length>2000)throw new Error('脚本名称或内容不受支持');
 // 识别检查脚本（typecheck / build / test），构建执行序列
 const checks=['typecheck','build','test'].filter(n=>scripts[n]).map(id=>({id,sequence:['pre'+id,id,'post'+id].filter(n=>scripts[n])}));if(!checks.length)throw new Error('缺少 test/build/typecheck 检查脚本');
 // 收集受信路径：检查脚本引用的项目内文件和测试/配置文件
 const trustedPaths=new Set<string>();
 for(const check of checks)for(const name of check.sequence){
  const command=String(scripts[name]).trim();if(!/^[a-zA-Z0-9_./=:@, -]+$/.test(command))throw new Error('检查脚本仅支持直接 node 项目脚本或 tsc；复合 shell、引号或动态入口不支持');
  const [executable,...args]=command.split(/\s+/);if(!['node','tsc'].includes(executable!))throw new Error('检查脚本仅支持直接 node 项目脚本或 tsc');
  if(executable==='node'&&(args[0]?.startsWith('-')&&!args[0]?.startsWith('--test')||!args.length))throw new Error('node 检查入口必须为固定项目文件或 --test');
  if(executable==='node'&&args.some(a=>a.startsWith('-')&&!/^--test(?:-[a-z-]+)?(?:=[a-zA-Z0-9_-]+)?$/.test(a)))throw new Error('node 检查不支持动态 loader、eval 或环境参数');
  // 校验参数不越界，并将引用的文件加入受信路径
  for(const arg of args.filter(a=>!a.startsWith('-'))){if(arg.startsWith('/')||arg.includes(':')||arg.split('/').includes('..'))throw new Error('检查输入不能越过项目路径');if(/\.[cm]?[jt]sx?$|\.json$|\//.test(arg)||existsSync(join(root,arg))){const path=projectPath(root,arg);trustedPaths.add(relative(root,path).replaceAll('\\','/'));}}
  if(executable==='node'&&!args[0]?.startsWith('--test')&&!/\.[cm]?js$/.test(args[0]??''))throw new Error('node 检查需要明确的 js/cjs/mjs 文件');
  if(args.some(a=>/^--(?:require|import|eval|loader|config|project)=/.test(a)))throw new Error('请将检查配置路径作为独立参数，不能使用隐藏配置入口');
 }
 // 自动将测试文件和配置文件加入受信路径
 for(const file of sourceManifest(root,['dist','coverage']).files)if(/(?:^|\/)(?:test|tests|__tests__|scripts)\/|(?:^|\/)(?:.*[.-])?(?:test|spec)\.[cm]?[jt]sx?$|(?:^|\/)(?:tsconfig[^/]*\.json|[^/]+\.config\.[cm]?[jt]s)$/.test(file.path))trustedPaths.add(file.path);
 return {packageName:p.name,lockfile:'package-lock.json',scripts:checks.map(c=>({...c,commands:c.sequence.map(n=>({name:n,command:scripts[n]}))})),trustedPaths:[...trustedPaths].sort(),requiresNetwork,dependencyPackages:entries.length-1};
}
/**
 * npmProfile - 生成完整的 npm 执行配置
 * @param root - 项目根目录
 * @param input - 用户输入（需包含 network 布尔值授权网络下载）
 * @returns NpmProfile 对象
 */
export function npmProfile(root:string,input:Record<string,unknown>):NpmProfile {
 const info=inspectNpmProject(root),runtime=npmRuntime();const runtimeRel=relative(realpathSync.native(root),runtime.npm);if(runtimeRel!== '..'&&!runtimeRel.startsWith('..'+(process.platform==='win32'?'\\':'/'))&&!isAbsolute(runtimeRel))throw new Error('npm 入口位于项目内，必须使用宿主入口');if(!commandCapabilities().managedCommands.available)throw new Error('当前平台无法托管命令');
 // 检查产物目录（dist / coverage）是否为空，不复用旧产物
 const artifacts=['dist','coverage'];for(const path of artifacts)if(existsSync(join(root,path))&&(lstatSync(join(root,path)).isSymbolicLink()||!lstatSync(join(root,path)).isDirectory()||boundedNames(join(root,path),nodeProjectLimits.artifactFiles).length))throw new Error('候选产物目录已有用户内容，请先核对并移出；不复用旧产物');
 if(typeof input.network!=='boolean')throw new Error('必须明确网络下载授权');if(info.requiresNetwork&&!input.network)throw new Error('需要网络下载批准；当前仅生成方案，未安装');
 // 生成安装参数：ci 模式、忽略脚本、固定 registry
 return {schemaVersion:1,artifacts,trustedPaths:info.trustedPaths,installArgs:['ci','--ignore-scripts','--no-audit','--no-fund','--engine-strict','--include=dev','--include=optional','--registry=https://registry.npmjs.org',...(!input.network?['--offline']:[])],scripts:[{id:'npm-project',sequence:info.scripts.flatMap(c=>c.sequence),commands:info.scripts.flatMap(c=>c.commands).map(c=>({...c,npmArgs:['run','--ignore-scripts',c.name]}))}],network:input.network,runtime,installPolicy:'ci-ignore-scripts-v1',environmentPolicy:'minimal-v1'};
}
/**
 * diagnoseNodeProject - 输出项目诊断报告
 * @param root - 项目根目录
 * @returns 诊断报告（状态、阻塞项、运行时信息、源码清单、依赖状态等）
 */
export function diagnoseNodeProject(root:string){
 const identity=realpathSync.native(root),report:any={schemaVersion:1,root:identity,identity:digest(process.platform==='win32'?identity.toLowerCase():identity),platform:process.platform,capabilities:commandCapabilities(),status:'needs_review',scanComplete:false,blocks:[],artifacts:['dist','coverage'],limits:nodeProjectLimits};
 // 逐步尝试收集运行时、项目配置、源码清单等信息，任何失败都记录到 blocks
 try{report.runtime=npmRuntime();report.project=inspectNpmProject(identity);report.source=sourceManifest(identity,['dist','coverage']);report.scanComplete=true;report.dependencies=existsSync(join(identity,'node_modules'))?'existing_not_trusted':'not_prepared';report.artifactCandidates=['dist','coverage'].map(path=>({path,...treeEvidence(join(identity,path),nodeProjectLimits.artifactFiles,nodeProjectLimits.artifactBytes)}));report.status='needs_approval';if(!report.capabilities.managedCommands.available)throw new Error('当前平台无法托管命令');if(report.artifactCandidates.some((a:any)=>a.items))throw new Error('候选产物目录已有内容，等待用户核对；不会复制旧产物');}catch(e){report.blocks.push(e instanceof Error?e.message:'诊断失败');report.status=/扫描|预算/.test(report.blocks[0])?'scan_incomplete':/已有内容/.test(report.blocks[0])?'needs_review':/ENOENT|不匹配|缺少|需要匹配/.test(report.blocks[0])?'configuration_incomplete':'unsupported';}
 report.git=projectGitStatus(identity);
 return report;
}
