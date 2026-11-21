import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {createHash, randomUUID} from 'node:crypto';
import {existsSync, mkdirSync, mkdtempSync, readFileSync, rmdirSync, symlinkSync, unlinkSync, writeFileSync} from 'node:fs';
import {createRequire} from 'node:module';
import {dirname, join, resolve} from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {setTimeout as delay} from 'node:timers/promises';
import {build, Platform} from 'electron-builder';

const require = createRequire(import.meta.url);
const repo = resolve('.');
const historical = '8b754efeffd363535da60beca36b5eb2685f133c';
const exec = (file, args, options = {}) => execFileSync(file, args, {
  encoding: 'utf8', windowsHide: true, timeout: 180000, ...options,
});
const sha = file => existsSync(file) ? createHash('sha256').update(readFileSync(file)).digest('hex') : null;
const json = file => JSON.parse(readFileSync(file, 'utf8'));
const system = join(process.env.SystemRoot, 'System32');
const powershell = join(system, 'WindowsPowerShell/v1.0/powershell.exe');
const uninstallRoot = 'Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\';

function readKey(key) {
  try {
    return exec(join(system, 'reg.exe'), ['query', key, '/reg:64'], {stdio: ['ignore', 'pipe', 'ignore']}).trim();
  } catch (error) {
    if (error.status === 1) return null;
    throw error;
  }
}

function getValue(key, field) {
  return key?.split(/\r?\n/).map(line => line.trim().split(/\s{2,}/))
    .find(parts => parts[0] === field)?.[2];
}

function currentShellFolders() {
  return JSON.parse(exec(powershell, ['-NoProfile', '-NonInteractive', '-Command',
    '[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false); [ordered]@{ desktop=[Environment]::GetFolderPath("DesktopDirectory"); programs=[Environment]::GetFolderPath("Programs"); roaming=[Environment]::GetFolderPath("ApplicationData"); local=[Environment]::GetFolderPath("LocalApplicationData") } | ConvertTo-Json -Compress']));
}

function dataFingerprint(directory) {
  return Object.fromEntries(['apix.sqlite', 'apix.sqlite-wal', '.env', 'owner-access.json', 'marker.txt']
    .map(name => [name, sha(join(directory, name))]));
}

function productionFingerprint(folders) {
  const {UUID} = require('builder-util-runtime');
  const guid = UUID.v5('local.apix.controlcenter', UUID.parse('50e065bc-3134-11e6-9bab-38c9862bdaf3'));
  return {
    registration: ['HKCU', 'HKLM'].flatMap(hive => [
      readKey(hive + '\\Software\\' + guid),
      readKey(hive + '\\' + uninstallRoot + guid),
    ]),
    shortcuts: [folders.desktop, folders.programs].map(path => sha(join(path, 'ApiX Control Center.lnk'))),
    data: ['ApiX-Control-Center', 'ApiX-Control-Center-Dev']
      .map(name => dataFingerprint(join(folders.roaming, name))),
  };
}

async function buildInstaller({root, revision, version, identity, guid, cache}) {
  const source = join(root, 'source-' + version);
  mkdirSync(source);
  const archive = join(source, 'source.tar');
  exec('git', ['archive', revision, '-o', archive, '--', 'src', 'web', 'desktop', 'scripts',
    'server.mjs', 'control-plane.mjs', 'agent-discovery.mjs', 'package.json', 'package-lock.json',
    'tsconfig.json', '.env.example', 'LICENSE', 'THIRD_PARTY.md']);
  exec('tar.exe', ['-xf', archive, '-C', source]);
  symlinkSync(join(repo, 'node_modules'), join(source, 'node_modules'), 'junction');
  const license = `node-${process.versions.node}-LICENSE.txt`;
  const staged = join(source, '.tmp-desktop');
  mkdirSync(staged);
  const knownLicense = join(repo, '.tmp-desktop', license);
  if (existsSync(knownLicense)) writeFileSync(join(staged, license), readFileSync(knownLicense));
  exec(process.execPath, [process.env.npm_execpath, 'run', 'desktop:prepare'], {
    cwd: source, stdio: 'inherit', timeout: 360000,
    env: {...process.env, npm_config_cache: cache, npm_config_prefer_offline: 'true'},
  });
  const config = require(join(source, 'desktop/electron-builder.cjs'));
  assert.equal(config.nsis.perMachine, false);
  assert.equal(config.nsis.runAfterFinish, false);
  assert.equal(config.nsis.deleteAppDataOnUninstall, false);
  const output = join(root, 'packages-' + version);
  await build({
    projectDir: source, targets: Platform.WINDOWS.createTarget(['nsis']),
    publish: 'never',
    config: {
      ...config,
      appId: 'local.apix.' + identity,
      productName: identity,
      executableName: identity,
      extraMetadata: {name: identity, version},
      directories: {...config.directories, output},
      electronDist: join(repo, 'node_modules/electron/dist'),
      win: {...config.win, artifactName: identity + '-${version}-${arch}.${ext}'},
      nsis: {...config.nsis, guid, shortcutName: identity},
    },
  });
  const installer = join(output, identity + '-' + version + '-x64.exe');
  assert(existsSync(installer));
  return {installer, version, revision, sha256: sha(installer)};
}

async function runSmoke(app, data, project) {
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) =>
    /^(SystemRoot|WINDIR|ComSpec|OS|PROCESSOR_ARCHITECTURE|NUMBER_OF_PROCESSORS|SystemDrive)$/i.test(key)));
  const scratch = join(dirname(data), 'process');
  mkdirSync(scratch, {recursive: true});
  const result = join(data, 'smoke-result.json');
  if (existsSync(result)) unlinkSync(result);
  exec(app, ['--smoke-test'], {
    cwd: dirname(app),
    env: {...env, PATH: system, TEMP: scratch, TMP: scratch, USERPROFILE: scratch,
      APPDATA: scratch, LOCALAPPDATA: scratch, APIX_DESKTOP_DATA_DIR: data,
      ...(project ? {APIX_DESKTOP_SMOKE_PROJECT: project} : {})},
    timeout: 90000,
  });
  const report = json(result);
  assert.equal(report.error, undefined, report.error);
  assert.equal(report.apiStatus, 200);
  assert.deepEqual(report.rendererErrors, []);
  assert(report.assets.every(asset => asset.status === 200));
  assert.equal(report.nodeExposed, false);
  assert.throws(() => process.kill(report.supervisorPid, 0), {code: 'ESRCH'});
  await assert.rejects(fetch(report.url, {signal: AbortSignal.timeout(2000)}));
}

function databaseRows(data) {
  const db = new DatabaseSync(join(data, 'apix.sqlite'), {readOnly: true});
  try {
    assert.equal(db.prepare('PRAGMA quick_check').get().quick_check, 'ok');
    return {
      projects: db.prepare('SELECT id, name, path FROM projects ORDER BY id').all(),
      sessions: db.prepare('SELECT id, project_id FROM assistant_sessions ORDER BY id').all(),
    };
  } finally {
    db.close();
  }
}

async function main() {
  assert.equal(process.platform, 'win32');
  assert.equal(process.arch, 'x64');
  assert(process.env.npm_execpath, '请通过 npm run test:desktop:installer 执行');
  const parent = resolve('.tmp/installer-verification');
  mkdirSync(parent, {recursive: true});
  const root = mkdtempSync(join(parent, 'run-'));
  const guid = randomUUID();
  const identity = 'apix-installer-test-' + guid.slice(0, 12);
  const install = join(root, identity);
  const data = join(root, 'isolated-data');
  const app = join(install, identity + '.exe');
  const key = 'HKCU\\Software\\' + guid;
  const uninstallKey = 'HKCU\\' + uninstallRoot + guid;
  const folders = currentShellFolders();
  const shortcuts = [folders.desktop, folders.programs].map(path => join(path, identity + '.lnk'));
  const cachedInstaller = join(folders.local, identity + '-updater', 'installer.exe');
  const roamingMarker = join(folders.roaming, identity, 'preserve-marker.txt');
  const original = productionFingerprint(folders);
  const report = {root, identity, guid, paidModelCalls: 0, packages: [], checks: []};
  const save = () => writeFileSync(join(root, 'report.json'), JSON.stringify(report, null, 2));
  console.log('隔离安装器验收目录', root);
  try {
    assert.equal(readKey(key), null);
    assert.equal(readKey(uninstallKey), null);
    assert(shortcuts.every(path => !existsSync(path)));
    assert(!existsSync(cachedInstaller));
    const cache = process.env.npm_config_cache ?? join(root, 'npm-cache');
    const candidate = exec('git', ['rev-parse', 'HEAD']).trim();
    for (const [revision, version] of [[historical, '0.3.2'], [candidate, '0.3.3']]) {
      report.packages.push(await buildInstaller({root, revision, version, identity, guid, cache}));
      save();
    }
    const [before, after] = report.packages;
    mkdirSync(dirname(roamingMarker));
    writeFileSync(roamingMarker, identity, {flag: 'wx'});
    const installPackage = ({installer, version, sha256}) => {
      // NSIS requires the final /D argument verbatim, even when its path contains spaces.
      exec(installer, ['/S', '/currentuser', '/D=' + install], {
        windowsVerbatimArguments: true, argv0: '"' + installer + '"', timeout: 600000,
      });
      assert.equal(resolve(getValue(readKey(key), 'InstallLocation')), install);
      assert.equal(getValue(readKey(uninstallKey), 'DisplayVersion'), version);
      assert.equal(getValue(readKey(uninstallKey), 'DisplayName'), identity + ' ' + version);
      assert.equal(readKey('HKLM\\' + uninstallRoot + guid), null);
      assert(existsSync(app));
      assert(shortcuts.every(existsSync));
      assert(!existsSync(join(install, 'resources/backend/.env')));
      assert.equal(sha(cachedInstaller), sha256);
    };
    installPackage(before);
    const oldAsar = sha(join(install, 'resources/app.asar'));
    const project = join(root, 'fixture-project');
    mkdirSync(project);
    mkdirSync(join(project, 'src'));
    mkdirSync(join(project, 'test'));
    writeFileSync(join(project, 'src/value.cjs'), 'module.exports=42;\n');
    writeFileSync(join(project, 'test/check.cjs'), "require('node:assert/strict').equal(require('../src/value.cjs'),42);\n");
    writeFileSync(join(project, 'package.json'), JSON.stringify({name: 'installer-fixture', version: '1.0.0', private: true, scripts: {test: 'node test/check.cjs'}}));
    writeFileSync(join(project, 'package-lock.json'), JSON.stringify({name: 'installer-fixture', version: '1.0.0', lockfileVersion: 3, packages: {'': {name: 'installer-fixture', version: '1.0.0'}}}));
    await runSmoke(app, data, project);
    const rows = databaseRows(data);
    assert.equal(rows.projects.length, 1);
    assert.equal(rows.sessions.length, 1);
    writeFileSync(join(data, 'marker.txt'), identity);
    const seeded = dataFingerprint(data);
    report.checks.push('clean-install-registered-shortcuts-and-app-start');
    save();

    installPackage(after);
    assert.notEqual(sha(join(install, 'resources/app.asar')), oldAsar);
    assert.deepEqual(dataFingerprint(data), seeded);
    await runSmoke(app, data);
    assert.deepEqual(databaseRows(data), rows);
    const upgraded = dataFingerprint(data);
    for (const name of ['.env', 'owner-access.json', 'marker.txt']) assert.equal(upgraded[name], seeded[name]);
    report.checks.push('upgrade-replaces-app-and-retains-project-session-and-config');
    save();

    const uninstaller = join(install, 'Uninstall ' + identity + '.exe');
    assert.equal(getValue(readKey(uninstallKey), 'UninstallString'), '"' + uninstaller + '" /currentuser');
    exec(uninstaller, ['/S', '/currentuser']);
    const deadline = Date.now() + 180000;
    while ((existsSync(install) || readKey(uninstallKey)) && Date.now() < deadline) await delay(250);
    assert(!existsSync(install), '卸载后安装目录仍存在');
    assert.equal(readKey(key), null);
    assert.equal(readKey(uninstallKey), null);
    assert(shortcuts.every(path => !existsSync(path)));
    assert(!existsSync(cachedInstaller), '卸载后安装器缓存仍存在');
    assert.deepEqual(dataFingerprint(data), upgraded);
    assert.deepEqual(databaseRows(data), rows);
    assert.equal(readFileSync(roamingMarker, 'utf8'), identity);
    unlinkSync(roamingMarker);
    rmdirSync(dirname(roamingMarker));
    report.checks.push('uninstall-removes-app-registration-shortcuts-and-installer-cache-retains-data');
    assert(JSON.stringify(productionFingerprint(folders)) === JSON.stringify(original), '现有安装指纹发生变化');
    report.checks.push('existing-install-registration-shortcuts-and-data-unchanged');
    report.passed = true;
  } catch (error) {
    report.error = error.message;
    throw error;
  } finally {
    report.existingStateUnchanged = JSON.stringify(productionFingerprint(folders)) === JSON.stringify(original);
    save();
  }
  console.log(JSON.stringify(report));
}

await main();
