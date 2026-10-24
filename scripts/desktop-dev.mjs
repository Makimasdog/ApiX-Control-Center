import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {join} from 'node:path';
const root=fileURLToPath(new URL('../',import.meta.url));
const major=Number(process.versions.node.split('.')[0]),minor=Number(process.versions.node.split('.')[1]);
if(process.platform!=='win32'||!(major===22&&minor>=19||major===24&&minor>=22))throw Error('Electron 开发模式需要 Windows 与 Node 22.19–22.x 或 24.22+（24.x）。');
async function run(executable,args,env=process.env){return new Promise((resolve,reject)=>{
  const child=spawn(executable,args,{cwd:root,env,windowsHide:executable===process.execPath,stdio:'inherit'});
  child.once('error',reject);child.once('close',code=>code===0?resolve():reject(Error('开发进程退出：'+code)));
  const stop=()=>child.kill();process.once('SIGINT',stop);process.once('SIGTERM',stop);
  child.once('close',()=>{process.removeListener('SIGINT',stop);process.removeListener('SIGTERM',stop);});
});}
await run(process.execPath,[join(root,'node_modules/typescript/bin/tsc'),'--noEmitOnError']);
const env={...process.env,APIX_DEV_ROOT:root,APIX_DEV_NODE:process.execPath};delete env.ELECTRON_RUN_AS_NODE;
await run(join(root,'node_modules/electron/dist/electron.exe'),[join(root,'desktop/main.cjs')],env);
