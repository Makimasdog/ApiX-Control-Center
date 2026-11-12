import {createHash} from 'node:crypto';
import {setTimeout as delay} from 'node:timers/promises';
import {object, type Store} from '../../coordination/contracts.js';
import {discordAdapter} from './discord-adapter.js';
import {telegramAdapter} from './telegram-adapter.js';
import {wechatAdapter} from './wechat-adapter.js';
import {ProviderFailure, type RemoteAdapter, type RemoteConfig, type RemoteMessage} from './remote-adapter.js';
import type {ExternalChannel, MessageEnvelope} from './message-format.js';

interface ChannelAssistant {
  createChannelSession(projectId: string, channel: ExternalChannel): string;
  acceptChannelMessage(sessionId: string, envelope: MessageEnvelope): Promise<void>;
}

interface ChannelState {healthy: boolean; lastPollAt: string | null}
const adapters = {wechat: wechatAdapter, telegram: telegramAdapter, discord: discordAdapter};
const keyOf = (...values: string[]) => createHash('sha256').update(JSON.stringify(values)).digest('hex');

function required(config: Record<string, unknown>, name: string) {
  const value = config[name];
  if (typeof value !== 'string' || !value || value.length > 160 || /[\u0000-\u0020\u007f]/.test(value)) {
    throw new Error('渠道配置字段无效：' + name);
  }
  return value;
}

function channelConfigs(raw: string, env: NodeJS.ProcessEnv) {
  const list = JSON.parse(raw) as unknown;
  if (!Array.isArray(list) || list.length > 12) throw new Error('渠道配置应为不超过 12 项的数组');
  const accounts = new Set<string>(), credentials = new Set<string>();
  return list.map<RemoteConfig>(entry => {
    const input = object(entry);
    const channel = input.channel;
    if (channel !== 'wechat' && channel !== 'telegram' && channel !== 'discord') throw new Error('渠道类型无效');
    const accountId = required(input, 'accountId'), peerId = required(input, 'peerId');
    const projectId = required(input, 'projectId'), tokenEnv = required(input, 'tokenEnv');
    const conversationId = channel === 'wechat' ? peerId : required(input, 'conversationId');
    const token = env[tokenEnv] ?? '';
    if (!/^APIX_CHANNEL_[A-Z0-9_]+_TOKEN$/.test(tokenEnv) || token.length < 10 || token.length > 2048 || !/^[A-Za-z0-9_.:+/=-]+$/.test(token)) {
      throw new Error('渠道令牌应通过 APIX_CHANNEL_…_TOKEN 环境变量提供');
    }
    if (channel === 'telegram' && (!/^\d+:[A-Za-z0-9_-]+$/.test(token) || !/^-?\d{1,16}$/.test(conversationId) || !/^\d{1,16}$/.test(peerId))) {
      throw new Error('Telegram 令牌或聊天标识无效');
    }
    if (channel === 'discord' && (!/^\d{1,20}$/.test(conversationId) || !/^\d{1,20}$/.test(peerId))) throw new Error('Discord 标识无效');
    const account = keyOf(channel, accountId), credential = keyOf(channel, token);
    if (accounts.has(account) || credentials.has(credential)) throw new Error('同一渠道账号或令牌只能配置一次');
    accounts.add(account);
    credentials.add(credential);
    return {channel, accountId, projectId, conversationId, peerId, token};
  });
}

export function createChannelRelay(
  {db, row, rows, now}: Store,
  assistant: ChannelAssistant,
  fetcher: typeof fetch = fetch,
) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS assistant_channel_routes (
      route_key TEXT PRIMARY KEY, session_id TEXT REFERENCES assistant_sessions(id), cursor TEXT NOT NULL DEFAULT ''
    );
    CREATE TABLE IF NOT EXISTS assistant_channel_deliveries (
      route_key TEXT NOT NULL REFERENCES assistant_channel_routes(route_key),
      message_id TEXT NOT NULL, state TEXT NOT NULL, updated_at TEXT NOT NULL, PRIMARY KEY(route_key,message_id)
    );
  `);
  let lifecycle: AbortController | undefined;
  let configError = false;
  const states = new Map<string, {config: RemoteConfig; state: ChannelState}>();
  const workers:Promise<void>[]=[];

  function chooseSession(config: RemoteConfig, route: string) {
    const previous = row<{id: string; status: string}>(`
      SELECT s.id,s.status FROM assistant_channel_routes r JOIN assistant_sessions s ON s.id=r.session_id
      WHERE r.route_key=? AND s.deleted_at IS NULL AND s.archived_at IS NULL
    `, route);
    if (previous && ['idle','completed'].includes(previous.status)) return previous.id;
    const id = assistant.createChannelSession(config.projectId, config.channel);
    db.prepare('UPDATE assistant_channel_routes SET session_id=? WHERE route_key=?').run(id, route);
    return id;
  }

  function requestEvent(config: RemoteConfig, requestId: string) {
    return row<{id: number; session_id: string}>(`
      SELECT m.event_id AS id,m.session_id FROM assistant_message_requests m JOIN assistant_sessions s ON s.id=m.session_id
      WHERE m.request_id=? AND s.project_id=? AND s.message_channel=?
    `, requestId, config.projectId, config.channel);
  }

  async function replyFor(event: {id: number; session_id: string}, signal: AbortSignal) {
    const deadline = Date.now() + 120000;
    while (Date.now() < deadline) {
      signal.throwIfAborted();
      const saved = row<{body: string}>(`
        SELECT body FROM assistant_events WHERE session_id=? AND id>? AND role='assistant' AND kind='answer'
          AND EXISTS (SELECT 1 FROM assistant_sessions s WHERE s.id=assistant_events.session_id AND s.archived_at IS NULL AND s.deleted_at IS NULL)
          AND id < coalesce((SELECT min(id) FROM assistant_events WHERE session_id=? AND id>? AND role='user' AND kind='message'),9223372036854775807)
        ORDER BY id LIMIT 1
      `, event.session_id, event.id, event.session_id, event.id);
      if (saved) return String(JSON.parse(saved.body).content);
      if (row<{status: string}>('SELECT status FROM assistant_sessions WHERE id=? AND deleted_at IS NULL', event.session_id)?.status !== 'running') break;
      await delay(250, undefined, {signal});
    }
    return null;
  }

  async function relay(config: RemoteConfig, adapter: RemoteAdapter, route: string, message: RemoteMessage, signal: AbortSignal) {
    if (row('SELECT 1 FROM assistant_channel_deliveries WHERE route_key=? AND message_id=?', route, message.id)) return;
    const id = 'channel:' + keyOf(route, message.id);
    let event = requestEvent(config, id);
    if (!event) {
      const sessionId = chooseSession(config, route);
      await assistant.acceptChannelMessage(sessionId, {...message, id});
      event = requestEvent(config, id);
    }
    const reply = event ? await replyFor(event, signal) : null;
    signal.throwIfAborted();
    const claim = db.prepare('INSERT OR IGNORE INTO assistant_channel_deliveries VALUES (?,?,?,?)')
      .run(route, message.id, reply ? 'sending' : 'no_reply', now());
    if (!claim.changes || !reply) return;
    // 未知出站结果保留给所有者核对，重启后不重复投递。
    let state = 'sent';
    try { await adapter.send(message, reply, signal); }
    catch { state = 'uncertain'; }
    db.prepare('UPDATE assistant_channel_deliveries SET state=?,updated_at=? WHERE route_key=? AND message_id=?')
      .run(state, now(), route, message.id);
  }

  async function run(config: RemoteConfig, route: string, state: ChannelState, signal: AbortSignal) {
    const adapter = adapters[config.channel](config, fetcher);
    db.prepare('INSERT OR IGNORE INTO assistant_channel_routes(route_key) VALUES (?)').run(route);
    let cursor = row<{cursor: string}>('SELECT cursor FROM assistant_channel_routes WHERE route_key=?', route)!.cursor;
    while (!signal.aborted) {
      let wait = config.channel === 'discord' ? 5000 : 1000;
      try {
        const batch = await adapter.poll(cursor, signal);
        for (const item of batch.updates) {
          signal.throwIfAborted();
          const message = await adapter.normalize(item, signal);
          if (message) await relay(config, adapter, route, message, signal);
        }
        if (batch.cursor !== cursor) {
          db.prepare('UPDATE assistant_channel_routes SET cursor=? WHERE route_key=?').run(batch.cursor, route);
          cursor = batch.cursor;
        }
        state.healthy = true;
        state.lastPollAt = now();
      } catch (error) {
        if (signal.aborted) break;
        state.healthy = false;
        if(error instanceof ProviderFailure)wait=Math.max([401,403].includes(error.status)?30000:5000,error.retryMs);
        else wait=5000;
      }
      await delay(wait, undefined, {signal}).catch(error => { if (!signal.aborted) throw error; });
    }
  }

  function start(raw: string, env: NodeJS.ProcessEnv = process.env) {
    if (lifecycle || !raw.trim()) return;
    try {
      const configs = channelConfigs(raw, env);
      for (const config of configs) {
        if (!row('SELECT id FROM projects WHERE id=?', config.projectId)) throw new Error('渠道目标项目不存在');
      }
      lifecycle = new AbortController();
      const {signal} = lifecycle;
      for (const config of configs) {
        const route = keyOf(config.channel, config.accountId, config.projectId, config.conversationId, config.peerId, config.token);
        const state = {healthy: true, lastPollAt: null};
        states.set(route, {config, state});
        workers.push(run(config, route, state, signal).catch(() => { state.healthy = false; }));
      }
    } catch {
      configError = true;
      process.stderr.write('ApiX 消息渠道配置无效，请核对项目与渠道设置。\n');
    }
  }

  function status() {
    return {configurationError: configError, accounts: [...states].map(([route, {config, state}]) => ({
      channel: config.channel, accountId: config.accountId, projectId: config.projectId, ...state,
      recent: rows<{message_id:string;state: string; updated_at: string}>(
        'SELECT message_id,state,updated_at FROM assistant_channel_deliveries WHERE route_key=? ORDER BY updated_at DESC LIMIT 10', route,
      ),
    }))};
  }

  async function stop(){
    lifecycle?.abort();
    await Promise.all(workers);
  }

  return {start, stop, status};
}
