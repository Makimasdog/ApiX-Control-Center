const {watch}=require('node:fs');
const {join}=require('node:path');
const {spawn}=require('node:child_process');

function compile(root,node,log){return new Promise((resolve,reject)=>{
  const child=spawn(node,[join(root,'node_modules/typescript/bin/tsc'),'--noEmitOnError'],{cwd:root,windowsHide:true,stdio:['ignore','pipe','pipe']});
  child.stdout.on('data',c=>log.write(c));child.stderr.on('data',c=>log.write(c));
  child.once('error',reject);child.once('close',code=>code===0?resolve():reject(Error('TypeScript 编译失败，保留当前运行版本')));
});}
function startDevelopment({root,node,log,restart,reload,build=()=>compile(root,node,log)}){
  let closed=false,timer,running=null;const changes=new Set(),watchers=[];
  function changed(path){if(closed||!(/\.(?:ts|mjs|js|cjs|css|html|json|ps1|cs)$/.test(path)))return;changes.add(path);clearTimeout(timer);timer=setTimeout(flush,350);}
  function flush(){if(closed||running||!changes.size)return;const batch=[...changes];changes.clear();
    running=(async()=>{try{
      if(batch.some(p=>p.endsWith('.ts')||p==='tsconfig.json'))await build();
      if(closed)return;
      if(batch.some(p=>p.startsWith('src/')||['server.mjs','control-plane.mjs','agent-discovery.mjs','tsconfig.json'].includes(p)))await restart();
      else await reload();
      log.write('[dev] '+(batch.some(p=>p.startsWith('src/')||!p.startsWith('web/'))?'后端已重启':'前端已刷新')+'\n');
    }catch(e){log.write('[dev] '+e.message+'\n');}finally{running=null;if(changes.size&&!closed){clearTimeout(timer);timer=setTimeout(flush,350);}}})();
  }
  for(const dir of ['src','web'])watchers.push(watch(join(root,dir),{recursive:true},(_event,file)=>{if(file)changed(dir+'/'+String(file).replaceAll('\\','/'));}));
  const rootFiles=new Set(['server.mjs','control-plane.mjs','agent-discovery.mjs','tsconfig.json']);
  watchers.push(watch(root,(_event,file)=>{if(file&&rootFiles.has(String(file)))changed(String(file));}));
  for(const watcher of watchers)watcher.on('error',e=>log.write('[dev] 文件监听失败：'+e.message+'\n'));
  log.write('[dev] 监听仓库前后端；修改 Electron 主进程需重新运行 desktop:dev。\n');
  return {stop:async()=>{closed=true;clearTimeout(timer);for(const w of watchers)w.close();await running;}};
}
module.exports={startDevelopment};
