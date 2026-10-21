import {test} from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {createServer} from 'node:net';
import {mkdtemp,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import ts from 'typescript';
import {staticFilePath} from '../src/infrastructure/static-files.mjs';

test('static asset mapping keeps public URLs and rejects private paths', () => {
  const root = resolve('.');
  assert.equal(staticFilePath(root, 'index.html'), join(root, 'web/index.html'));
  assert.equal(staticFilePath(root, 'assistant.css'), join(root, 'web/styles/assistant.css'));
  assert.equal(staticFilePath(root, 'dist/web/assistant.js'), join(root, 'dist/web/assistant.js'));
  assert.equal(staticFilePath(root, 'dist/src/assistant/assistant-result.js'), join(root, 'dist/src/assistant/assistant-result.js'));
  assert.equal(staticFilePath(root, 'dist/src/assistant-result.js'), join(root, 'dist/src/assistant/assistant-result.js'));
  for (const path of ['../.env', '.env', 'web/index.html', 'src/infrastructure/static-files.mjs', 'docs/README.md',
    'dist/src/models/model-backend.js', 'dist/web/../src/model-backend.js', 'dist/web/assistant.js.map']) {
    assert.equal(staticFilePath(root, path), null, path);
  }
});

test('production server serves relocated assets and keeps its static access boundary', {timeout:45000}, async () => {
  const probe = createServer();
  probe.listen(0, '127.0.0.1');
  await once(probe, 'listening');
  const port = probe.address().port;
  await new Promise(done => probe.close(done));
  const directory = await mkdtemp(join(tmpdir(), 'apix-layout-'));
  const child = spawn(process.execPath, ['server.mjs'], {
    env:{...process.env,PORT:String(port),APIX_DATA_DIR:directory},
    windowsHide:true,stdio:['ignore','pipe','pipe'],
  });
  const exited = once(child, 'close');
  let diagnostics = '';
  child.stderr.on('data', chunk => { diagnostics = (diagnostics + chunk).slice(-8000); });
  try {
    await new Promise((done, reject) => {
      const timer = setTimeout(() => reject(Error('Server startup deadline: ' + diagnostics)), 15000);
      child.once('error', error => { clearTimeout(timer); reject(error); });
      child.once('exit', code => { clearTimeout(timer); reject(Error(`Server exited ${code}: ${diagnostics}`)); });
      child.stdout.on('data', chunk => { if (String(chunk).includes('ApiX Web:')) { clearTimeout(timer); done(); } });
    });
    const base = `http://127.0.0.1:${port}`;
    const page = await fetch(base);
    assert.equal(page.status, 200);
    const html = await page.text();
    assert.equal(html, await readFile('web/index.html', 'utf8'));
    const paths = ['index.html', ...Array.from(html.matchAll(/(?:src|href)="\.\/([^"]+)"/g), match => match[1])];
    const visited = new Set();
    for (const path of paths) {
      if (visited.has(path)) continue;
      visited.add(path);
      const response = await fetch(`${base}/${path}`);
      assert.equal(response.status, 200, path);
      const expected = await readFile(staticFilePath(resolve('.'), path));
      assert.deepEqual(Buffer.from(await response.arrayBuffer()), expected, path);
      assert.match(response.headers.get('content-type'), /text\/html|text\/css|text\/javascript/, path);
      if (path.endsWith('.js')) {
        const module = ts.createSourceFile(path, expected.toString(), ts.ScriptTarget.Latest, true);
        function visit(node) {
          const spec = (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier;
          if (spec && ts.isStringLiteral(spec) && spec.text.startsWith('.')) {
            paths.push(new URL(spec.text, `${base}/${path}`).pathname.slice(1));
          }
          ts.forEachChild(node, visit);
        }
        visit(module);
      }
    }
    const head = await fetch(`${base}/styles.css`, {method:'HEAD'});
    assert.equal(head.status, 200);
    assert.equal(await head.text(), '');
    assert.equal((await fetch(`${base}/styles.css`, {method:'POST'})).status, 403);
    for (const path of ['.env','server.mjs','web/index.html','docs/README.md','test/manual/test-error-messages.html',
      'dist/src/models/model-backend.js','%2e%2e%2f.env','web%5c..%5c.env']) {
      assert.equal((await fetch(`${base}/${path}`)).status, 404, path);
    }
    assert.equal((await fetch(`${base}/%ZZ`)).status, 400);
    assert.equal((await fetch(`${base}/dist/src/assistant-result.js`)).status, 200);
  } finally {
    child.kill();
    await exited;
    await rm(directory, {recursive:true,force:true});
  }
});
