#!/usr/bin/env node
/**
 * Sweep P0 — 只读巡检器
 *
 * 用法：node scripts/sweep/sweep.mjs scan --repo <路径> [--json <输出>] [--only 规则,规则] [--skip-slow]
 *
 * 边界：只读。不写仓库、不建分支、不派 agent。产出结构化 finding 列表，
 * 交给模型判断和修改；模型改完再由人验证、由人合并。
 */
import { readFileSync, readdirSync, existsSync, statSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, relative, resolve, dirname, extname, sep } from 'node:path';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';

const argv = process.argv.slice(2);
const cmd = argv[0] && !argv[0].startsWith('-') ? argv[0] : 'scan';
function flag(name, def = null) {
  const i = argv.indexOf('--' + name);
  if (i < 0) return def;
  const v = argv[i + 1];
  return !v || v.startsWith('--') ? true : v;
}
const REPO = resolve(flag('repo', '.'));
const JSON_OUT = flag('json', null);
const ONLY = flag('only', null) ? String(flag('only')).split(',') : null;
const SKIP_SLOW = flag('skip-slow', false) === true;

const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', '.tmp', '.tmp-desktop', '.alma-snapshots', '.agents', '.archify', '.claude', 'coverage']);
const CODE_EXT = new Set(['.ts', '.mjs', '.js', '.cjs', '.tsx']);

function walk(dir, out = []) {
  let entries;
  try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const e of entries) {
    if (e.name.startsWith('.') && e.name !== '.github') continue;
    if (SKIP_DIRS.has(e.name)) continue;
    const full = join(dir, e.name);
    if (e.isDirectory()) walk(full, out);
    else if (e.isFile()) out.push(full);
  }
  return out;
}

const rel = p => relative(REPO, p).split(sep).join('/');
const fp = (ruleId, file, anchor) =>
  createHash('sha256').update(`${ruleId}|${file}|${anchor}`).digest('hex').slice(0, 16);

function readPkg() {
  const p = join(REPO, 'package.json');
  return existsSync(p) ? JSON.parse(readFileSync(p, 'utf8')) : null;
}

function run(cmdline, args, timeout = 300000) {
  const r = spawnSync(cmdline, args, { cwd: REPO, encoding: "utf8", timeout, maxBuffer: 20 * 1024 * 1024, shell: false });
  return { ok: r.status === 0, code: r.status, out: (r.stdout || '') + (r.stderr || '') };
}

// ── 检测器 ──────────────────────────────────────────────
// 约定：全部只读；单条失败不能拖垮整轮。

const DETECTORS = [];

/** 结构·未登记的测试文件：scripts.test 是显式清单，漏登记等于永远不跑 */
DETECTORS.push({
  id: 'test.unregistered',
  lane: 'structural',
  cost: 'low',
  async run() {
    const pkg = readPkg();
    if (!pkg) return [];
    const registered = new Set();
    for (const value of Object.values(pkg.scripts || {})) {
      if (typeof value !== 'string' || !/node +--test/.test(value)) continue;
      for (const tok of value.split(/[ \t]+/)) {
        if (/^test\/.+[.](mjs|js|cjs)$/.test(tok)) registered.add(tok);
      }
    }
    const files = walk(join(REPO, 'test'))
      .filter(f => /[.](test|spec)[.](mjs|js|cjs)$/.test(f))
      .map(rel);
    return files
      .filter(f => !registered.has(f))
      .map(f => ({
        ruleId: 'test.unregistered',
        file: f,
        line: null,
        title: `测试文件未登记：${f} 不在 package.json 的 test 清单里`,
        detail: 'node --test 只跑显式列出的文件；未登记 = 永远不会执行。',
        severity: 2,
        confidence: 0.9,
        reproduce: `node --test ${f}`,
        anchor: f,
      }));
  },
});

/** 结构·脚本引用了不存在的文件 / 命令名写错 */
DETECTORS.push({
  id: 'script.missing-file',
  lane: 'structural',
  cost: 'low',
  async run() {
    const pkg = readPkg();
    if (!pkg) return [];
    const out = [];
    for (const [name, value] of Object.entries(pkg.scripts || {})) {
      if (typeof value !== 'string') continue;
      for (const tok of value.split(/[ \t]+/)) {
        if (!/[.](mjs|js|cjs|ts)$/.test(tok) || tok.includes('*') || tok.startsWith('-')) continue;
        if (!existsSync(join(REPO, tok))) {
          out.push({
            ruleId: 'script.missing-file',
            file: 'package.json',
            line: null,
            title: `scripts.${name} 引用了不存在的文件：${tok}`,
            detail: `解析结果：npm run ${name} 会直接失败。`,
            severity: 3,
            confidence: 0.95,
            reproduce: `npm run ${name}`,
            anchor: `${name}|${tok}`,
          });
        }
      }
    }
    return out;
  },
});

/** 结构·dist 孤儿产物 */
DETECTORS.push({
  id: 'dist.stale',
  lane: 'structural',
  cost: 'low',
  async run() {
    if (!existsSync(join(REPO, 'scripts/check-stale-dist.mjs'))) return [];
    const r = run('node', ['scripts/check-stale-dist.mjs'], 120000);
    if (r.ok) return [];
    const text = r.out.trim().split('\n').slice(0, 20).join('\n');
    return [{
      ruleId: 'dist.stale',
      file: 'dist/',
      line: null,
      title: 'dist 存在源码已删除的孤儿产物',
      detail: text,
      severity: 2,
      confidence: 0.9,
      reproduce: 'node scripts/check-stale-dist.mjs',
      anchor: text.slice(0, 200),
    }];
  },
});

/** 文档·相对链接失效 */
DETECTORS.push({
  id: 'doc.brokenlink',
  lane: 'doc',
  cost: 'low',
  async run() {
    const docs = walk(join(REPO, 'docs')).filter(f => extname(f) === '.md');
    const out = [];
    for (const file of docs) {
      const text = readFileSync(file, 'utf8');
      const re = /\[[^\]]*\]\(([^)]+)\)/g;
      let m;
      while ((m = re.exec(text)) !== null) {
        let target = m[1].trim().replace(/^<|>$/g, '');
        if (!target || target.startsWith('#') || target.includes('://') || target.startsWith('alma:')) continue;
        target = target.split('#')[0];
        if (!target) continue;
        try { target = decodeURIComponent(target); } catch {}
        const resolved = resolve(dirname(file), target);
        if (!existsSync(resolved)) {
          out.push({
            ruleId: 'doc.brokenlink',
            file: rel(file),
            line: text.slice(0, m.index).split('\n').length,
            title: `文档链接指向不存在的文件：${m[1]}`,
            detail: `解析路径：${rel(resolved) || resolved}`,
            severity: 1,
            confidence: 0.95,
            reproduce: null,
            anchor: target,
          });
        }
      }
    }
    return out;
  },
});

/** 文档·命令漂移：文档里写的 npm run x 在 package.json 里没有 */
DETECTORS.push({
  id: 'doc.command-drift',
  lane: 'doc',
  cost: 'low',
  async run() {
    const pkg = readPkg();
    if (!pkg) return [];
    const names = new Set(Object.keys(pkg.scripts || {}));
    const docs = walk(join(REPO, 'docs')).filter(f => extname(f) === '.md');
    const out = [];
    for (const file of docs) {
      if (file.includes('归档') || file.includes('redesign') || file.includes('附录')) continue;
      const lines = readFileSync(file, 'utf8').split('\n');
      lines.forEach((line, i) => {
        const re = /npm run ([a-z0-9][a-z0-9:_-]*)/g;
        let m;
        while ((m = re.exec(line)) !== null) {
          if (m[1].length < 3 || m[1].endsWith(':')) continue;
          if (!names.has(m[1])) {
            out.push({
              ruleId: 'doc.command-drift',
              file: rel(file),
              line: i + 1,
              title: `文档引用了不存在的命令：npm run ${m[1]}`,
              detail: line.trim().slice(0, 200),
              severity: 1,
              confidence: 0.8,
              reproduce: `npm run ${m[1]}`,
              anchor: m[1],
            });
          }
        }
      });
    }
    return out;
  },
});

/** 静态·类型错误（跳过慢车道时用 --skip-slow） */
DETECTORS.push({
  id: 'tsc.error',
  lane: 'static',
  cost: 'medium',
  async run() {
    const tsc = join(REPO, 'node_modules/typescript/bin/tsc');
    if (!existsSync(tsc)) return [];
    const r = run('node', [tsc, '--noEmit', '--pretty', 'false'], 600000);
    if (r.ok) return [];
    const out = [];
    for (const line of r.out.split('\n')) {
      const m = /^(.+?)\(([0-9]+),([0-9]+)\): error (TS[0-9]+): (.*)$/.exec(line.trim());
      if (!m) continue;
      const file = m[1].split(/[\\/]/).join('/');
      out.push({
        ruleId: 'tsc.error',
        file,
        line: Number(m[2]),
        title: `${m[4]}: ${m[5]}`.slice(0, 160),
        detail: line.trim().slice(0, 500),
        severity: 3,
        confidence: 0.95,
        reproduce: 'npx tsc --noEmit',
        anchor: `${m[4]}|${m[5]}`,
      });
    }
    return out;
  },
});

/** 静态·lint 错误 */
DETECTORS.push({
  id: 'lint.error',
  lane: 'static',
  cost: 'medium',
  async run() {
    const bin = join(REPO, 'node_modules/eslint/bin/eslint.js');
    if (!existsSync(bin)) return [];
    const r = run('node', [bin, '.', '--quiet', '-f', 'json'], 600000);
    let report;
    try { report = JSON.parse(r.out.slice(r.out.indexOf('['))); } catch { return []; }
    const out = [];
    for (const f of report) {
      const file = rel(f.filePath);
      for (const msg of f.messages || []) {
        if (msg.severity !== 2) continue;
        out.push({
          ruleId: 'lint.error',
          file,
          line: msg.line || null,
          title: `${msg.ruleId || 'eslint'}: ${msg.message}`.slice(0, 160),
          detail: `${file}:${msg.line || '?'} ${msg.message}`.slice(0, 500),
          severity: msg.fatal ? 3 : 2,
          confidence: 0.9,
          reproduce: `npx eslint ${file}`,
          anchor: `${msg.ruleId}|${msg.message}`,
        });
      }
    }
    return out;
  },
});

/** 静态·陈旧 TODO（技术债可见化；默认只报不修） */
DETECTORS.push({
  id: 'todo.stale',
  lane: 'static',
  cost: 'low',
  async run() {
    const roots = ['src', 'web', 'scripts', 'test'].map(d => join(REPO, d)).filter(existsSync);
    const files = roots.flatMap(d => walk(d)).filter(f => CODE_EXT.has(extname(f)) && !f.includes('sweep'));
    const re = /(TODO|FIXME|HACK|XXX)[:：]?[ \t]*(.{0,120})/;
    const out = [];
    for (const file of files) {
      const lines = readFileSync(file, 'utf8').split('\n');
      lines.forEach((line, i) => {
        const m = re.exec(line);
        if (!m) return;
        const cut = line.indexOf('//');
        const trimmed = line.trimStart();
        const commentLine = trimmed.startsWith('*') || trimmed.startsWith('/*');
        if (!((cut >= 0 && m.index >= cut) || commentLine)) return;
        const body = m[2].trim();
        out.push({
          ruleId: 'todo.stale',
          file: rel(file),
          line: i + 1,
          title: `${m[1]}：${body || '（无说明）'}`.slice(0, 160),
          detail: line.trim().slice(0, 300),
          severity: 1,
          confidence: 0.5,
          reproduce: null,
          anchor: `${m[1]}|${body.replace(/[ \t]+/g, ' ')}`,
        });
      });
    }
    return out;
  },
});

// ── 运行 ────────────────────────────────────────────────

function headCommit() {
  const r = run('git', ['rev-parse', '--short', 'HEAD'], 20000);
  return r.ok ? r.out.trim() : 'unknown';
}
function dirtyCount() {
  const r = run('git', ['status', '--porcelain'], 20000);
  return r.ok ? r.out.split('\n').filter(Boolean).length : -1;
}

async function scan() {
  const started = Date.now();
  const stats = [];
  const raw = [];
  for (const d of DETECTORS) {
    if (ONLY && !ONLY.includes(d.id)) continue;
    if (SKIP_SLOW && d.cost === 'high') continue;
    const t = Date.now();
    try {
      const got = (await d.run()) || [];
      for (const f of got) {
        raw.push({ ...f, lane: d.lane, fingerprint: fp(d.id, f.file, f.anchor || f.title) });
      }
      stats.push({ id: d.id, count: got.length, ms: Date.now() - t, ok: true });
    } catch (e) {
      stats.push({ id: d.id, count: 0, ms: Date.now() - t, ok: false, error: String((e && e.message) || e) });
    }
  }

  const seen = new Map();
  for (const f of raw) if (!seen.has(f.fingerprint)) seen.set(f.fingerprint, f);
  const findings = [...seen.values()].sort(
    (a, b) => b.severity - a.severity || b.confidence - a.confidence
  );

  const report = {
    tool: 'sweep',
    phase: 'P0',
    repo: REPO,
    commit: headCommit(),
    dirtyFiles: dirtyCount(),
    startedAt: new Date(started).toISOString(),
    durationMs: Date.now() - started,
    stats,
    totals: {
      findings: findings.length,
      fixable: findings.filter(f => f.reproduce).length,
      byRule: stats.filter(s => s.count),
    },
    findings,
  };

  if (JSON_OUT) {
    const out = JSON_OUT === true
      ? join(REPO, '.tmp/sweep', `${new Date(started).toISOString().replace(/[:.]/g, '-')}.json`)
      : resolve(String(JSON_OUT));
    mkdirSync(dirname(out), { recursive: true });
    writeFileSync(out, JSON.stringify(report, null, 2), 'utf8');
    report.savedTo = out;
  }
  return report;
}

function print(r) {
  const p = (n) => String(n).padStart(3, ' ');
  console.log('');
  console.log(`巡检 ${r.repo}`);
  console.log(`基线 ${r.commit}${r.dirtyFiles > 0 ? ` · 工作区有 ${r.dirtyFiles} 个未提交改动` : ' · 工作区干净'}`);
  console.log(`耗时 ${(r.durationMs / 1000).toFixed(1)}s · 检出 ${r.findings.length} 条（有复现命令 ${r.totals.fixable} 条）`);
  console.log('');
  console.log('按规则：');
  for (const s of r.stats) {
    const flag = s.ok ? '' : `  !! ${s.error}`;
    console.log(`  ${p(s.count)}  ${s.id.padEnd(22)} ${String(s.ms).padStart(6)}ms${flag}`);
  }
  const show = r.findings.slice(0, 30);
  if (show.length) {
    console.log('');
    console.log('前 30 条：');
    for (const f of show) {
      console.log(`  [P${f.severity}] ${f.ruleId}  ${f.file}${f.line ? ':' + f.line : ''}`);
      console.log(`        ${f.title}`);
    }
  }
  if (r.findings.length > show.length) {
    console.log(`  … 另有 ${r.findings.length - show.length} 条，见 JSON 输出`);
  }
  if (r.savedTo) console.log(`\nJSON: ${r.savedTo}`);
  console.log('');
}

if (cmd === 'scan') {
  const report = await scan();
  print(report);
} else {
  console.error(`未知子命令：${cmd}`);
  console.error('用法：node scripts/sweep/sweep.mjs scan --repo <路径> [--json <输出>] [--only a,b] [--skip-slow]');
  process.exit(1);
}
