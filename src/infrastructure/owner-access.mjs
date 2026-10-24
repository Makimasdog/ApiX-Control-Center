import {randomBytes,timingSafeEqual} from 'node:crypto';
import {readFileSync,writeFileSync,mkdirSync} from 'node:fs';
import {join} from 'node:path';
import {homedir} from 'node:os';

// Capability authentication for a local single-owner application, not an OS sandbox.
export function readOwnerToken(directory) {
  mkdirSync(directory,{recursive:true});
  const file=join(directory,'owner-access.json');
  let token=process.env.APIX_OWNER_TOKEN;
  if(!token){try{token=JSON.parse(readFileSync(file,'utf8')).token;}catch(error){if(error.code!=='ENOENT')throw error;token=randomBytes(32).toString('hex');writeFileSync(file,JSON.stringify({token}),{flag:'wx',mode:0o600});}}
  if(typeof token!=='string'||!/^[a-zA-Z0-9_-]{32,128}$/.test(token))throw new Error('所有者访问令牌格式无效');
  return token;
}
export function createOwnerAccess(port, directory=process.env.APIX_DATA_DIR??join(homedir(),'.apix-agent-os')) {
  const token=readOwnerToken(directory);
  const cookieName='apix_owner_'+port;
  const equals=value=>typeof value==='string'&&Buffer.byteLength(value)===Buffer.byteLength(token)&&timingSafeEqual(Buffer.from(value),Buffer.from(token));
  const authorized=request=>{
    // An explicit wrong Bearer must never fall back to a privileged browser cookie.
    if(request.headers.authorization)return request.headers.authorization.startsWith('Bearer ')&&equals(request.headers.authorization.slice(7));
    const pair=(request.headers.cookie??'').split(';').map(p=>p.trim()).find(p=>p.startsWith(cookieName+'='));
    return equals(pair?.slice(cookieName.length+1));
  };
  const cookie=()=>`${cookieName}=${token}; HttpOnly; SameSite=Strict; Path=/`;
  return {authorized,cookie,equals};
}

export const ownerLoginHtml=`<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>ApiX 本机访问</title><link rel="stylesheet" href="/design-system.css"><body><main class="panel" style="max-width:560px;margin:12vh auto;padding:32px"><h1>连接你的 ApiX</h1><p>请输入本机数据目录 owner-access.json 中的 token。Electron 会自动连接。</p><form id="owner-login"><label>本机访问令牌 <input type="password" name="token" required autocomplete="off"></label><button>连接</button><p id="owner-error" role="alert"></p></form></main><script src="/owner-login.js"></script></body></html>`;
