/**
 * 进程内事件总线 (Change Bus) - 为 SSE 订阅者提供增量推送通知
 *
 * 所属层级：基础设施层
 * 核心功能：
 *   - 提供 subscribe/emit 发布-订阅接口，用于控制面状态变更的即时通知
 *   - 替代固定 500ms 轮询，写入后立即唤醒 SSE 订阅者做增量拉取
 *   - 监听器异常相互隔离，不会回传给写入路径
 * 依赖关系：
 *   - 被 [→ 见 src/infrastructure/api-routes.mjs] 的 SSE 事件流路由订阅
 *   - 控制面 mailbox 的 appendMessageEvent 写入后通过 emit 触发通知
 *
 * 设计说明：
 *   控制面是单进程架构，message_events 的写入全部集中在 mailbox 模块。
 *   写入后通过本模块立即唤醒 SSE 订阅者，而非让每个客户端固定 500ms 轮询。
 *   SSE 侧另有 30s 兜底轮询防漏发（见 api-routes.mjs 中 fallback setInterval）。
 */

/** 存储所有活跃的订阅监听器 */
const listeners = new Set();

/**
 * changeBus - 进程内事件总线的唯一导出对象
 *
 * subscribe - 注册一个变更监听器，返回取消订阅的函数
 * @param {Function} listener - 监听函数，接收 change 对象（含 projectId 等字段）
 * @returns {Function} 取消订阅的清理函数
 *
 * emit - 向所有监听器广播一次变更事件
 * @param {Object} change - 变更描述对象，通常包含 projectId 字段
 *
 * 安全特性：每个 listener 的异常被 try/catch 隔离，不会影响其他订阅者或写入方。
 */
export const changeBus = {
  subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); },
  emit(change) { for (const listener of [...listeners]) { try { listener(change); } catch { /* 订阅方异常不影响写入方 */ } } },
};
