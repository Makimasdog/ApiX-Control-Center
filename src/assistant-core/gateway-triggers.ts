import {statSync} from 'node:fs';
import {CronExpressionParser} from 'cron-parser';
import {projectPath} from '../assistant/assistant-tools.js';
import {ToolError} from '../assistant/tool-governance.js';
import {object} from '../coordination/contracts.js';

interface CronTrigger {kind: 'cron'; expression: string; timeZone: string}
interface HeartbeatTrigger {kind: 'heartbeat'; intervalSeconds: number}
interface FileTrigger {kind: 'file'; path: string; intervalSeconds: number}
export type EventKind = 'git.push' | 'mail.received';
interface EventTrigger {kind: EventKind; source: string}
export type GatewayTrigger = CronTrigger | HeartbeatTrigger | FileTrigger | EventTrigger;

export const bad = (message: string) => new ToolError('INVALID_ARGUMENTS', message, 'correct_input');

export function requiredText(raw: unknown, max: number, label: string) {
  if (typeof raw !== 'string' || !raw.trim() || raw.length > max) throw bad(label + '应为 1–' + max + ' 字符');
  return raw.trim();
}

function eventKind(kind: unknown): kind is EventKind {
  return kind === 'git.push' || kind === 'mail.received';
}

function interval(input: unknown, min: number, defaultSeconds: number) {
  const value = input === undefined ? defaultSeconds : input;
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < min || value > 86400) {
    throw bad('检查间隔应为 ' + min + '–86400 秒的整数');
  }
  return value;
}

export function readTrigger(raw: unknown): GatewayTrigger {
  const input = object(raw);
  if (input.kind === 'cron') {
    const expression = requiredText(input.expression, 120, 'Cron 表达式');
    const timeZone = requiredText(input.timeZone, 80, '时区');
    if (!/^[0-9*/, -]+$/.test(expression) || expression.split(/ +/).length !== 5) throw bad('需要五字段数字 Cron 表达式');
    try { new Intl.DateTimeFormat('en', {timeZone}); } catch { throw bad('需要有效的 IANA 时区'); }
    return {kind: 'cron', expression, timeZone};
  }
  if (input.kind === 'heartbeat') {
    return {kind: 'heartbeat', intervalSeconds: interval(input.intervalSeconds, 60, 300)};
  }
  if (input.kind === 'file') {
    return {kind: 'file', path: requiredText(input.path, 1000, '项目相对路径'), intervalSeconds: interval(input.intervalSeconds, 2, 10)};
  }
  if (eventKind(input.kind)) return {kind: input.kind, source: requiredText(input.source, 120, '事件来源')};
  throw bad('触发类型无效');
}

export function nextOccurrence(trigger: GatewayTrigger, at: number): number | null {
  if (trigger.kind === 'cron') {
    return CronExpressionParser.parse(trigger.expression, {currentDate: at, tz: trigger.timeZone}).next().getTime();
  }
  if ('intervalSeconds' in trigger) return at + trigger.intervalSeconds * 1000;
  return null;
}

export function fileCheckpoint(root: string, path: string) {
  const target = projectPath(root, path, true);
  const info = statSync(target, {bigint: true, throwIfNoEntry: false});
  if (!info) return 'missing';
  if (!info.isFile()) throw bad('文件触发规则需要指向普通文件');
  return [info.ino, info.size, info.mtimeNs, info.ctimeNs].join(':');
}

export function readEvent(raw: unknown) {
  const input = object(raw);
  if (!eventKind(input.kind)) throw bad('事件类型应为 git.push 或 mail.received');
  const source = requiredText(input.source, 120, '事件来源');
  const eventId = requiredText(input.eventId, 200, '事件标识');
  const summary = input.summary === undefined || input.summary === '' ? '' : requiredText(input.summary, 500, '事件摘要');
  return {kind: input.kind, source, eventId, summary};
}
