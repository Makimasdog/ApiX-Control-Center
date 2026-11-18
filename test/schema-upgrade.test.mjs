import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync, rmSync, mkdtempSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join, resolve, dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {DatabaseSync} from 'node:sqlite';
import {bootFreshDatabase, dumpSchema, diffSchema} from '../scripts/schema-snapshot.mjs';

/**
 * 升级路径等价性
 *
 * 这是"schema 单一真源"真正要保证的那件事：
 * 一个从早期版本一路升上来的库，和一个全新装出来的库，结构必须完全相同。
 *
 * 当前实现里这两条路径并不共享代码：
 *   - 全新安装：迁移 1 建基础表 → 迁移 2..14 逐个执行 → 模块工厂各自建表
 *   - 升级安装：基础表**已存在**，迁移 1 的 CREATE TABLE IF NOT EXISTS 整段跳过，
 *              只有后续的 ALTER 生效
 * 也就是说，"迁移 1 的建表语句"和"迁移 2..14 的 ALTER"合起来是否等价于
 * "直接用最新定义建表"，此前从未被验证过。
 *
 * 测试做法：用一个**冻结**的迁移 1 DDL 副本（test/fixtures/schema-v1.sql）
 * 在空库上建出老用户库的真实起点，再让控制平面正常启动把它升到最新，
 * 最后与全新安装的库逐表逐列比对。
 *
 * 为什么起点必须冻结：迁移 1 的 CREATE TABLE IF NOT EXISTS 在老库上整段跳过，
 * 它只影响新装。如果测试从当前源码现取这段 DDL，那么"往迁移 1 加列但忘了写迁移"
 * 会让两条路径一起漂移，测试全绿——守卫就变成了摆设。
 */

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/**
 * migrationOneDdl - 读取冻结的迁移 1 建表语句
 *
 * 关键点：**不能**从 control-plane.mjs 现取。
 * 迁移 1 用的是 CREATE TABLE IF NOT EXISTS，老库里这些表已存在，
 * 所以它的 DDL 在升级路径上根本不会生效——它只影响全新安装。
 * 如果从这里现取，那么"有人往迁移 1 加了一列但没写迁移"时，
 * 两边会一起漂移，测试反而全绿。必须用冻结的历史副本作为起点，
 * 才能让"新装 vs 升级"的差异显形。
 */
function migrationOneDdl() {
  return readFileSync(join(root, 'test/fixtures/schema-v1.sql'), 'utf8')
    .split('\n').filter((line) => !line.trimStart().startsWith('--')).join('\n');
}

/** 建立一个只跑过迁移 1 的数据库 */
function buildVersionOneDatabase() {
  const dir = mkdtempSync(join(tmpdir(), 'apix-schema-v1-'));
  const path = join(dir, 'apix.sqlite');
  const db = new DatabaseSync(path);
  try {
    db.exec('PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON');
    db.exec(migrationOneDdl());
    db.prepare('INSERT OR IGNORE INTO schema_migrations(version) VALUES (1)').run();
  } finally { db.close(); }
  return {dir, path};
}

test('从迁移 1 升级上来的库必须与全新安装的结构完全一致', () => {
  const fresh = bootFreshDatabase();
  const legacy = buildVersionOneDatabase();
  let freshSchema, upgradedSchema;
  try {
    freshSchema = dumpSchema(fresh.path);

    // 起点断言：真实的 v1 形态——只有迁移 1 的基础表，没有任何后续结构
    const before = dumpSchema(legacy.path);
    assert.deepEqual(before.migrations, [1], '回退后应停在版本 1');
    assert(before.tables.projects, '迁移 1 的基础表应存在');
    assert(!before.tables.autonomy_plans, '后续迁移新建的表此时不应存在');
    assert(!before.tables.projects.columns.some((column) => column.name === 'employee_id'), '基础表此时不应有后续迁移加的列');
    assert(!before.tables.runs.columns.some((column) => column.name === 'mailbox_seen_at'), '基础表此时不应有后续迁移加的列');

    // 让控制平面正常启动，把它从 v1 升到最新
    bootFreshDatabase(legacy.dir);
    upgradedSchema = dumpSchema(legacy.path);
  } finally {
    fresh.dispose();
    rmSync(legacy.dir, {recursive: true, force: true});
  }

  const differences = diffSchema(freshSchema, upgradedSchema);
  assert.deepEqual(differences, [],
    `升级路径与全新安装不一致（${differences.length} 处）。\n` +
    '这意味着老用户升级后拿到的表结构和新用户不同，且不会有任何报错。\n\n' +
    differences.join('\n'));
});

test('迁移 1 的 DDL 可被独立执行，说明它不依赖后续迁移', () => {
  const legacy = buildVersionOneDatabase();
  try {
    const schema = dumpSchema(legacy.path);
    assert.deepEqual(schema.migrations, [1]);
    // 迁移 1 应当建出六张基础表（加 schema_migrations 自身）
    for (const name of ['projects', 'tasks', 'approvals', 'runs', 'events', 'artifacts']) {
      assert(schema.tables[name], `迁移 1 应建出 ${name}`);
    }
  } finally { rmSync(legacy.dir, {recursive: true, force: true}); }
});
