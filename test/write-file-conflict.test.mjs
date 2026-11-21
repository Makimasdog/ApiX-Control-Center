import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {writeFileSync, readFileSync, existsSync} from 'node:fs';
import {join} from 'node:path';
import {codingFixture, finish, action} from './coding-harness.mjs';

/**
 * write_file 的覆盖冲突检查
 *
 * 此前只有 edit_file 要求 expectedSha256；write_file 会直接覆盖任何文件，
 * 包括用户在模型读取之后手动改过的内容，而且没有任何提示。
 * 现在 write_file 支持 expectedSha256：传了就必须对得上，对不上拒绝写入。
 *
 * 注意这是可选参数——新建文件或整文件重写仍可省略，保持原有用法。
 */

const sha = (text) => createHash('sha256').update(text).digest('hex');

test('expectedSha256 不匹配时拒绝覆盖，文件保持原样', async () => {
  await codingFixture(async (h) => {
    const target = join(h.root, 'src/user.txt');
    writeFileSync(target, '用户自己改过的内容');
    h.queue(
      action('write_file', {path: 'src/user.txt', content: '模型以为的内容', expectedSha256: sha('模型上次读到的旧内容')}),
      finish,
    );
    await h.service.message(h.id, {content: '覆盖用户文件'});
    const s = await h.idle();

    assert.equal(readFileSync(target, 'utf8'), '用户自己改过的内容', '冲突时不得写入');
    const result = s.events.find((e) => e.kind === 'tool_result' && e.body.tool === 'write_file');
    assert(result, '应记录工具结果');
    assert.equal(result.body.ok, false);
    assert.match(String(result.body.error), /冲突/);
  }, {idleMs: 15000});
});

test('expectedSha256 匹配时正常覆盖', async () => {
  await codingFixture(async (h) => {
    const target = join(h.root, 'src/current.txt');
    writeFileSync(target, '旧内容');
    h.queue(
      action('write_file', {path: 'src/current.txt', content: '新内容', expectedSha256: sha('旧内容')}),
      finish,
    );
    await h.service.message(h.id, {content: '更新文件'});
    await h.idle();

    assert.equal(readFileSync(target, 'utf8'), '新内容');
  }, {idleMs: 15000});
});

test('新建文件不需要 expectedSha256，保持原有用法', async () => {
  await codingFixture(async (h) => {
    h.queue(action('write_file', {path: 'src/brand-new.txt', content: '新建'}), finish);
    await h.service.message(h.id, {content: '新建文件'});
    await h.idle();

    const target = join(h.root, 'src/brand-new.txt');
    assert(existsSync(target), '应创建文件');
    assert.equal(readFileSync(target, 'utf8'), '新建');
  }, {idleMs: 15000});
});

test('对不存在的文件传 expectedSha256 也应拒绝', async () => {
  await codingFixture(async (h) => {
    h.queue(
      action('write_file', {path: 'src/missing.txt', content: '内容', expectedSha256: sha('任意')}),
      finish,
    );
    await h.service.message(h.id, {content: '写入不存在的文件'});
    const s = await h.idle();

    assert(!existsSync(join(h.root, 'src/missing.txt')), '不应创建文件');
    const result = s.events.find((e) => e.kind === 'tool_result' && e.body.tool === 'write_file');
    assert.equal(result?.body.ok, false);
    assert.match(String(result?.body.error), /不存在|冲突/);
  }, {idleMs: 15000});
});
