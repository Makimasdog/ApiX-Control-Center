import eslint from '@eslint/js';
import tseslint from 'typescript-eslint';

// 护栏规则(新增代码即强制):XSS 兜底 —— 禁止把含 ${} 插值的普通模板串直接赋给 innerHTML。
// 允许的写法:html`` 自动转义 tagged template(方案 P9)、不含插值的纯字符串、textContent。
const innerHtmlGuard = {
  selector: "AssignmentExpression[left.type='MemberExpression'][left.property.type='Identifier'][left.property.name='innerHTML'][right.type='TemplateLiteral'][right.expressions.length>0]",
  message: '禁止把含插值的普通模板串直接赋给 innerHTML：插值必须经过转义（后续接入 html`` 自动转义模板，见 协作/2026-10-24-问题解决方案.md P9）。',
};
// 旧代码渐进迁移：以下文件在护栏规则生效之前就大量使用裸 innerHTML 模板，先降为 warn，迁移完一个就从这里删除一个。
const innerHtmlLegacyFiles = [
  'web/agent-os.js',
  'web/assistant.ts',
  'web/autonomy-view.ts',
  'web/conversation-model.ts',
  'web/coordinator.ts',
  'web/employee-settings.ts',
  'web/knowledge.ts',
  'web/mcp-settings.ts',
  'web/project-picker.ts',
  'web/provider-center.ts',
  'web/scheduling-view.ts',
  'web/task-events.ts',
  'web/workflow-graph.ts',
];

// 推荐规则整体降为 warn：只报告不拦截，避免一次性重排整个仓库的既有代码；新代码由 CI 输出提示逐步消化。
const toWarn = rules => Object.fromEntries(Object.entries(rules).map(([id, level]) => [id, level === 0 || level === 'off' ? level : Array.isArray(level) ? ['warn', ...level.slice(1)] : 'warn']));

export default tseslint.config(
  {
    ignores: ['dist/**', 'node_modules/**', 'desktop/**', 'out/**', '.tmp-ci/**', '.tmp-provider-review/**', '.tmp-desktop/**', '.tmp-lint-files.mjs', 'coverage/**', '协作/**', '示例/**', 'docs/**'],
  },
  { rules: toWarn(eslint.configs.recommended.rules) },
  ...tseslint.configs.recommended.map(config => ({ ...config, rules: config.rules ? toWarn(config.rules) : {} })),
  {
    rules: {
      // 本仓库 .mjs 混用 Node 与浏览器全局且无统一 globals 声明，未定义标识符交给 tsc/运行时把关。
      'no-undef': 'off',
      'no-debugger': 'error',
      'no-restricted-syntax': ['error', innerHtmlGuard],
      'max-statements-per-line': 'warn',
    },
  },
  ...(innerHtmlLegacyFiles.length ? [{ files: innerHtmlLegacyFiles, rules: { 'no-restricted-syntax': 'warn' } }] : []),
);
