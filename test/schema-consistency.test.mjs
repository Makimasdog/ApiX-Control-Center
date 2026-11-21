import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync, readdirSync, statSync} from 'node:fs';
import {join, resolve, dirname} from 'node:path';
import {fileURLToPath} from 'node:url';

/**
 * Schema 漂移守卫
 *
 * 本仓库有 100+ 张表，DDL 分散在 control-plane.mjs 与 src/** 下 30 多个模块里，
 * 每处都用 CREATE TABLE IF NOT EXISTS 各自声明。谁先执行决定最终列集，
 * 后执行的同名不同列 DDL 会被静默忽略——这类漂移没有任何运行时提示。
 *
 * 这个测试不要求把 schema 收敛到单一文件（那是更大的改造），
 * 只保证一件事：同一个表名不允许出现列定义不一致的声明。
 * 一旦有人给某张表加列却只改了一处，这里会直接失败。
 */

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/**
 * 只扫描生产运行时代码（control-plane.mjs + src/ + web/ + server.mjs）。
 * 测试夹具与评测脚本里的 DDL 是各自需要的最小子集，参与比较只会产生噪声；
 * 其它 worktree（.agents/）也不属于本工作区。
 */
function collectSources(directory, found = []) {
  for (const entry of readdirSync(directory)) {
    if (['node_modules', 'dist', '.git', '.tmp', '.archify', 'test', 'scripts', 'desktop', '.agents', 'docs', '协作'].includes(entry)) continue;
    const path = join(directory, entry);
    const stat = statSync(path);
    if (stat.isDirectory()) collectSources(path, found);
    else if (/\.(mjs|ts)$/.test(path)) found.push(path);
  }
  return found;
}

/** 从 `CREATE TABLE` 的 `(` 开始做括号配对，取到匹配的 `)` */
function readColumnBody(source, openIndex, path) {
  let depth = 0;
  for (let index = openIndex; index < source.length; index++) {
    const char = source[index];
    if (char === '(') depth++;
    else if (char === ')') {
      depth--;
      if (depth === 0) return source.slice(openIndex + 1, index);
    }
  }
  throw new Error(`${path}: CREATE TABLE 括号未闭合`);
}

/** 按顶层逗号切分列定义（跳过 CHECK(...) 之类的嵌套括号） */
function splitColumns(body) {
  const parts = [];
  let depth = 0, current = '';
  for (const char of body) {
    if (char === '(') depth++;
    if (char === ')') depth--;
    if (char === ',' && depth === 0) { parts.push(current); current = ''; continue; }
    current += char;
  }
  if (current.trim()) parts.push(current);
  return parts;
}

function declarations() {
  const tables = new Map();
  for (const path of collectSources(root)) {
    const source = readFileSync(path, 'utf8');
    const pattern = /CREATE TABLE\s+(?:IF NOT EXISTS\s+)?([a-zA-Z_][a-zA-Z0-9_]*)\s*\(/g;
    for (const match of source.matchAll(pattern)) {
      const name = match[1];
      const body = readColumnBody(source, match.index + match[0].length - 1, path);
      // 只比较列名与类型，忽略约束顺序、默认值等表述差异
      const columns = splitColumns(body)
        .map((part) => part.trim().replace(/\s+/g, ' '))
        .filter((part) => part && !/^(PRIMARY KEY|UNIQUE|FOREIGN KEY|CHECK|CONSTRAINT)\b/i.test(part))
        .map((part) => part.split(' ').slice(0, 2).join(' ').toLowerCase())
        .filter(Boolean)
        .sort();
      const entry = tables.get(name) ?? {columns: new Map(), files: []};
      entry.files.push(path.replace(root, '').replaceAll('\\', '/'));
      for (const column of columns) {
        const owners = entry.columns.get(column) ?? new Set();
        owners.add(path.replace(root, '').replaceAll('\\', '/'));
        entry.columns.set(column, owners);
      }
      tables.set(name, entry);
    }
  }
  return tables;
}

test('同名表的多处声明必须列定义一致', () => {
  const tables = declarations();
  assert(tables.size > 50, '表数量异常，说明 DDL 扫描没有覆盖到源码');
  const conflicts = [];
  for (const [name, entry] of tables) {
    if (entry.files.length < 2) continue;
    // 同一张表在不同文件里声明时，列集合必须完全相同
    const perFile = new Map();
    for (const [column, owners] of entry.columns) {
      for (const owner of owners) {
        const set = perFile.get(owner) ?? new Set();
        set.add(column);
        perFile.set(owner, set);
      }
    }
    const signatures = new Set([...perFile.values()].map((set) => [...set].sort().join('|')));
    if (signatures.size > 1) {
      conflicts.push({table: name, declarations: Object.fromEntries([...perFile].map(([file, set]) => [file, [...set].sort()]))});
    }
  }
  assert.deepEqual(conflicts, [], `发现 schema 漂移：${JSON.stringify(conflicts, null, 2)}`);
});

test('迁移版本必须从 1 连续到当前最新，不能跳号或重复登记', () => {
  const source = readFileSync(join(root, 'control-plane.mjs'), 'utf8');
  const versions = new Set();
  for (const match of source.matchAll(/INSERT (?:OR IGNORE )?INTO schema_migrations(?:\(version\))? VALUES \((\d+)\)/g)) versions.add(Number(match[1]));
  for (const match of source.matchAll(/version=(\d+)/g)) versions.add(Number(match[1]));
  const sorted = [...versions].sort((a, b) => a - b);
  assert.equal(sorted[0], 1, '迁移版本必须从 1 开始');
  for (let index = 1; index < sorted.length; index++) {
    assert.equal(sorted[index], sorted[index - 1] + 1, `迁移版本不连续：缺少 ${sorted[index - 1] + 1}`);
  }
});

test('core tables 在迁移 14 之后具备查询索引', () => {
  const source = readFileSync(join(root, 'control-plane.mjs'), 'utf8');
  for (const expected of ['events_run', 'artifacts_run', 'tasks_project_status', 'tasks_plan', 'runs_task']) {
    assert.match(source, new RegExp(`CREATE INDEX IF NOT EXISTS ${expected}\\b`), `缺少索引 ${expected}`);
  }
});
