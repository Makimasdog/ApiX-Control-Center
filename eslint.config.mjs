/**
 * eslint.config.mjs - ESLint 代码检查配置（Flat Config 格式）
 *
 * 所属层级：工程基础设施（开发时静态检查，不参与运行）
 * 核心功能：
 *   1. 集成 TypeScript ESLint 规则（推荐级，降级为 warn 不拦截）
 *   2. innerHTML XSS 护栏：禁止含插值的普通模板串直接赋给 innerHTML
 *   3. 忽略构建产物、临时文件、文档等非源码目录
 *   4. 关闭 no-undef（因 .mjs 混用 Node/浏览器全局，交给 tsc/运行时把关）
 *
 * 依赖关系：
 *   - 被调用 → package.json 的 lint 脚本
 *   - 调用 → @eslint/js（ESLint 内置推荐规则）
 *   - 调用 → typescript-eslint（TypeScript 规则集）
 */
import eslint from '@eslint/js';
import tseslint from 'typescript-eslint';

// 护栏规则(新增代码即强制):XSS 兜底 —— 禁止把含 ${} 插值的普通模板串直接赋给 innerHTML。
// 允许的写法:html`` 自动转义 tagged template(方案 P9)、不含插值的纯字符串、textContent。
/**
 * innerHtmlGuard - innerHTML XSS 防护规则
 *
 * 用 AST selector 匹配所有 `xxx.innerHTML = `...${}...`` 写法，
 * 即「把含插值的普通模板串直接赋给 innerHTML」——这是 XSS 漏洞的常见来源。
 *
 * 允许的写法：
 *   - html`` 标签模板（web/html.ts 的 html`` 会自动转义）
 *   - 不含插值的纯字符串
 *   - textContent（纯文本，不解析 HTML）
 */
const innerHtmlGuard = {
  selector: "AssignmentExpression[left.type='MemberExpression'][left.property.type='Identifier'][left.property.name='innerHTML'][right.type='TemplateLiteral'][right.expressions.length>0]",
  message: '禁止把含插值的普通模板串直接赋给 innerHTML：插值必须经过转义（使用 web/html.ts 的 html`` 模板；仅适用于文本与带引号属性）。',
};

// 推荐规则整体降为 warn：只报告不拦截，避免一次性重排整个仓库的既有代码；新代码由 CI 输出提示逐步消化。
/**
 * toWarn - 将 ESLint 规则级别从 error 降级为 warn
 *
 * @param {Object} rules - ESLint 规则对象（键是规则名，值是级别）
 * @returns {Object} 转换后的规则对象
 *
 * 设计意图：推荐规则整体降为 warn，只报告不拦截，
 * 避免一次性重排整个仓库的既有代码；新代码由 CI 输出提示逐步消化。
 * 规则级别：0/'off' 保持不变，数组形式保留选项，其余统一转为 'warn'。
 */
const toWarn = rules => Object.fromEntries(Object.entries(rules).map(([id, level]) => [id, level === 0 || level === 'off' ? level : Array.isArray(level) ? ['warn', ...level.slice(1)] : 'warn']));

// ===== ESLint Flat Config 主配置导出 =====
// 配置按顺序应用：忽略规则 → JS 推荐 → TS 推荐 → 自定义规则
export default tseslint.config(
  // 第一段：忽略不需要检查的目录（构建产物、依赖、临时文件、文档等）
  {
    ignores: ['dist/**', 'node_modules/**', 'desktop/**', 'out/**', '.tmp*/**', '.tmp-lint-files.mjs', 'coverage/**', '协作/**', '示例/**', 'docs/**'],
  },
  // 第二段：JS 推荐规则，全部降级为 warn
  { rules: toWarn(eslint.configs.recommended.rules) },
  // 第三段：TypeScript ESLint 推荐规则，也全部降级为 warn
  ...tseslint.configs.recommended.map(config => ({ ...config, rules: config.rules ? toWarn(config.rules) : {} })),
  // 第四段：自定义强制规则
  {
    rules: {
      // 本仓库 .mjs 混用 Node 与浏览器全局且无统一 globals 声明，未定义标识符交给 tsc/运行时把关。
      'no-undef': 'off',
      'no-debugger': 'error',
      'no-restricted-syntax': ['error', innerHtmlGuard],
      'max-statements-per-line': 'warn',
    },
  },
);
