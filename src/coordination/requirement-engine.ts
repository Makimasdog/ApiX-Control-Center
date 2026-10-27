/**
 * 需求澄清引擎 - 五字段问卷式需求收集、评分与简报生成
 *
 * 所属层级：协调层 - 工作流与恢复
 * 核心功能：
 *   1. 定义五字段需求问卷：目标(goal)、范围(scope)、约束(constraints)、交付物(deliverable)、验收标准(acceptance)
 *   2. 需求评分：根据已填写字段比例计算 0-1 分，五字段全填且无冲突才算 ready
 *   3. 需求简报：将已填写的需求格式化为可读的文本摘要
 *   4. 下一问题提示：返回第一个未填写的字段，引导用户逐步补全
 * 依赖关系：
 *   - 依赖 [→ 见 src/coordination/contracts.ts] 的 Requirements / RequirementField / RequirementAssessment 类型
 *   - 被协调层主循环在任务创建前调用，确保需求完整后再执行
 */
import { type Requirements, type RequirementField, type RequirementAssessment, text } from './contracts.js';

/**
 * 需求字段定义列表：每个字段包含键名、显示标签和引导问题
 *
 * 五个字段全部为必填项，模型生成的置信度不能代替执行授权
 */
export const requirementFields: { key: RequirementField; label: string; question: string }[] = [
  { key: 'goal', label: '目标', question: '你希望解决什么问题，最终改变什么？' },
  { key: 'scope', label: '范围与边界', question: '这次包含哪些范围？哪些内容应保持不变？' },
  { key: 'constraints', label: '约束', question: '需要遵守哪些技术、时间或权限约束？没有特殊约束也可以明确说明。' },
  { key: 'deliverable', label: '交付物', question: '你希望收到什么可检查的成果？' },
  { key: 'acceptance', label: '验收标准', question: '通过哪些检查或测试，才能确认目标已经达成？' },
];

/**
 * emptyRequirements - 创建空的需求对象（所有字段为空字符串）
 * @returns 初始化的 Requirements 对象
 */
export const emptyRequirements = (): Requirements => ({ goal: '', scope: '', constraints: '', deliverable: '', acceptance: '' });

/**
 * normalizeAnswer - 校验并规范化用户对某个需求字段的回答
 * @param field - 需求字段键名（必须是 requirementFields 中已定义的字段）
 * @param value - 用户输入的原始回答
 * @returns 规范化后的字符串（截断至 4000 字符）
 * @throws 未知字段时抛出错误
 */
export function normalizeAnswer(field: string, value: unknown): string {
  if (!requirementFields.some(item => item.key === field)) throw new Error('未知的需求字段');
  return text(value, 4000);
}

/**
 * nextQuestion - 获取下一个未填写的需求字段（引导用户逐步补全）
 * @param requirements - 当前已填写的需求对象
 * @returns 第一个未填写的字段对象，全部已填写时返回 null
 */
export function nextQuestion(requirements: Requirements) { return requirementFields.find(item => !requirements[item.key]?.trim()) ?? null; }

/**
 * assess - 评估需求的完整度与就绪状态
 * @param requirements - 当前已填写的需求对象
 * @param conflicts - 可选的冲突列表（由外部检测到的需求矛盾）
 * @returns 需求评估结果，包含 score / threshold / missing / conflicts / ready
 *
 * 评分规则：score = 已填写字段数 / 5
 * 就绪条件：五字段全部填写 + 无冲突
 * 注意：所有五个字段都是必填的，模型生成的置信度不能授予执行权
 */
export function assess(requirements: Requirements, conflicts: string[] = []): RequirementAssessment {
  const missing = requirementFields.filter(item => !requirements[item.key]?.trim()).map(item => item.key);
  // 五字段全部必填；模型生成的置信度永远不能授予执行权
  return { score: (5 - missing.length) / 5, threshold: 1, missing, conflicts, ready: missing.length === 0 && conflicts.length === 0 };
}

/**
 * requirementBrief - 将完整需求格式化为可读的文本简报
 * @param requirements - 已填写完整的需求对象
 * @returns 格式化的需求简报（每行一个字段）
 * @throws 存在未填写字段时抛出错误，提示先补全
 */
export function requirementBrief(requirements: Requirements): string {
  const missing = nextQuestion(requirements);
  if (missing) throw new Error(`请先补全${missing.label}`);
  return requirementFields.map(item => `${item.label}：${requirements[item.key]}`).join('\n');
}
