import {randomUUID} from 'node:crypto';
import {lstatSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {recallNotes} from '../assistant/assistant-memory.js';
import {ToolError} from '../assistant/tool-governance.js';
import type {Store} from '../coordination/contracts.js';

export type MemoryTier = 'work' | 'long-term';
export interface PersonalMemory {
  id: string;
  tier: MemoryTier;
  title: string;
  content: string;
  recall: boolean;
  expiresAt: string | null;
  version: number;
  updatedAt: string;
}

const memoryId = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/;
const invalid = (message: string) => new ToolError('INVALID_ARGUMENTS', message, 'correct_input');
const missing = () => new ToolError('NOT_FOUND', '个人记忆不存在', 'correct_input', {}, 404);

function inputObject(input: unknown): Record<string, unknown> {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw invalid('需要 JSON 对象');
  return input as Record<string, unknown>;
}

function memoryFields(input: Record<string, unknown>) {
  const {title, content, recall = true, expiresAt = null} = input;
  if (typeof title !== 'string' || !title.trim() || title.trim().length > 120) throw invalid('标题应为 1–120 字符');
  if (typeof content !== 'string' || !content.trim() || content.trim().length > 3000) throw invalid('正文应为 1–3000 字符');
  if (typeof recall !== 'boolean') throw invalid('召回设置应为布尔值');
  if (expiresAt !== null && (typeof expiresAt !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(expiresAt) ||
      !Number.isFinite(Date.parse(expiresAt)) || new Date(expiresAt).toISOString() !== expiresAt)) throw invalid('到期时间应为 UTC ISO 8601 或 null');
  return {title: title.trim(), content: content.trim().replace(/\r\n/g, '\n'), recall, expiresAt};
}

function localFiles<T>(action: () => T): T {
  try {
    return action();
  } catch (error) {
    if (error instanceof ToolError) throw error;
    throw new ToolError('PERSONAL_MEMORY_IO', '无法读写本地长期记忆', 'request_owner', {}, 500);
  }
}

function longTermFiles(directory: string) {
  mkdirSync(directory, {recursive: true, mode: 0o700});
  const pathFor = (id: string) => join(directory, id + '.md');

  function read(id: string): PersonalMemory | undefined {
    return localFiles(() => {
      let file;
      try {
        file = lstatSync(pathFor(id));
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
        throw error;
      }
      if (!file.isFile() || file.size > 16384) throw new Error('无效的长期记忆文件');
      const document = readFileSync(pathFor(id), 'utf8');
      const match = /^---\r?\n([^\r\n]+)\r?\n---\r?\n([\s\S]+)$/.exec(document);
      if (!match) throw new Error('无效的长期记忆格式');
      try {
        const {version, updatedAt, ...input} = inputObject(JSON.parse(match[1]!));
        if (!Number.isSafeInteger(version) || Number(version) < 1 || typeof updatedAt !== 'string' || !Number.isFinite(Date.parse(updatedAt))) {
          throw new Error('无效的长期记忆元数据');
        }
        return {id, tier: 'long-term', ...memoryFields({...input, content: match[2]}), version: Number(version), updatedAt};
      } catch {
        throw new Error('无效的长期记忆内容');
      }
    });
  }

  function list() {
    return localFiles(() => {
      const names = readdirSync(directory, {withFileTypes: true});
      return names.flatMap(entry => {
        const id = entry.name.slice(0, -3);
        if (!entry.isFile() || !entry.name.endsWith('.md') || !memoryId.test(id)) return [];
        const saved = read(id);
        return saved ? [saved] : [];
      });
    });
  }

  function save({id, tier: _tier, content, ...metadata}: PersonalMemory) {
    localFiles(() => {
      const temporary = join(directory, randomUUID() + '.tmp');
      try {
        writeFileSync(temporary, '---\n' + JSON.stringify(metadata) + '\n---\n' + content + '\n', {flag: 'wx', mode: 0o600});
        renameSync(temporary, pathFor(id));
      } finally {
        rmSync(temporary, {force: true});
      }
    });
  }

  return {read, list, save, remove: (id: string) => localFiles(() => rmSync(pathFor(id)))};
}

export function createPersonalMemory({db, row, rows, now}: Store, directory: string) {
  db.exec('CREATE TABLE IF NOT EXISTS personal_work_memory(id TEXT PRIMARY KEY, document TEXT NOT NULL CHECK(json_valid(document)))');
  const files = longTermFiles(directory);

  function get(tier: MemoryTier, id: string): PersonalMemory {
    if (!memoryId.test(id)) throw missing();
    const saved = tier === 'work'
      ? row<{document: string}>('SELECT document FROM personal_work_memory WHERE id=?', id)
      : files.read(id);
    if (!saved) throw missing();
    return 'document' in saved ? JSON.parse(saved.document) as PersonalMemory : saved;
  }

  function list(): PersonalMemory[] {
    const work = rows<{document: string}>('SELECT document FROM personal_work_memory').map(record => JSON.parse(record.document) as PersonalMemory);
    return [...work, ...files.list()].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt) || a.id.localeCompare(b.id));
  }

  function assertVersion(expected: unknown, current: number) {
    if (!Number.isSafeInteger(expected) || Number(expected) < 1) throw invalid('请提供当前记忆版本');
    if (expected !== current) throw new ToolError('PERSONAL_MEMORY_CONFLICT', '记忆已更新，请刷新后重试', 'correct_input', {}, 409);
  }

  function save(tier: MemoryTier, raw: unknown, id?: string) {
    const input = inputObject(raw);
    const previous = id ? get(tier, id) : undefined;
    if (previous) assertVersion(input.version, previous.version);
    const fields = memoryFields({recall: previous?.recall, expiresAt: previous?.expiresAt, ...input});
    const record = {id: id ?? randomUUID(), tier, ...fields, version: (previous?.version ?? 0) + 1, updatedAt: now()};
    if (tier === 'work') db.prepare('INSERT INTO personal_work_memory VALUES (?,?) ON CONFLICT(id) DO UPDATE SET document=excluded.document').run(record.id, JSON.stringify(record));
    else files.save(record);
    return record;
  }

  function remove(tier: MemoryTier, id: string, raw: unknown) {
    const input = inputObject(raw);
    assertVersion(input.version, get(tier, id).version);
    if (tier === 'work') db.prepare('DELETE FROM personal_work_memory WHERE id=?').run(id);
    else files.remove(id);
    return {deleted: true};
  }

  function recall(raw: unknown) {
    const {query} = inputObject(raw);
    if (typeof query !== 'string' || query.length > 10000) throw invalid('召回查询应为 0–10000 字符');
    if (!query.trim()) return [];
    const time = now();
    const candidates = list().filter(item => item.recall && (!item.expiresAt || item.expiresAt > time));
    return recallNotes(query, candidates.map(item => ({
      title: item.title, content: item.content, version: item.version, status: 'active',
      kind: item.tier, source: 'owner', updated_at: item.updatedAt, item,
    }))).map(({item, score}) => ({...item, score}));
  }

  function recallForSession(id: string) {
    if (!row('SELECT id FROM assistant_sessions WHERE id=? AND deleted_at IS NULL', id)) {
      throw new ToolError('NOT_FOUND', '会话不存在', 'correct_input', {}, 404);
    }
    const latest = row<{body: string}>("SELECT body FROM assistant_events WHERE session_id=? AND role='user' AND kind='message' ORDER BY id DESC LIMIT 1", id);
    return recall({query: latest ? String(JSON.parse(latest.body).content ?? '').slice(0, 10000) : ''});
  }

  return {get, list, save, remove, recall, recallForSession};
}
