import { cpSync, mkdirSync, readFileSync, writeFileSync, rmSync, existsSync, lstatSync } from 'node:fs';
import { resolve, join, dirname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const root = fileURLToPath(new URL('../', import.meta.url));
const stage = join(root, '.tmp-desktop');
if (existsSync(stage) && lstatSync(stage).isSymbolicLink()) throw new Error('构建根目录不能是符号链接。');
if (process.platform !== 'win32' || process.arch !== 'x64') throw new Error('请在 Windows x64 上构建桌面版。');
const [major, minor] = process.versions.node.split('.').map(Number);
if (!(major === 22 && minor >= 19 || major === 24 && minor >= 22)) throw new Error('构建需要 Node.js 22.19–22.x 或 24.22+（24.x）。');
const npm = process.env.npm_execpath;
if (!npm || !existsSync(npm)) throw new Error('请通过 npm run desktop:prepare 执行。');
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));

// Only clear our two fixed staging directories; leave existing release artifacts alone.
for (const name of ['backend', 'shell']) {
  const target = resolve(stage, name);
  if (relative(stage, target) !== name || lstatIfExists(target)?.isSymbolicLink()) throw new Error('构建目录无效。');
  rmSync(target, { recursive: true, force: true });
  mkdirSync(target, { recursive: true });
}
function lstatIfExists(path) { return existsSync(path) ? lstatSync(path) : null; }
const backend = join(stage, 'backend');
for (const name of ['src', 'dist', 'web']) {
  cpSync(join(root, name), join(backend, name), { recursive: true, filter: path => {
    if (lstatSync(path).isSymbolicLink()) throw new Error('运行资源不能包含符号链接：' + path);
    return !/^(?:\.env(?:\..*)?|node_modules|\.git|provider-runtimes|model-credentials\.json(?:\..*)?)$/.test(path.split(/[\\/]/).at(-1));
  } });
}
for (const name of ['server.mjs', 'control-plane.mjs', 'agent-discovery.mjs']) cpSync(join(root, name), join(backend, name));
for (const name of ['package.json', 'package-lock.json', '.env.example', 'LICENSE', 'THIRD_PARTY.md']) cpSync(join(root, name), join(backend, name));
mkdirSync(join(backend, 'runtime'), { recursive: true });
cpSync(process.execPath, join(backend, 'runtime/node.exe'));
const npmRoot = resolve(dirname(npm), '..');
cpSync(npmRoot, join(backend, 'runtime/node_modules/npm'), { recursive: true });
const licenseCache = join(stage, `node-${process.versions.node}-LICENSE.txt`);
if (!existsSync(licenseCache)) {
  const response = await fetch(`https://raw.githubusercontent.com/nodejs/node/v${process.versions.node}/LICENSE`, { signal: AbortSignal.timeout(30000) });
  if (!response.ok) throw new Error('无法下载当前 Node 版本的许可证：' + response.status);
  writeFileSync(licenseCache, await response.text());
}
cpSync(licenseCache, join(backend, 'runtime/NODE-LICENSE.txt'));
execFileSync(process.execPath, [npm, 'ci', '--omit=dev', '--ignore-scripts', '--no-audit', '--no-fund'], { cwd: backend, stdio: 'inherit' });
for (const name of ['main.cjs', 'backend.cjs']) cpSync(join(root, 'desktop', name), join(stage, 'shell', name));
writeFileSync(join(stage, 'shell/package.json'), JSON.stringify({ name: pkg.name, version: pkg.version, description: pkg.description, license: pkg.license, author: 'ApiX', main: 'main.cjs' }, null, 2) + '\n');
console.log('桌面资源已准备：' + stage);
