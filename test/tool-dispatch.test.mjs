import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {join, resolve, dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {builtinTools} from '../dist/src/assistant/tool-registry.js';

/**
 * 工具分发覆盖守卫
 *
 * 工具声明在 tool-registry.ts，实际分发分散在 tool-dispatch 的特殊分支
 * 和 control-plane 的 execute。两处都不认识的工具会落到
 * `throw new Error('工具不存在')`——这对模型来说是不可恢复的误导：
 * 它明明在目录里看到这个工具，却被告诉不存在。
 *
 * 这个测试保证：注册表里出现的每个内置工具，都能在两处分发里找到处理位置。
 * 新增工具却忘了实现分发时，这里会直接失败。
 */

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const dispatch = readFileSync(join(root, 'src/assistant/tool-dispatch.ts'), 'utf8');
const plane = readFileSync(join(root, 'control-plane.mjs'), 'utf8');

/** control-plane 里成组分发的只读工具白名单：if(['a','b'].includes(tool)) */
function arrayDispatchNames(source) {
  const names = new Set();
  for (const match of source.matchAll(/\[([^\]]*)\]\.includes\(tool\)/g)) {
    for (const name of match[1].matchAll(/'([a-z_]+)'/g)) names.add(name[1]);
  }
  return names;
}
const planeArray = arrayDispatchNames(plane);

test('每个内置工具都有可达的分发位置', () => {
  const missing = [];
  for (const definition of builtinTools) {
    const name = definition.name;
    const inDispatch = dispatch.includes(`tool==='${name}'`);
    const inPlane = plane.includes(`tool==='${name}'`) || planeArray.has(name);
    if (!inDispatch && !inPlane) missing.push(name);
  }
  assert.deepEqual(missing, [],
    '以下工具已声明但没有任何分发分支，调用时只会得到「工具不存在」：' + missing.join(', '));
});

test('注册表里不应出现重复的工具名', () => {
  const seen = new Map();
  for (const definition of builtinTools) seen.set(definition.name, (seen.get(definition.name) ?? 0) + 1);
  assert.deepEqual([...seen].filter(([, count]) => count > 1), [], '存在重复声明的工具');
});

test('只读工具不得声明会改工作区', () => {
  const inconsistent = builtinTools
    .filter((definition) => definition.readOnly && definition.changesWorkspace)
    .map((definition) => definition.name);
  assert.deepEqual(inconsistent, [], '只读与改工作区不能同时成立：' + inconsistent.join(', '));
});

test('write_file 覆盖已有文件时可要求 SHA256 校验', () => {
  const writeFile = builtinTools.find((definition) => definition.name === 'write_file');
  assert(writeFile, 'write_file 必须存在');
  assert(writeFile.inputSchema.properties.expectedSha256, 'write_file 应支持 expectedSha256 冲突校验');
  assert.match(writeFile.description, /expectedSha256/, '描述应告诉模型如何避免覆盖用户改动');
});

test('delegate 的描述与实际入参一致，不承诺不存在的契约字段', () => {
  const delegate = builtinTools.find((definition) => definition.name === 'delegate');
  assert(delegate, 'delegate 必须存在');
  const properties = Object.keys(delegate.inputSchema.properties ?? {});
  // 描述此前写「冻结模块契约后委派」，但 schema 只有 goal + requirements。
  assert.deepEqual(properties.sort(), ['goal', 'requirements']);
  assert(!/冻结模块契约后委派/.test(delegate.description), '描述不应暗示存在契约入参');
  assert.match(delegate.description, /requirements/, '描述应指向实际可用的入参');
});
