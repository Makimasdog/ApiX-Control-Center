import {createHash} from 'node:crypto';
import {mediaKind, normalizeMime, type MessagePart} from './message-format.js';
import {addMedia, addText, jsonPost, list, providerFetch, providerJson, readBounded, record, remoteMessage, string,
  textLimit, type RemoteAdapter, type RemoteConfig} from './remote-adapter.js';

const snowflake = (id: unknown) => typeof id === 'string' && /^\d{1,20}$/.test(id) ? id : '';
const cdnHosts = new Set(['cdn.discordapp.com', 'media.discordapp.net']);

function attachmentUrl(raw: unknown) {
  const url = new URL(string(raw));
  if (url.protocol !== 'https:' || url.username || url.password || url.port || !cdnHosts.has(url.hostname)) {
    throw new Error('Discord 附件地址无效');
  }
  return url;
}

export function discordAdapter(config: RemoteConfig, fetcher: typeof fetch = fetch): RemoteAdapter {
  const endpoint = 'https://discord.com/api/v10/channels/' + config.conversationId + '/messages';
  const headers = {Authorization: 'Bot ' + config.token};

  async function page(params: string, signal: AbortSignal) {
    const result = await providerJson(fetcher, endpoint + '?' + params, {headers}, signal);
    if (!Array.isArray(result)) throw new Error('Discord 消息列表无效');
    return result.map(record).filter(message => snowflake(message.id));
  }

  return {
    channel: 'discord',
    async poll(cursor, signal) {
      if (!cursor) {
        const latest = (await page('limit=1', signal))[0];
        return {updates: [], cursor: snowflake(latest?.id) || '0'};
      }
      const first = await page('limit=100&after=' + cursor, signal);
      const entries = [...first];
      let prior = first;
      // Discord 以新到旧返回，满页时向旧消息翻页，避免跳过未处理消息。
      for (let pages = 1; prior.length === 100 && BigInt(snowflake(prior.at(-1)?.id)) > BigInt(cursor); pages++) {
        if (pages >= 10) throw new Error('Discord 未读批次超过处理上限');
        prior = await page('limit=100&before=' + snowflake(prior.at(-1)?.id), signal);
        entries.push(...prior.filter(item => BigInt(snowflake(item.id)) > BigInt(cursor)));
      }
      const byId = new Map(entries.filter(item => BigInt(snowflake(item.id)) > BigInt(cursor)).map(item => [snowflake(item.id), item]));
      const ids = [...byId.keys()].sort((a,b) => BigInt(a) < BigInt(b) ? -1 : 1);
      return {updates: ids.map(id => byId.get(id)), cursor: ids.at(-1) ?? cursor};
    },
    async normalize(input, signal) {
      const message = record(input), author = record(message.author);
      if (message.channel_id !== config.conversationId || author.id !== config.peerId || author.bot || message.webhook_id) return null;
      const id = snowflake(message.id);
      if (!id) return null;
      const parts: MessagePart[] = [];
      addText(parts, message.content, 'markdown');
      for (const raw of list(message.attachments).slice(0, 8)) {
        const item = record(raw), mime = normalizeMime(item.content_type);
        const kind = typeof item.duration_secs === 'number' ? 'voice' : mediaKind(mime);
        await addMedia(parts, kind, string(item.filename) || 'discord-file', mime, async remaining => {
          if (typeof item.size === 'number' && item.size > remaining) throw new Error('Discord 附件过大');
          const response = await providerFetch(fetcher, attachmentUrl(item.url), {}, signal);
          return {bytes: await readBounded(response, remaining), mime: normalizeMime(response.headers.get('Content-Type'))};
        }, signal);
      }
      return remoteMessage(config, id, parts);
    },
    async send(message, text, signal) {
      const nonce = createHash('sha256').update(JSON.stringify([config.accountId, message.id])).digest('hex').slice(0, 24);
      const value = record(await providerJson(fetcher, endpoint, jsonPost({
        content: textLimit(text, 1900), nonce, enforce_nonce: true,
        allowed_mentions: {parse: [], replied_user: false},
        message_reference: {message_id: message.id, channel_id: config.conversationId, fail_if_not_exists: false},
      }, headers), signal));
      if (!snowflake(value.id)) throw new Error('Discord 回复未确认');
    },
  };
}
