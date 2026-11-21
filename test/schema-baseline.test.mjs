import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync, rmSync} from 'node:fs';
import {join, resolve, dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {bootFreshDatabase, dumpSchema, diffSchema} from '../scripts/schema-snapshot.mjs';

/**
 * Schema 基线守卫
 *
 * 本仓库的建表代码分两套：control-plane.mjs 的迁移块（有版本号，39 张）
 * 和各模块工厂里的无条件 CREATE TABLE IF NOT EXISTS（无版本号，69 张）。
 * 这导致"全新安装的库"和"从旧版本升上来的库"可能不是同一个结构，
 * 而且没有任何地方会发现。
 *
 * 这个测试拿一次真实启动建出的库，和提交在 test/fixtures/schema.snapshot.json
 * 的基线逐表逐列比对。任何新增/删除表、加列、改类型、改索引都会在这里显形，
 * 迫使改动人同时更新基线——基线 diff 就是这次 schema 变更的 review 材料。
 *
 * 更新基线（确认变更是有意的）：
 *   node scripts/schema-snapshot.mjs --boot > test/fixtures/schema.snapshot.json
 */

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const baseline = JSON.parse(readFileSync(join(root, 'test/fixtures/schema.snapshot.json'), 'utf8'));

test('全新启动建出的 schema 必须与提交的基线一致', () => {
  const {dir, path} = bootFreshDatabase();
  let actual;
  try { actual = dumpSchema(path); }
  finally { rmSync(dir, {recursive: true, force: true}); }

  const differences = diffSchema(baseline, actual);
  assert.deepEqual(differences, [],
    `schema 与基线不一致（${differences.length} 处）。若为有意变更，请重新生成基线：\n` +
    '  node scripts/schema-snapshot.mjs --boot > test/fixtures/schema.snapshot.json\n\n' +
    differences.join('\n'));
});

test('基线覆盖全部迁移版本，不能只记录最新一个', () => {
  const versions = baseline.migrations;
  assert(versions.length > 0, '基线缺少 schema_migrations 记录');
  for (let index = 1; index < versions.length; index++) {
    assert.equal(versions[index], versions[index - 1] + 1, `基线迁移版本不连续：${versions[index - 1]} → ${versions[index]}`);
  }
  assert.equal(versions.at(-1), baseline.version || versions.at(-1));
});

// 守卫本身必须能抓到漂移，否则它只是一个永远绿的摆设。
// 这里用构造的差异验证 diffSchema 的判定，不依赖真实数据库。
test('差异判定能识别新增表、新增列、缺失索引和类型变化', () => {
  const sample = {
    version: 14,
    migrations: [1, 2],
    tables: {
      tasks: {columns: [
        {name: 'id', type: 'text', notnull: true, default: null, pk: 1},
        {name: 'status', type: 'text', notnull: true, default: null, pk: 0},
      ]},
    },
    indexes: {tasks_status: {table: 'tasks', sql: 'CREATE INDEX tasks_status ON tasks(status)'}},
  };

  const added = structuredClone(sample);
  added.tables.tasks.columns.push({name: 'plan_id', type: 'text', notnull: false, default: null, pk: 0});
  added.tables.extra = {columns: [{name: 'id', type: 'text', notnull: true, default: null, pk: 1}]};
  assert.deepEqual(diffSchema(sample, added), ['新增表 extra', '表 tasks 新增列 plan_id text']);

  const retyped = structuredClone(sample);
  retyped.tables.tasks.columns[1].type = 'integer';
  assert.deepEqual(diffSchema(sample, retyped), ['表 tasks.status 类型 text → integer']);

  const dropped = structuredClone(sample);
  delete dropped.indexes.tasks_status;
  assert.deepEqual(diffSchema(sample, dropped), ['缺失索引 tasks_status']);

  assert.deepEqual(diffSchema(sample, structuredClone(sample)), [], '相同结构不应报差异');
});
