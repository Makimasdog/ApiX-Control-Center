import {mediaKind, normalizeMime, type MediaKind, type MessagePart} from './message-format.js';
import {addMedia, addText, jsonPost, list, numberId, providerFetch, providerJson, readBounded, record, remoteMessage, string,
  textLimit, type RemoteAdapter, type RemoteConfig} from './remote-adapter.js';

function appendMessageText(parts:MessagePart[],message:Record<string,unknown>){
  const text=string(message.text??message.caption);
  const entities=list(message.text===undefined?message.caption_entities:message.entities).map(record)
    .filter(item=>(item.type==='bold'||item.type==='code')&&Number.isSafeInteger(item.offset)&&
      Number.isSafeInteger(item.length)&&Number(item.offset)>=0&&Number(item.length)>0&&
      Number(item.offset)+Number(item.length)<=text.length)
    .sort((a,b)=>Number(a.offset)-Number(b.offset));
  if(!entities.length){addText(parts,text);return;}
  let rich='', end=0;
  for(const item of entities){
    const start=Number(item.offset), after=start+Number(item.length);
    if(start<end)continue;
    const marker=item.type==='bold'?'**':'`';
    rich+=text.slice(end,start)+marker+text.slice(start,after)+marker;
    end=after;
  }
  addText(parts,rich+text.slice(end),'markdown');
}

export function telegramAdapter(config: RemoteConfig, fetcher: typeof fetch = fetch): RemoteAdapter {
  const api = 'https://api.telegram.org/bot' + config.token + '/';

  async function call(method: string, body: Record<string, unknown>, signal?: AbortSignal, timeout?: number) {
    const value = record(await providerJson(fetcher, api + method, jsonPost(body), signal, timeout));
    if (value.ok !== true) throw new Error('Telegram 渠道服务返回失败');
    return value.result;
  }

  async function attach(parts: MessagePart[], raw: unknown, kind: MediaKind, fallback: string, mime: string, signal?: AbortSignal) {
    const item = record(raw);
    const fileId = string(item.file_id);
    if (!fileId) return;
    await addMedia(parts, kind, string(item.file_name) || fallback, mime, async remaining => {
      if (typeof item.file_size === 'number' && item.file_size > remaining) throw new Error('Telegram 附件过大');
      const result = record(await call('getFile', {file_id: fileId}, signal));
      const path = string(result.file_path);
      const segments = path.split('/');
      if (!segments.every(segment => /^[A-Za-z0-9_.-]+$/.test(segment) && segment !== '.' && segment !== '..')) {
        throw new Error('Telegram 附件路径无效');
      }
      const response = await providerFetch(fetcher, 'https://api.telegram.org/file/bot' + config.token + '/' + path, {}, signal);
      return {bytes: await readBounded(response, remaining), mime: normalizeMime(response.headers.get('Content-Type'))};
    }, signal);
  }

  return {
    channel: 'telegram',
    async poll(cursor, signal) {
      const offset = Number(cursor || '0');
      const result = await call('getUpdates', {offset, timeout: 20, allowed_updates: ['message']}, signal, 30000);
      if (!Array.isArray(result)) throw new Error('Telegram 更新列表无效');
      const updates = list(result);
      let next = offset;
      for (const update of updates) {
        const id = numberId(record(update).update_id);
        if (id) next = Math.max(next, Number(id) + 1);
      }
      return {updates, cursor: String(next)};
    },
    async normalize(input, signal) {
      const update = record(input), message = record(update.message);
      const from = record(message.from), chat = record(message.chat);
      if (from.is_bot || numberId(chat.id) !== config.conversationId || numberId(from.id) !== config.peerId) return null;
      const id = numberId(update.update_id);
      if (!id) return null;
      const parts: MessagePart[] = [];
      appendMessageText(parts,message);
      const photos = list(message.photo);
      if (photos.length) await attach(parts, photos.at(-1), 'image', 'telegram-image.jpg', 'image/jpeg', signal);
      if (message.voice) await attach(parts, message.voice, 'voice', 'telegram-voice.ogg', 'audio/ogg', signal);
      const document = message.document ?? message.audio ?? message.video;
      if (document) {
        const mime = normalizeMime(record(document).mime_type);
        await attach(parts, document, mediaKind(mime), 'telegram-file', mime, signal);
      }
      return remoteMessage(config, id, parts, numberId(message.message_id));
    },
    async send(message, text, signal) {
      await call('sendMessage', {chat_id: config.conversationId, text: textLimit(text, 4000),
        ...(message.replyContext ? {reply_parameters: {message_id: Number(message.replyContext), allow_sending_without_reply: true}} : {}),
        link_preview_options: {is_disabled: true},
      }, signal);
    },
  };
}
