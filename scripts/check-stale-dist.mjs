// 检查 dist 里是否残留“源码已不存在”的过期编译产物(tsc 不会删除改名/删除源码后遗留的输出)。
// 对应关系:dist/web/X.js ↔ web/X.{ts,js};dist/src/**\/*.js ↔ src/**\/*.{ts,mjs}。
// dist 已被 gitignore,这道检查主要防本地脏构建混进发版(desktop:prepare 会原样打包 dist)。
import {existsSync,readdirSync,statSync,rmSync} from 'node:fs';
import {join,relative} from 'node:path';

const dist='dist';
if(!existsSync(dist)){process.exit(0);} // 尚未构建(tsc --noEmit / npm ci 后)时无产物可查,视为通过
const stale=[];
function walk(dir){
 for(const name of readdirSync(dir)){
  const path=join(dir,name);
  if(statSync(path).isDirectory()){walk(path);continue;}
  if(!/\.js(\.map)?$/.test(name))continue;
  const rel=relative(dist,path).replaceAll('\\','/'); // 形如 web/model-settings.js.map
  const base=rel.replace(/\.js(\.map)?$/,'');
  if(![base+'.ts',base+'.mjs',base+'.js'].some(p=>existsSync(p)))stale.push(rel);
 }
}
walk(dist);
if(stale.length){
 console.error(`dist 中存在无源码对应的过期产物(删除源码或改名后请清理 dist 再构建):\n  ${stale.join('\n  ')}`);
 console.error('提示:rm dist 后重新 npm run build 可全量重建。');
 process.exit(1);
}
console.log(`stale-dist 检查通过(${relative('.',dist)} 内无孤儿产物)。`);
