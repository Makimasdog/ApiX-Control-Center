const { app, BrowserWindow, Menu, dialog, shell } = require('electron');
const { join, resolve } = require('node:path');
const { mkdirSync, existsSync, copyFileSync, createWriteStream, writeFileSync } = require('node:fs');
const { startBackend } = require('./backend.cjs');
const { spawn } = require('node:child_process');

let window;
let backend;
let quitting = false;
let exitReady = false;
const smoke = process.argv.includes('--smoke-test');
const dataDir = resolve(process.env.APIX_DESKTOP_DATA_DIR || join(app.getPath('appData'), 'ApiX-Control-Center'));
mkdirSync(dataDir, { recursive: true });
app.setPath('userData', dataDir);

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => { if (window) { if (window.isMinimized()) window.restore(); window.show(); window.focus(); } });
  app.on('before-quit', event => {
    if (exitReady) return;
    event.preventDefault();
    if (quitting) return;
    quitting = true;
    void (async () => { await backend?.stop(); exitReady = true; app.quit(); })();
  });
  app.on('window-all-closed', () => app.quit());
  void app.whenReady().then(start).catch(error => {
    if (smoke) { mkdirSync(dataDir, { recursive: true }); writeFileSync(join(dataDir, 'smoke-result.json'), JSON.stringify({ error: error.message })); }
    else dialog.showErrorBox('ApiX 无法启动', `${error.message}\n\n日志目录：${dataDir}`);
    app.quit();
  });
}

async function start() {
  if (process.platform !== 'win32') throw new Error('本桌面版本仅支持 Windows。');
  mkdirSync(dataDir, { recursive: true });
  const root = app.isPackaged ? join(process.resourcesPath, 'backend') : join(app.getAppPath(), '../backend');
  const envFile = join(dataDir, '.env');
  if (!existsSync(envFile)) copyFileSync(join(root, '.env.example'), envFile);
  const log = createWriteStream(join(dataDir, 'desktop.log'), { flags: 'w' });
  log.on('error', error => { dialog.showErrorBox('ApiX 日志写入失败', error.message); app.quit(); });
  backend = await startBackend({ root, dataDir, log, onExit: () => {
    if (!quitting) { dialog.showErrorBox('ApiX 后端已停止', `请重新启动应用。日志目录：${dataDir}`); app.quit(); }
  } });
  if (quitting) { await backend.stop(); return; }
  window = new BrowserWindow({
    title: 'ApiX Control Center', width: 1440, height: 960, minWidth: 960, minHeight: 640, show: false,
    webPreferences: { nodeIntegration: false, contextIsolation: true, sandbox: true },
  });
  const allowed = value => { try { return new URL(value).origin === backend.url; } catch { return false; } };
  window.webContents.on('will-navigate', (event, url) => { if (!allowed(url)) event.preventDefault(); });
  window.webContents.on('will-redirect', (event, url) => { if (!allowed(url)) event.preventDefault(); });
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  window.webContents.session.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
  window.webContents.session.setPermissionCheckHandler(() => false);
  window.webContents.session.webRequest.onHeadersReceived({ urls: [backend.url + '/*'] }, (details, callback) => callback({
    responseHeaders: { ...details.responseHeaders, 'Content-Security-Policy': [
      "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-src 'none'",
    ] },
  }));
  window.webContents.on('render-process-gone', () => {
    if (!quitting) { dialog.showErrorBox('ApiX 窗口已停止', '请重新启动应用，运行记录保留在数据目录。'); app.quit(); }
  });
  window.on('close', event => {
    if (quitting || smoke) return;
    const choice = dialog.showMessageBoxSync(window, {
      type: 'question', title: '退出 ApiX', message: '退出将停止本桌面实例的后端和正在运行的员工任务。',
      buttons: ['取消', '退出并停止任务'], defaultId: 0, cancelId: 0,
    });
    event.preventDefault();
    if (choice === 1) app.quit();
  });
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    { label: '应用', submenu: [
      { label: '打开数据与日志目录', click: () => void shell.openPath(dataDir) },
      { label: '编辑模型密钥配置（重启生效）', click: () => {
        const editor = spawn(join(process.env.SystemRoot, 'System32/notepad.exe'), [envFile], { detached: true, stdio: 'ignore' });
        editor.once('error', error => dialog.showErrorBox('无法打开配置', error.message)); editor.unref();
      } },
      { type: 'separator' }, { label: '退出', click: () => window.close() },
    ] },
    { label: '编辑', submenu: [{ role: 'undo' }, { role: 'redo' }, { type: 'separator' }, { role: 'cut' }, { role: 'copy' }, { role: 'paste' }, { role: 'selectAll' }] },
    { label: '视图', submenu: [{ role: 'reload' }, { role: 'toggleDevTools' }, { role: 'resetZoom' }, { role: 'zoomIn' }, { role: 'zoomOut' }] },
  ]));
  await window.loadURL(backend.url);
  if (!smoke) window.show();
  else {
    const report = await window.webContents.executeJavaScript(`(async () => {
      const response = await fetch('/api/snapshot');
      return { title: document.title, bodyLength: document.body.innerText.length,
        apiStatus: response.status, snapshot: typeof await response.json(),
        nodeExposed: typeof window.require !== 'undefined' || typeof window.process !== 'undefined',
        assets: await Promise.all([...document.querySelectorAll('script[src],link[rel="stylesheet"]')].map(async el => {
          const asset = await fetch(el.src || el.href); return { url: new URL(asset.url).pathname, status: asset.status };
        })) };
    })()`);
    writeFileSync(join(dataDir, 'smoke-result.json'), JSON.stringify({ ...report, url: backend.url, supervisorPid: backend.supervisorPid }));
    writeFileSync(join(dataDir, 'window.png'), (await window.webContents.capturePage()).toPNG());
    app.quit();
  }
}
