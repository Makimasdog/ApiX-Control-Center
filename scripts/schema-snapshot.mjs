/**
 * schema-snapshot.mjs - 导出某个数据库文件的规范化 schema
 *
 * 为什么需要它：
 *   ApiX 的建表代码分散在 control-plane.mjs 的迁移块（39 张）和各模块工厂里
 *   （69 张），且模块建表每次启动无条件执行。没有一份可提交的快照，
 *   就意味着"新增一张表/一列"在 review 里几乎看不出来，也无从比对
 *   "全新安装"和"升级上来的库"是不是同一个东西。
 *
 * 这个脚本只读取，不修改任何数据库：
 *   1. --dump <dbPath>：把该库的 schema 打成规范化 JSON 输出到 stdout
 *   2. --boot <dataDir>：用指定数据目录启动一次控制平面，建出干净的库
 *
 * 规范化后只保留结构性内容（表、列、类型、非空/默认、索引），
 * 忽略创建顺序与注释，便于提交和 diff。
 */
import {spawnSync} from 'node:child_process';
import {mkdtempSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join, resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {DatabaseSync} from 'node:sqlite';

const root = resolve(import.meta.dirname, '..');

/**
 * dumpSchema - 读取 sqlite_master 与 PRAGMA，输出规范化结构
 * @param {string} path - 数据库文件路径
 * @returns {{version:number,tables:Object,indexes:Object}}
 */
export function dumpSchema(path) {
  const db = new DatabaseSync(path, {readOnly: true});
  try {
    const version = db.prepare('PRAGMA user_version').get().user_version ?? 0;
    const migrations = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='schema_migrations'").get() ? db.prepare('SELECT version FROM schema_migrations ORDER BY version').all().map(row => row.version) : [];
    const tables = {};
    for (const table of db.prepare("SELECT name,sql FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all()) {
      // 虚拟表（FTS5）没有列级 PRAGMA 语义，单独记录其建表语句
      if (/^CREATE VIRTUAL TABLE/i.test(table.sql ?? '')) {
        tables[table.name] = {virtual: true, sql: normalizeSql(table.sql)};
        continue;
      }
      const columns = db.prepare(`PRAGMA table_info("${table.name}")`).all()
        .map(column => ({
          name: column.name,
          type: String(column.type ?? '').toLowerCase(),
          notnull: Number(column.notnull) === 1,
          default: column.dflt_value === null ? null : String(column.dflt_value).replace(/\s+/g, ' ').trim(),
          pk: Number(column.pk),
        }))
        .sort((a, b) => a.name.localeCompare(b.name));
      tables[table.name] = {columns, migrations: []};
    }
    const indexes = {};
    for (const index of db.prepare("SELECT name,tbl_name,sql FROM sqlite_master WHERE type='index' AND sql IS NOT NULL ORDER BY name").all()) {
      indexes[index.name] = {table: index.tbl_name, sql: normalizeSql(index.sql)};
    }
    return {version, migrations, tables, indexes};
  } finally {
    db.close();
  }
}

/** normalizeSql - 折叠空白与大小写差异，只保留结构信息 */
function normalizeSql(sql) {
  return String(sql ?? '').replace(/\s+/g, ' ').replace(/\s*([(),])\s*/g, '$1').trim();
}

/**
 * diffSchema - 比较两份规范化 schema，返回人类可读的差异列表
 *
 * 只比较结构（表/列/类型/非空/默认/索引），忽略创建顺序。
 * 空数组代表结构一致。
 * @param {ReturnType<typeof dumpSchema>} expected
 * @param {ReturnType<typeof dumpSchema>} actual
 * @returns {string[]}
 */
export function diffSchema(expected, actual) {
  const differences = [];
  const expectedTables = new Set(Object.keys(expected.tables));
  const actualTables = new Set(Object.keys(actual.tables));

  for (const name of actualTables) if (!expectedTables.has(name)) differences.push(`新增表 ${name}`);
  for (const name of expectedTables) if (!actualTables.has(name)) differences.push(`缺失表 ${name}`);

  for (const name of [...expectedTables].filter((value) => actualTables.has(value))) {
    const before = expected.tables[name];
    const after = actual.tables[name];
    if (before.virtual || after.virtual) {
      if (before.sql !== after.sql) differences.push(`虚拟表 ${name} 定义变化`);
      continue;
    }
    const beforeColumns = new Map(before.columns.map((column) => [column.name, column]));
    const afterColumns = new Map(after.columns.map((column) => [column.name, column]));
    for (const [column, definition] of afterColumns) {
      const previous = beforeColumns.get(column);
      if (!previous) { differences.push(`表 ${name} 新增列 ${column} ${definition.type}`); continue; }
      if (previous.type !== definition.type) differences.push(`表 ${name}.${column} 类型 ${previous.type} → ${definition.type}`);
      if (previous.notnull !== definition.notnull) differences.push(`表 ${name}.${column} NOT NULL ${previous.notnull} → ${definition.notnull}`);
      if (previous.default !== definition.default) differences.push(`表 ${name}.${column} 默认值 ${previous.default} → ${definition.default}`);
    }
    for (const column of beforeColumns.keys()) if (!afterColumns.has(column)) differences.push(`表 ${name} 缺失列 ${column}`);
  }

  for (const [name, index] of Object.entries(actual.indexes)) {
    const previous = expected.indexes[name];
    if (!previous) differences.push(`新增索引 ${name}`);
    else if (previous.sql !== index.sql) differences.push(`索引 ${name} 定义变化`);
  }
  for (const name of Object.keys(expected.indexes)) if (!actual.indexes[name]) differences.push(`缺失索引 ${name}`);

  if (expected.version !== actual.version) differences.push(`user_version ${expected.version} → ${actual.version}`);
  return differences;
}

/**
 * bootFreshDatabase - 启动一次控制平面，得到（或升级）一个数据库
 *
 * 用脚本子进程而不是 import：控制平面在模块顶层就会建库、扫描外部 Agent，
 * 在同一进程里连续启动两次会互相干扰。
 * @param {string} [dataDir] - 复用既有数据目录（用于验证升级路径）；省略则新建临时目录
 * @returns {{dir:string,path:string,dispose:()=>void}}
 */
export function bootFreshDatabase(dataDir) {
  const reuse = Boolean(dataDir);
  const dir = dataDir ?? mkdtempSync(join(tmpdir(), 'apix-schema-'));
  const path = join(dir, 'apix.sqlite');
  // 用临时入口文件而不是 --eval：控制平面顶层有 await，需要真正的模块入口
  const entry = join(dir, 'boot.mjs');
  writeFileSync(entry, `process.env.APIX_DATA_DIR=${JSON.stringify(dir)};\nawait import(${JSON.stringify(pathToFileURL(join(root, 'control-plane.mjs')).href)});\n`);
  const result = spawnSync(process.execPath, [entry], {
    cwd: root, encoding: 'utf8', timeout: 120000, windowsHide: true,
    env: {...process.env, APIX_DATA_DIR: dir, APIX_LEGACY_API: '0'},
  });
  if (result.status !== 0) {
    rmSync(dir, {recursive: true, force: true});
    throw new Error(`控制平面启动失败：${(result.stderr ?? '').slice(-2000) || result.error}`);
  }
  // 复用目录时不要删掉调用方的数据；只有自建目录才负责清理
  return {dir, path, dispose: () => { if (!reuse) rmSync(dir, {recursive: true, force: true}); }};
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(import.meta.filename)) {
  const [mode, target] = process.argv.slice(2);
  if (mode === '--dump' && target) {
    process.stdout.write(JSON.stringify(dumpSchema(target), null, 2) + '\n');
  } else if (mode === '--boot') {
    const booted = bootFreshDatabase();
    try { process.stdout.write(JSON.stringify(dumpSchema(booted.path), null, 2) + '\n'); }
    finally { booted.dispose(); }
  } else {
    process.stderr.write('用法: node scripts/schema-snapshot.mjs --dump <dbPath> | --boot\n');
    process.exit(2);
  }
}
