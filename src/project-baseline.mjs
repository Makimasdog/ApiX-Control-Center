import {createHash,randomUUID} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {existsSync,mkdirSync,realpathSync,readdirSync,lstatSync,readFileSync,writeFileSync,copyFileSync,renameSync,rmSync} from 'node:fs';
import {join,resolve,relative,isAbsolute} from 'node:path';

const git=(cwd,args,options={})=>execFileSync('git',args,{cwd,encoding:'utf8',timeout:20000,maxBuffer:10000000,windowsHide:true,stdio:['pipe','pipe','pipe'],...options}).replace(/\r?\n$/,'');
const excluded=name=>/^(?:\.git|node_modules|\.apix-agent-os)$/i.test(name) || /^\.env(?:\.|$)/i.test(name) || /^(?:id_rsa|id_ed25519)$|\.(?:pem|key|p12|pfx)$/i.test(name);
function inside(parent,path){const rel=relative(parent,path);return rel!=='' && !isAbsolute(rel) && rel!=='..' && !rel.startsWith('..\\') && !rel.startsWith('../');}
export function projectSourceVersion(sourcePath,dataDir){
  try{return git(sourcePath,['rev-parse','HEAD']);}catch{}
  const source=realpathSync.native(sourcePath),digest=createHash('sha256');let entries=0,bytes=0;
  function inspect(path){
    for(const name of readdirSync(path).sort()){
      if(excluded(name))continue;
      const input=join(path,name);if(dataDir && resolve(input)===resolve(dataDir))continue;
      if(++entries>20000)throw new Error('源目录过大，请重新安排计划');
      const stat=lstatSync(input);if(stat.isSymbolicLink())throw new Error('源目录包含链接，不能核对恢复版本');
      digest.update(JSON.stringify([relative(source,input),stat.size,stat.mtimeMs,stat.ctimeMs,stat.isDirectory()]));
      if(stat.isDirectory())inspect(input);
      else if(stat.isFile()){
        if((bytes+=stat.size)>100*1024*1024)throw new Error('源目录检查超过 100 MiB，请重新安排计划');
        digest.update(readFileSync(input));
      }else throw new Error('源目录包含不支持的文件类型');
    }
  }
  inspect(source);return 'directory:'+digest.digest('hex');
}
// A non-Git project gets a plan-scoped private baseline, never an implicit git init in the user's folder.
export function projectBaseline(sourcePath,planId,dataDir,{create=true}={}){
  const source=realpathSync.native(sourcePath);
  if(source===(existsSync(dataDir)?realpathSync.native(dataDir):resolve(dataDir)))throw new Error('ApiX 数据目录不能作为项目输入快照');
  const storage=resolve(dataDir,'project-baselines');
  const key=createHash('sha256').update(JSON.stringify([planId,source])).digest('hex');
  const saved=join(storage,key),repo=join(saved,'repo');
  if(existsSync(saved)){
    if(realpathSync.native(saved)!==join(realpathSync.native(storage),key) || realpathSync.native(repo)!==join(realpathSync.native(saved),'repo'))throw new Error('托管项目基线路径已变化');
    const manifest=JSON.parse(readFileSync(join(saved,'source.json'),'utf8'));
    if(manifest.source!==source || manifest.planId!==planId || git(repo,['rev-parse','HEAD'])!==manifest.head || realpathSync.native(git(repo,['rev-parse','--show-toplevel']))!==realpathSync.native(repo))throw new Error('托管项目基线已变化');
    return repo;
  }
  try{const root=git(source,['rev-parse','--show-toplevel']);git(root,['rev-parse','HEAD']);return realpathSync.native(root)===source ? resolve(sourcePath) : root;}catch{}
  if(!create)throw new Error('非 Git 项目尚未建立托管基线');
  mkdirSync(storage,{recursive:true});
  const staging=join(storage,key+'-'+randomUUID()),target=join(staging,'repo');
  mkdirSync(target,{recursive:true});
  try{
    git(target,['init']);
    let files=0,bytes=0,entries=0;
    function copy(from,to){
      const names=readdirSync(from);
      if(names.includes('.gitignore')){
        if(!lstatSync(join(from,'.gitignore')).isFile() || lstatSync(join(from,'.gitignore')).isSymbolicLink())throw new Error('项目忽略规则必须是普通文件');
        copyFileSync(join(from,'.gitignore'),join(to,'.gitignore'));
      }
      let ignored=[];
      if(names.length)try{ignored=git(target,['check-ignore','--no-index','-z','--stdin'],{input:names.map(n=>relative(source,join(from,n)).replaceAll('\\','/')+(lstatSync(join(from,n)).isDirectory()?'/':'')).join('\0')+'\0'}).split('\0').map(p=>p.replace(/\/$/,''));}catch(error){if(error.status!==1)throw error;}
      for(const name of names){
        if(excluded(name))continue;
        const input=join(from,name),output=join(to,name);
        if(resolve(input)===resolve(dataDir) || resolve(input)===storage || ignored.includes(relative(source,input).replaceAll('\\','/')))continue;
        if(++entries>20000)throw new Error('项目目录条目过多，请配置忽略目录或使用 Git 项目');
        const stat=lstatSync(input);
        if(stat.isSymbolicLink())throw new Error(`项目包含链接，请先明确独立工作区的输入范围：${relative(source,input)}`);
        if(stat.isDirectory()){mkdirSync(output,{recursive:true});copy(input,output);}
        else if(stat.isFile()){
          if(++files>10000 || (bytes+=stat.size)>100*1024*1024)throw new Error('非 Git 项目快照超过 10000 个文件或 100 MiB，请配置忽略目录或使用 Git 项目');
          copyFileSync(input,output);
        }else throw new Error('项目包含不支持的文件类型');
      }
    }
    copy(source,target);
    const paths=git(target,['ls-files','--others','--exclude-standard','-z']).split('\0').filter(Boolean);
    if(paths.length)git(target,['add','--pathspec-from-file=-','--pathspec-file-nul'],{input:paths.join('\0')+'\0'});
    const tree=git(target,['write-tree']);
    const head=git(target,['-c','user.name=ApiX','-c','user.email=apix@local.invalid','commit-tree',tree,'-m','ApiX project input snapshot']);
    git(target,['update-ref','HEAD',head]);
    writeFileSync(join(staging,'source.json'),JSON.stringify({source,planId,head}));
    renameSync(staging,saved);
    return repo;
  }catch(error){
    if(inside(realpathSync.native(storage),realpathSync.native(staging)))rmSync(staging,{recursive:true,force:true});
    throw new Error(`无法建立非 Git 项目基线：${error.message}`);
  }
}
