// 进程内事件总线(P11):控制面是单进程,message_events 的写入全部集中在 mailbox 的
// appendMessageEvent;写入后通过这里立即唤醒 SSE 订阅者做增量拉取,替代固定 500ms 轮询。
// 监听器异常相互隔离,不会回传给写入路径;SSE 侧另有 30s 兜底轮询防漏发。
const listeners = new Set();
export const changeBus = {
  subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); },
  emit(change) { for (const listener of [...listeners]) { try { listener(change); } catch { /* 订阅方异常不影响写入方 */ } } },
};
