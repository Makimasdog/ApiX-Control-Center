import { type Requirements, type RequirementField, type RequirementAssessment, text } from './contracts.js';

export const requirementFields: { key: RequirementField; label: string; question: string }[] = [
  { key: 'goal', label: '目标', question: '你希望解决什么问题，最终改变什么？' },
  { key: 'scope', label: '范围与边界', question: '这次包含哪些范围？哪些内容应保持不变？' },
  { key: 'constraints', label: '约束', question: '需要遵守哪些技术、时间或权限约束？没有特殊约束也可以明确说明。' },
  { key: 'deliverable', label: '交付物', question: '你希望收到什么可检查的成果？' },
  { key: 'acceptance', label: '验收标准', question: '通过哪些检查或测试，才能确认目标已经达成？' },
];
export const emptyRequirements = (): Requirements => ({ goal: '', scope: '', constraints: '', deliverable: '', acceptance: '' });
export function normalizeAnswer(field: string, value: unknown): string {
  if (!requirementFields.some(item => item.key === field)) throw new Error('未知的需求字段');
  return text(value, 4000);
}
export function nextQuestion(requirements: Requirements) { return requirementFields.find(item => !requirements[item.key]?.trim()) ?? null; }
export function assess(requirements: Requirements, conflicts: string[] = []): RequirementAssessment {
  const missing = requirementFields.filter(item => !requirements[item.key]?.trim()).map(item => item.key);
  // All five fields are mandatory. A model-generated confidence can never grant execution.
  return { score: (5 - missing.length) / 5, threshold: 1, missing, conflicts, ready: missing.length === 0 && conflicts.length === 0 };
}
export function requirementBrief(requirements: Requirements): string {
  const missing = nextQuestion(requirements);
  if (missing) throw new Error(`请先补全${missing.label}`);
  return requirementFields.map(item => `${item.label}：${requirements[item.key]}`).join('\n');
}
