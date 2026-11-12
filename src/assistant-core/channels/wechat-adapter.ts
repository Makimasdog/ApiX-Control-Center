import {createDecipheriv, createHash, randomBytes} from 'node:crypto';
import type {MessagePart} from './message-format.js';
import {addMedia, addText, ProviderFailure, jsonPost, list, numberId, providerFetch, providerJson, readBounded, record, remoteMessage, string,
  textLimit, type RemoteAdapter, type RemoteConfig} from './remote-adapter.js';

const api = 'https://ilinkai.weixin.qq.com/ilink/bot/';
const cdn = 'https://novac2c.cdn.weixin.qq.com/c2c/download';
const channelVersion = '3.0.1/ApiX';

function mediaUrl(media: Record<string, unknown>) {
  const full = string(media.full_url);
  if (full) {
    const url = new URL(full);
    if (url.protocol === 'https:' && !url.port && !url.username && !url.password &&
        (url.hostname === 'novac2c.cdn.weixin.qq.com' || url.hostname.endsWith('.cdn.weixin.qq.com'))) return url;
  }
  const param = string(media.encrypt_query_param);
  if (!param) throw new Error('微信附件地址无效');
  const url = new URL(cdn);
  url.searchParams.set('encrypted_query_param', param);
  return url;
}

function mediaKey(encoded: string, hex: string) {
  if (/^[0-9a-f]{32}$/i.test(hex)) return Buffer.from(hex, 'hex');
  if (!encoded) return null;
  const key = Buffer.from(encoded, 'base64');
  if (key.length === 16) return key;
  if (/^[0-9a-f]{32}$/i.test(key.toString('ascii'))) return Buffer.from(key.toString('ascii'), 'hex');
  throw new Error('微信附件密钥无效');
}

export function wechatAdapter(config: RemoteConfig, fetcher: typeof fetch = fetch): RemoteAdapter {
  async function call(path: string, body: Record<string, unknown>, signal?: AbortSignal, timeout?: number) {
    const headers = {
      AuthorizationType: 'ilink_bot_token', Authorization: 'Bearer ' + config.token,
      'iLink-App-Id': 'bot', 'iLink-App-ClientVersion': String(0x030001),
      'X-WECHAT-UIN': Buffer.from(String(randomBytes(4).readUInt32BE())).toString('base64'),
    };
    const value = record(await providerJson(fetcher, api + path, jsonPost({
      ...body, base_info: {channel_version: channelVersion, bot_agent: 'ApiX/0.3.2'},
    }, headers), signal, timeout));
    if(value.ret===-14||value.errcode===-14)throw new ProviderFailure(401,3600000);
    if ((value.ret !== undefined && value.ret !== 0) || (value.errcode !== undefined && value.errcode !== 0)) {
      throw new Error('微信渠道服务返回失败');
    }
    return value;
  }

  return {
    channel: 'wechat',
    async poll(cursor, signal) {
      const value = await call('getupdates', {get_updates_buf: cursor}, signal, 45000);
      if (!Array.isArray(value.msgs) && value.msgs !== undefined) throw new Error('微信更新列表无效');
      return {updates: list(value.msgs), cursor: string(value.get_updates_buf) || cursor};
    },
    async normalize(input, signal) {
      const item = record(input);
      if (item.message_type !== 1 || item.group_id || item.from_user_id !== config.peerId) return null;
      const id = numberId(item.message_id) || string(item.message_id) || string(item.client_id) || numberId(item.seq);
      if (!id) return null;
      const parts: MessagePart[] = [];
      for (const raw of list(item.item_list).slice(0, 12)) {
        const entry = record(raw);
        if (entry.type === 1) { addText(parts, record(entry.text_item).text); continue; }
        const kind = entry.type === 2 ? 'image' : entry.type === 3 ? 'voice' : entry.type === 4 || entry.type === 5 ? 'file' : null;
        if (!kind) continue;
        const field = kind === 'image' ? 'image_item' : kind === 'voice' ? 'voice_item' : entry.type === 5 ? 'video_item' : 'file_item';
        const content = record(entry[field]), media = record(content.media);
        if (kind === 'voice') addText(parts, content.text);
        const name = string(content.file_name) || (kind === 'image' ? 'wechat-image.jpg' : kind === 'voice' ? 'wechat-voice.silk' : 'wechat-file');
        const mime = kind === 'image' ? 'image/jpeg' : kind === 'voice' ? 'audio/silk' : 'application/octet-stream';
        await addMedia(parts, kind, name, mime, async remaining => {
          const key = mediaKey(string(media.aes_key), string(content.aeskey));
          if (!key && kind !== 'image') throw new Error('微信附件缺少密钥');
          const response = await providerFetch(fetcher, mediaUrl(media), {}, signal);
          const encrypted = await readBounded(response, remaining + 16);
          if (!key) return {bytes: encrypted};
          const cipher = createDecipheriv('aes-128-ecb', key, null);
          return {bytes: Buffer.concat([cipher.update(encrypted), cipher.final()])};
        }, signal);
      }
      return remoteMessage(config, id, parts, string(item.context_token));
    },
    async send(message, text, signal) {
      const clientId = 'apix-' + createHash('sha256').update(JSON.stringify([config.accountId, message.id])).digest('hex').slice(0, 32);
      await call('sendmessage', {msg: {
        from_user_id: '', to_user_id: config.peerId, client_id: clientId,
        message_type: 2, message_state: 2,
        ...(message.replyContext ? {context_token: message.replyContext} : {}),
        item_list: [{type: 1, text_item: {text: textLimit(text, 3000)}}],
      }}, signal);
    },
  };
}
