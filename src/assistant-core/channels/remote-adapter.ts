import {Buffer} from 'node:buffer';
import {MEDIA_LIMIT, MEDIA_COUNT, mediaPart, normalizeMime, type ExternalChannel, type MediaKind, type MessageAdapter, type MessageEnvelope, type MessagePart} from './message-format.js';

export interface RemoteConfig {
  channel: ExternalChannel;
  accountId: string;
  projectId: string;
  conversationId: string;
  peerId: string;
  token: string;
}

export interface RemoteMessage extends MessageEnvelope {
  channel: ExternalChannel;
  id: string;
  replyContext?: string;
}

export interface RemoteAdapter extends MessageAdapter<unknown> {
  readonly channel: ExternalChannel;
  poll(cursor: string, signal: AbortSignal): Promise<{updates: unknown[]; cursor: string}>;
  normalize(input: unknown, signal?: AbortSignal): Promise<RemoteMessage | null>;
  send(message: RemoteMessage, text: string, signal: AbortSignal): Promise<void>;
}

export class ProviderFailure extends Error {
  constructor(readonly status: number, readonly retryMs = 0) {
    super('渠道服务请求失败');
  }
}

export async function providerFetch(fetcher: typeof fetch, url: string | URL, init: RequestInit, signal?: AbortSignal, timeout = 12000) {
  const timeoutSignal = AbortSignal.timeout(timeout);
  const response = await fetcher(url, {...init, redirect: 'error', signal: signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal});
  if (!response.ok) {
    await response.body?.cancel();
    const seconds = Number(response.headers.get('Retry-After'));
    throw new ProviderFailure(response.status, Number.isFinite(seconds) ? Math.min(300000, Math.max(0, seconds * 1000)) : 0);
  }
  return response;
}

export async function readBounded(response: Response, max: number) {
  const reader = response.body?.getReader();
  if (!reader) return Buffer.alloc(0);
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const {done, value} = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > max) throw new Error('渠道内容超出传输上限');
      chunks.push(value);
    }
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
  return Buffer.concat(chunks, size);
}

export async function providerJson(fetcher: typeof fetch, url: string, init: RequestInit, signal?: AbortSignal, timeout?: number): Promise<unknown> {
  return JSON.parse((await readBounded(await providerFetch(fetcher, url, init, signal, timeout), 2 * 1024 * 1024)).toString('utf8'));
}

export function jsonPost(body: unknown, headers: Record<string, string> = {}): RequestInit {
  return {method: 'POST', headers: {'Content-Type': 'application/json', ...headers}, body: JSON.stringify(body)};
}

export function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

export const list = (value: unknown): unknown[] => Array.isArray(value) ? value : [];
export const string = (value: unknown) => typeof value === 'string' ? value : '';
export const numberId = (value: unknown) => typeof value === 'number' && Number.isSafeInteger(value) ? String(value) : '';

export function addText(parts: MessagePart[], input: unknown, format: 'plain' | 'markdown' = 'plain') {
  const used = parts.reduce((length, part) => length + (part.kind === 'text' ? part.text.length + 1 : 0), 0);
  const text = string(input).trim().slice(0, Math.max(0, 10000 - used));
  if (text) parts.push({kind: 'text', format, text});
}

export async function addMedia(
  parts: MessagePart[], kind: MediaKind, name: string, mime: unknown,
  load: (remaining: number) => Promise<{bytes: Uint8Array; mime?: string}>,
  signal?: AbortSignal,
) {
  const media = parts.filter(part => part.kind !== 'text');
  const remaining = MEDIA_LIMIT - media.reduce((size, part) => size + part.bytes.byteLength, 0);
  try {
    if (media.length >= MEDIA_COUNT || remaining <= 0) throw new Error('媒体额度已用尽');
    const loaded = await load(remaining);
    if (!loaded.bytes.byteLength || loaded.bytes.byteLength > remaining) throw new Error('附件大小无效');
    const type = normalizeMime(mime);
    parts.push(mediaPart(kind, name, type === 'application/octet-stream' ? loaded.mime ?? type : type, loaded.bytes));
  } catch {
    signal?.throwIfAborted();
    addText(parts, '〔附件不可用或超过大小上限〕');
  }
}

export function remoteMessage(config: RemoteConfig, id: string, parts: MessagePart[], replyContext?: string): RemoteMessage | null {
  if (!parts.length || !id || id.length > 200) return null;
  return {channel: config.channel, accountId: config.accountId, conversationId: config.conversationId,
    senderId: config.peerId, id, parts, ...(replyContext ? {replyContext} : {})};
}

export function textLimit(text: string, max: number) {
  const points = Array.from(text);
  return points.length > max ? points.slice(0, max - 1).join('') + '…' : text;
}
