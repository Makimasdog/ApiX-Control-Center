/** 查询和执行共用握手，连接及 pending 请求始终由各自独占的进程维护。 */
export async function initializeCodex(request:(method:string,params:unknown)=>Promise<any>,notify:(method:string)=>void,capabilities:Record<string,unknown>={}){
  const result=await request('initialize',{clientInfo:{name:'apix_control_center',title:'ApiX',version:'0.3.2'},capabilities});
  notify('initialized');return result;
}
