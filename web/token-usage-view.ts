import {html} from './html.js';
import type {TokenUsageReport} from '../src/assistant/token-usage.js';
// 缺失计数显示“未知”，不能用零替代，也不能把估算冒充供应商实际计数。
const number=(value:unknown)=>typeof value==='number'?value.toLocaleString():'未知';
const purposes:Record<string,string>={assistant_loop:'任务推理',compaction:'历史压缩',format_repair:'格式纠正',planning:'规划',discussion:'讨论',connection_test:'连接测试',legacy_director:'遗留规划'};
/** 展示已知小计和逐字段覆盖率；缓存、推理是细分项，不能与输入、输出再次相加。 */
export function tokenUsageView(value:TokenUsageReport){
  const task=value.task;
  const metrics=[['inputTokens','输入（含缓存）'],['outputTokens','输出（含推理）'],['cachedInputTokens','缓存读取'],['cacheWriteTokens','缓存写入'],['reasoningTokens','推理输出']] as const;
  return html`<p>当前任务 · ${task.calls} 次请求 · ${task.retries} 次重试 · ${task.failed} 次失败 · ${task.pending} 次待确认</p><dl>`+
    metrics.map(([key,label])=>html`<div><dt>${label}</dt><dd>${number(task[key])} Token <small>（${task.coverage[key]} / ${task.calls} 次已观测）</small></dd></div>`).join('')+
    html`</dl><p>${task.incomplete} 次请求缺少完整用量。已观测数为已知小计；缓存、推理是细分项，不能重复相加。费用未知，沿用原有预算结算。</p><details><summary>会话与项目累计</summary><p>本对话：${value.session.calls} 次请求；输入 ${number(value.session.inputTokens)} / 输出 ${number(value.session.outputTokens)} Token；${value.session.incomplete} 次不完整。</p><p>本项目 ApiX API：${value.project.calls} 次请求；输入 ${number(value.project.inputTokens)} / 输出 ${number(value.project.outputTokens)} Token；${value.project.incomplete} 次不完整。</p><p>外部 CLI 用量未知；升级前的历史调用不补造。</p></details><details><summary>当前任务最近 ${value.recent.length} 次请求（最多 ${value.historyLimit} 次）</summary>`+
    (value.recent.length?value.recent.map(r=>html`<article class="token-usage-record"><strong>${purposes[String(r.purpose)]??r.purpose}</strong><p>${r.provider} / ${r.model} · 第 ${r.attempt} 次 · ${r.status==='completed'?'完成':r.status==='failed'?'失败':'待确认'}</p><p>输入 ${number(r.inputTokens)} / 输出 ${number(r.outputTokens)} Token · ${r.usageComplete?'用量完整':'用量不完整'} · ${number(r.durationMs)} ms</p><small>${r.createdAt}</small></article>`).join(''):html`<p>暂无请求记录；供应商未提供的用量显示未知。</p>`)+
    html`</details><p class="assistant-system-note">请求正文估算累计 ${number(task.estimatedPromptTokens)} Token（UTF-8 字节÷3，不含传输层系统提示）；此估算不作为实际用量或费用。</p>`;
}
