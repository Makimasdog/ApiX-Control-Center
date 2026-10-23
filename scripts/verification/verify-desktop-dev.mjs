import assert from 'node:assert/strict';
import {mkdtemp,writeFile,readFile,unlink} from 'node:fs/promises';
import {resolve,join,isAbsolute} from 'node:path';
import {pathToFileURL} from 'node:url';
import {setTimeout as delay} from 'node:timers/promises';
const moduleName=process.env.APIX_PLAYWRIGHT_MODULE??'playwright';
const {_electron}=await import(isAbsolute(moduleName)?pathToFileURL(moduleName).href:moduleName);
const root=resolve('.'),data=await mkdtemp(resolve('.tmp-dev-electron-'));
const env={...process.env,APIX_DEV_ROOT:root,APIX_DEV_NODE:process.execPath,APIX_DESKTOP_DATA_DIR:data};delete env.ELECTRON_RUN_AS_NODE;
const frontend=join(root,'web','.tmp-dev-verify-'+process.pid+'.css'),typed=join(root,'web','dev-verify-'+process.pid+'.ts'),backend=join(root,'src','.tmp-dev-verify-'+process.pid+'.mjs');
let app;
async function until(check){for(let i=0;i<150;i++){try{if(await check())return;}catch{}await delay(200);}throw Error('development verification timeout');}
try{
  app=await _electron.launch({executablePath:join(root,'node_modules/electron/dist/electron.exe'),args:[join(root,'desktop/main.cjs')],cwd:root,env,timeout:60000});
  const page=await app.firstWindow();await page.waitForSelector('.assistant-workspace');
  const time=()=>page.evaluate(()=>performance.timeOrigin);let before=await time();
  await writeFile(frontend,'/* development refresh fixture */');await until(async()=>await time()!==before);
  before=await time();await writeFile(typed,"const invalid:number='x';export {};");await until(async()=>(await readFile(join(data,'desktop.log'),'utf8')).includes('保留当前运行版本'));assert.equal(await time(),before,'failed compilation must not refresh');await writeFile(typed,'export {};');await until(async()=>await time()!==before);
  const origin=page.url();before=await time();await writeFile(backend,'// development restart fixture');
  await until(async()=>await time()!==before&&(await readFile(join(data,'desktop.log'),'utf8')).includes('后端已重启'));
  assert.equal(page.url(),origin,'backend restart retains renderer origin');
  assert.equal(await page.evaluate(async()=> (await fetch('/api/snapshot')).status),200);
  const title=await app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows()[0].getTitle());assert.match(title,/开发版/);
  const output=resolve('.tmp-desktop/dev-verification.png');await page.screenshot({path:output});
  await app.close();app=null;
  await assert.rejects(fetch(origin,{signal:AbortSignal.timeout(2000)}));
  console.log(JSON.stringify({passed:true,cases:['css-refresh','typescript-build-refresh','compile-failure-recovery','backend-restart','stable-origin','development-title','backend-shutdown'],modelCalls:0,data,output}));
}finally{await app?.close();for(const path of [frontend,typed,backend])await unlink(path).catch(()=>{});}
