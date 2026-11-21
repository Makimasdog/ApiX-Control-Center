import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync, readdirSync, statSync} from 'node:fs';
import {join, resolve, dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {moduleSchemas, moduleSchemaKeys} from '../dist/src/infrastructure/schema.js';

/**
 * 单一真源守卫
 *
 * 模块建表语句已集中到 src/infrastructure/schema.ts。这个测试防止改造被慢慢侵蚀：
 * 只要有人在模块里重新内联 CREATE TABLE，就会失败。
 *
 * 允许的例外只有 knowledge-base.ts 的 kb_fts——FTS5 虚拟表的建表语句
 * 取决于当前 SQLite 是否编译了 FTS5，属于运行时能力探测。
 */

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/**
 * 只扫描本工作区的生产运行时代码。
 *
 * 排除项都是「不是当前源码」的东西：构建产物、测试夹具、评测脚本、
 * 以及 .tmp-* 下的历史快照（.tmp-desktop 是旧打包副本，不属于本工作区）。
 */
const EXCLUDED = new Set(['node_modules', 'dist', '.git', '.tmp', '.archify', '.agents', 'test', 'scripts', 'desktop', 'docs', '协作']);
function collectSources(directory, found = []) {
  for (const entry of readdirSync(directory)) {
    if (EXCLUDED.has(entry) || entry.startsWith('.tmp-')) continue;
    const path = join(directory, entry);
    if (statSync(path).isDirectory()) collectSources(path, found);
    else if (/\.(mjs|ts)$/.test(path)) found.push(path);
  }
  return found;
}

test('模块源码中不得内联 CREATE TABLE（kb_fts 除外）', () => {
  const offenders = [];
  for (const path of collectSources(root)) {
    const relativePath = path.replace(root, '').replaceAll('\\', '/');
    // 这两处是设计上的例外：
    //   schema.ts   —— 集中存放模块 DDL 的注册表本身
    //   control-plane.mjs —— 版本化迁移块（迁移 1..14），有 schema_migrations 管版本，
    //                        与模块表是两套机制，不属于本守卫的约束范围
    if (relativePath === '/src/infrastructure/schema.ts') continue;
    if (relativePath === '/control-plane.mjs') continue;
    const source = readFileSync(path, 'utf8');
    for (const match of source.matchAll(/CREATE TABLE\s+(?:IF NOT EXISTS\s+)?([a-zA-Z_][a-zA-Z0-9_]*)/g)) {
      // kb_fts 是 FTS5 能力探测，按设计保留在模块内
      if (match[1] === 'kb_fts') continue;
      // 注册表自身的引导建表在 schema.ts 的 ensureModuleSchema 内，不在此文件
      offenders.push(`${relativePath}: ${match[0]}`);
    }
  }
  assert.deepEqual(offenders, [],
    '发现内联建表语句。请把 DDL 移到 src/infrastructure/schema.ts 并用 ensureModuleSchema 引用：\n' +
    offenders.join('\n'));
});

test('注册表覆盖全部模块表，且键唯一', () => {
  assert(moduleSchemaKeys.length >= 35, `注册表块数异常：${moduleSchemaKeys.length}`);
  assert.equal(new Set(moduleSchemaKeys).size, moduleSchemaKeys.length, '注册表存在重复键');

  // 注册表里的每张表都必须能在其中找到，且不允许重复声明
  const declared = new Map();
  for (const key of moduleSchemaKeys) {
    for (const match of moduleSchemas[key].matchAll(/CREATE TABLE\s+(?:IF NOT EXISTS\s+)?([a-zA-Z_][a-zA-Z0-9_]*)/g)) {
      const owners = declared.get(match[1]) ?? [];
      owners.push(key);
      declared.set(match[1], owners);
    }
  }
  const duplicated = [...declared].filter(([, owners]) => owners.length > 1);
  assert.deepEqual(duplicated, [], `同一张表在注册表中被多处声明：${JSON.stringify(duplicated)}`);
  assert(declared.size >= 60, `注册表声明的表数异常：${declared.size}`);
});

test('ensureModuleSchema 对未知键报错，对相同内容不重复执行', async () => {
  const {DatabaseSync} = await import('node:sqlite');
  const {ensureModuleSchema} = await import('../dist/src/infrastructure/schema.js');
  const db = new DatabaseSync(':memory:');
  try {
    assert.throws(() => ensureModuleSchema(db, '不存在的模块'), /未知的模块 schema/);

    // 第一次应执行，第二次因哈希一致而跳过
    const first = ensureModuleSchema(db, 'coordination-workflow');
    assert.equal(first, true, '首次应执行 DDL');
    const second = ensureModuleSchema(db, 'coordination-workflow');
    assert.equal(second, false, '相同内容不应重复执行');
    assert(db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='apix_workflows'").get(), '表应已建立');
  } finally { db.close(); }
});
