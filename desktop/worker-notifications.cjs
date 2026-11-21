function createWorkerNotifications({Notification,readPending,openRequest,report}) {
  const active=new Map();
  const shown=new Set();
  let stopped=false,refreshing=false,readFailed=false;

  async function refresh() {
    if(stopped||refreshing)return;
    refreshing=true;
    try {
      const pending=await readPending();
      if(stopped)return;
      readFailed=false;
      const live=new Set(pending.map(request=>request.interactionId));
      for(const [id,notification] of active){
        if(live.has(id))continue;
        active.delete(id);
        notification.close();
      }
      for(const {projectId,sessionId,interactionId,kind,employee} of pending){
        if(shown.has(interactionId))continue;
        shown.add(interactionId);
        const notification=new Notification({
          title:kind==='approval'?'ApiX · 员工等待审批':'ApiX · 员工等待回答',
          body:`${employee} 正在等待你的决定。点击返回原对话。`,
        });
        active.set(interactionId,notification);
        notification.once('click',()=>{
          if(active.has(interactionId))openRequest({projectId,sessionId,interactionId});
        });
        notification.once('failed',()=>report('Windows 未显示员工请求通知'));
        // Windows can move a timed-out banner into Action Center. Keep the handle to remove it later.
        notification.show();
      }
    } catch(error) {
      if(!stopped&&!readFailed)report('员工请求通知刷新失败：'+error.message);
      readFailed=true;
    } finally {
      refreshing=false;
    }
  }

  function stop() {
    stopped=true;
    for(const [id,notification] of active){
      active.delete(id);
      notification.close();
    }
  }

  return {refresh,stop};
}

module.exports={createWorkerNotifications};
