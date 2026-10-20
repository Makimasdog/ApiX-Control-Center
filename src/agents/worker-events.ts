export interface WorkerEvent {
  text?: string;
  textMode?: 'append' | 'replace';
  failed?: boolean;
  kind: string;
}

function object(value: unknown): Record<string,unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string,unknown> : {};
}

function contentText(value: unknown): string {
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) return value.filter(part=>object(part).type==='text').map(part=>object(part).text).filter((part):part is string=>typeof part==='string').join('');
  return '';
}

export function normalizeWorkerEvent(runtime: string, item: Record<string,unknown>): WorkerEvent | null {
  if (!['codex','gemini','opencode','kimi'].includes(runtime)) return null;
  const type = typeof item.type === 'string' ? item.type : 'unknown';
  const message = object(item.message);
  const part = object(item.part);
  const role = item.role ?? message.role;
  if(runtime==='codex')return {kind:type,failed:type==='turn.failed' || type==='error' && !(typeof item.message==='string' && /^Reconnecting\.\.\.\s*\d+\/\d+\b/.test(item.message))};
  if (runtime === 'gemini') {
    if (type === 'message' && role === 'assistant') return {kind:type,text:contentText(item.content ?? message.content),textMode:item.delta === true ? 'append' : 'replace'};
    if (type === 'result') return {kind:type,text:contentText(item.response),textMode:'replace',failed:item.is_error === true || item.status === 'error'};
  }
  if (runtime === 'opencode') {
    if (type === 'text' && part.type === 'text') return {kind:type,text:contentText(part.text),textMode:'append'};
    if (type === 'step_finish' && part.reason === 'error') return {kind:type,failed:true};
  }
  if (runtime === 'kimi') {
    if (type === 'message' && role === 'assistant') return {kind:type,text:contentText(item.content ?? message.content),textMode:item.delta === true ? 'append' : 'replace'};
    if (type === 'content_block_delta') return {kind:type,text:contentText(object(item.delta).text),textMode:'append'};
    if (type === 'result') return {kind:type,text:contentText(item.result),textMode:'replace',failed:item.is_error === true};
  }
  return {kind:type,failed:type === 'error' || type === 'turn.failed'};
}
