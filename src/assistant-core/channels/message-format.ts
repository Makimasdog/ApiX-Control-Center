import {createHash} from 'node:crypto';
import {object} from '../../coordination/contracts.js';
import {ToolError} from '../../assistant/tool-governance.js';

export type Channel = 'web' | 'wechat' | 'telegram' | 'discord';
export type ExternalChannel = Exclude<Channel, 'web'>;
export type MediaKind = 'image' | 'file' | 'voice';
export type TextFormat = 'plain' | 'markdown';
export interface TextPart {kind: 'text'; format: TextFormat; text: string}
export interface MediaPart {kind: MediaKind; name: string; mime: string; bytes: Uint8Array}
export type MessagePart = TextPart | MediaPart;
export interface MessageEnvelope {
  channel: Channel;
  accountId: string;
  conversationId: string;
  senderId: string;
  id?: string;
  parts: MessagePart[];
}
export interface MessageAdapter<Input> {
  readonly channel: Channel;
  normalize(input: Input, signal?: AbortSignal): MessageEnvelope | null | Promise<MessageEnvelope | null>;
}

export const MEDIA_LIMIT = 4 * 1024 * 1024;
export const MEDIA_COUNT = 4;
export const invalid = (message: string) => new ToolError('INVALID_ARGUMENTS', message, 'correct_input');

export function safeName(name: string) {
  return name.replace(/[\\/\u0000-\u001f\u007f]/g, '_').trim().slice(0, 160) || 'attachment';
}

export function mediaKind(mime: string): MediaKind {
  return mime.startsWith('image/') ? 'image' : mime.startsWith('audio/') ? 'voice' : 'file';
}

export function normalizeMime(mime: unknown) {
  return typeof mime === 'string' && /^[a-z0-9.+-]+\/[a-z0-9.+-]+$/i.test(mime) && mime.length <= 96
    ? mime.toLowerCase() : 'application/octet-stream';
}

export function mediaPart(kind: MediaKind, name: string, mime: unknown, bytes: Uint8Array): MediaPart {
  return {kind, name: safeName(name), mime: normalizeMime(mime), bytes};
}

export function messageText(parts: MessagePart[]) {
  return parts.filter((part): part is TextPart => part.kind === 'text').map(part => part.text).join('\n').trim();
}

export function verifyMessageParts(parts: MessagePart[]) {
  const content = messageText(parts);
  if (content.length > 10000) throw invalid('消息正文不能超过 10000 字符');
  const attachments = parts.filter((part): part is MediaPart => part.kind !== 'text');
  if (attachments.length > MEDIA_COUNT || attachments.some(part => part.bytes.byteLength === 0) ||
      attachments.reduce((total, part) => total + part.bytes.byteLength, 0) > MEDIA_LIMIT) {
    throw invalid('单条消息最多 4 个附件，合计上限为 4 MiB');
  }
  if (!content && !attachments.length) throw invalid('需要填写消息或添加附件');
  return {content, attachments};
}

export function messageFingerprint(content: string, parts: MessagePart[]) {
  const onlyPlain = parts.length === 1 && parts[0]?.kind === 'text' && parts[0].format === 'plain';
  const body = onlyPlain ? content : JSON.stringify(parts.map(part => part.kind === 'text' ? part : {
    kind: part.kind, name: part.name, mime: part.mime, sha256: createHash('sha256').update(part.bytes).digest('hex'),
  }));
  return createHash('sha256').update(body).digest('hex');
}

export const webAdapter: MessageAdapter<{sessionId: string; body: unknown}> = {
  channel: 'web',
  normalize({sessionId, body}) {
    const input = object(body);
    const {requestId} = input;
    if (requestId !== undefined && (typeof requestId !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:-]{7,99}$/.test(requestId))) {
      throw invalid('消息请求 ID 应为 8–100 位字母、数字或 . _ : -');
    }
    if (input.content !== undefined && (typeof input.content !== 'string' || input.content.length > 10000)) {
      throw invalid('消息正文不能超过 10000 字符');
    }
    const format = input.format === undefined ? 'plain' : input.format;
    if (format !== 'plain' && format !== 'markdown') throw invalid('消息文本格式无效');
    const parts: MessagePart[] = [];
    const content = typeof input.content === 'string' ? input.content.trim() : '';
    if (content) parts.push({kind: 'text', format, text: content});
    if (input.attachments !== undefined) {
      if (!Array.isArray(input.attachments) || input.attachments.length > MEDIA_COUNT) throw invalid('附件列表无效');
      for (const item of input.attachments) {
        const {name, mime, data} = object(item);
        if (typeof name !== 'string' || name.length > 160 || typeof data !== 'string' ||
            data.length > Math.ceil(MEDIA_LIMIT / 3) * 4 || !/^[A-Za-z0-9+/]+={0,2}$/.test(data)) {
          throw invalid('附件名称或数据无效');
        }
        const bytes = Buffer.from(data, 'base64');
        if (bytes.toString('base64') !== data) throw invalid('附件编码无效');
        const type = normalizeMime(mime);
        parts.push(mediaPart(mediaKind(type), name, type, bytes));
      }
    }
    return {channel: 'web', accountId: 'owner', conversationId: sessionId, senderId: 'owner', id: requestId, parts};
  },
};
