/**
 * 静态文件白名单映射 (Static Files) - 控制可公开访问的前端资源路径
 *
 * 所属层级：基础设施层
 * 核心功能：
 *   - 维护 URL 路径到实际文件路径的白名单映射
 *   - 只有显式列出的前端资源才能被外部 HTTP 请求访问
 *   - 构建产物（dist/）和 web/ 源文件使用不同的路径解析规则
 * 依赖关系：
 *   - 被 [→ 见 server.mjs] 的静态文件服务路由调用
 *   - 映射目标指向 web/ 目录下的前端源文件和 dist/ 目录下的构建产物
 *
 * 安全设计：
 *   采用白名单模式而非目录遍历，防止未授权文件被意外暴露。
 *   公开 URL 保持稳定（如 /styles/index.css），而源文件可以随前端重构自由移动。
 */
import {join} from 'node:path';

/**
 * 静态资源白名单映射表
 * key: 对外暴露的 URL 路径（如 'index.html'、'styles.css'）
 * value: 相对于项目根目录的实际文件路径
 *
 * 样式文件通过数组批量生成，保持 URL 路径稳定而源文件可自由重组。
 */
const assets = new Map([
  ['index.html', 'web/index.html'],
  ['agent-os.js', 'web/agent-os.js'],
  ['owner-login.js','web/owner-login.js'],
  ...['styles', 'phase4', 'director', 'coordinator', 'overview', 'desktop', 'assistant', 'design-system', 'workflow-graph', 'knowledge']
    .map(name => [`${name}.css`, `web/styles/${name}.css`]),
]);

/**
 * staticFilePath - 根据请求的相对路径解析出实际文件绝对路径
 * @param {string} root - 项目根目录的绝对路径
 * @param {string} relativePath - 请求的资源相对路径
 * @returns {string|null} 命中白名单则返回绝对路径，否则返回 null（由调用方返回 404）
 *
 * 解析优先级：
 *   1. 精确匹配白名单映射表（前端源文件）
 *   2. 特殊处理 dist/src/assistant-result.js 的旧路径兼容
 *   3. 匹配 dist/ 目录下的构建产物（JS 文件，文件名限字母数字和 -_）
 *   4. 都不匹配则返回 null，拒绝访问
 */
export function staticFilePath(root, relativePath) {
  const asset = assets.get(relativePath);
  if (asset) return join(root, asset);
  // 旧路径兼容：dist/src/assistant-result.js 实际位于 dist/src/assistant/ 子目录
  if (relativePath === 'dist/src/assistant-result.js') return join(root, 'dist/src/assistant/assistant-result.js');
  // 允许访问 dist/ 下的构建产物 JS 文件（文件名只允许字母数字、-、_）
  if (relativePath === 'dist/src/assistant/assistant-result.js' || /^dist\/web\/[a-zA-Z0-9_-]+\.js$/.test(relativePath)) {
    return join(root, relativePath);
  }
  return null;
}
