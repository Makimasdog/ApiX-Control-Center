import {randomBytes} from 'node:crypto';
// Real owner credential shared by isolated test servers; production has no test bypass.
process.env.APIX_OWNER_TOKEN??=randomBytes(32).toString('hex');
export async function fetch(input,init={}){
  const url=new URL(input instanceof Request?input.url:input),headers=new Headers(init.headers??(input instanceof Request?input.headers:undefined));
  if(['127.0.0.1','localhost'].includes(url.hostname)&&!url.pathname.startsWith('/api/agent/')&&(url.pathname.startsWith('/api/')||['/','/index.html'].includes(url.pathname))&&!headers.has('Authorization'))headers.set('Authorization','Bearer '+process.env.APIX_OWNER_TOKEN);
  return globalThis.fetch(input,{...init,headers});
}
export async function authorizePage(page,origin){await page.context().addCookies([{name:'apix_owner_'+new URL(origin).port,value:process.env.APIX_OWNER_TOKEN,url:origin,httpOnly:true,sameSite:'Strict'}]);}
