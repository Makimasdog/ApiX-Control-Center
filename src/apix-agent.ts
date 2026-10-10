import { type ModelBackend, type Requirements, type Employee, type PlanStep, type CoordinatorDecision, type InteractionMode, object, text } from './contracts.js';
import { nextQuestion, requirementFields, requirementBrief } from './requirement-engine.js';

function parse(raw: string) { return object(JSON.parse(raw.replace(/^```(?:json)?\s*|\s*```$/g, ''))); }
export function createApiXAgent(backend: ModelBackend) {
  const identity = '你是 ApiX，用户的管理者 Agent。Pi 是你的推理技术底座，不是你的上级，也不是此对话的员工。你与用户沟通、理解需求、安排员工、监督任务。不得直接产出代码、报告等执行成果，不声称已执行。不能授予权限。';
  async function discuss(requirements: Requirements, content: string, history: unknown[], progress: unknown, interactionMode: InteractionMode = 'conversational', onQuestion?: (delta: string) => void): Promise<CoordinatorDecision> {
    try {
      let streamed = ''; let emitted = '';
      const raw = await backend.infer(`APIX_COORDINATOR_JSON\n${identity}\n交互模式：${interactionMode === 'structured' ? '约束模式：按目标、范围、约束、交付物、验收标准逐项检查；优先追问下一个缺失或冲突字段，措辞明确。' : '对话模式：自然沟通并从用户表达中整理需求；根据上下文追问最关键的不确定点，不强迫用户按表单顺序回答。'}\n根据当前目标递进澄清。只问最有价值的一个问题，已明确的信息不要重复问。用户询问进度时 kind=progress，状态由系统展示，不生成猜测的状态。提取用户这次明确给出的字段，不能凭空填值；每个更新 evidence 必须是最新消息的原文。检查冲突。JSON 中首先输出 kind 和 question，再输出 updates 与 conflicts。只输出 JSON：{"kind":"clarification|requirement_review|progress","question":"澄清问题或确认提示","updates":[{"field":"goal|scope|constraints|deliverable|acceptance","value":"信息","evidence":"原文"}],"conflicts":["尚未解决的冲突"]}。不要输出 answer 或执行结果。\n已知需求：${JSON.stringify(requirements)}\n历史：${JSON.stringify(history)}\n真实进度：${JSON.stringify(progress)}\n用户最新消息：${content}`, delta => {
        if (!onQuestion) return;
        streamed += delta;
        const start = /"question"\s*:\s*"/.exec(streamed);
        if (!start) return;
        const tail = streamed.slice(start.index + start[0].length);
        let end = 0; let escaped = false;
        for (; end < tail.length; end++) { const char = tail[end]; if (char === '"' && !escaped) break; if (char === '\\' && !escaped) escaped = true; else escaped = false; }
        let fragment = tail.slice(0, end);
        if (fragment.endsWith('\\')) fragment = fragment.slice(0, -1);
        try { const visible = JSON.parse(`"${fragment}"`) as string; if (visible.length > emitted.length && visible.startsWith(emitted)) { onQuestion(visible.slice(emitted.length)); emitted = visible; } } catch { /* Wait for a complete escape sequence. */ }
      });
      const parsed = parse(raw);
      if (!['clarification', 'requirement_review', 'progress'].includes(String(parsed.kind))) throw new Error('ApiX 推理返回了不支持的行为');
      const updates: Partial<Requirements> = {};
      for (const value of Array.isArray(parsed.updates) ? parsed.updates : []) {
        const item = object(value);
        const field = requirementFields.find(f => f.key === item.field)?.key;
        if (field && typeof item.evidence === 'string' && item.evidence.trim() && content.includes(item.evidence)) updates[field] = text(item.value, 4000);
      }
      const conflicts = (Array.isArray(parsed.conflicts) ? parsed.conflicts : []).filter((v): v is string => typeof v === 'string').slice(0, 8).map(v => v.slice(0, 500));
      return { kind: parsed.kind as CoordinatorDecision['kind'], question: text(parsed.question, 1000), updates, conflicts, mode: 'pi' };
    } catch (error) {
      return { kind: 'clarification', question: nextQuestion(requirements)?.question ?? '请检查需求摘要并确认；也可以补充需要调整的内容。', updates: {}, conflicts: [], mode: 'rules', error: String(error instanceof Error ? error.message : error).slice(0, 300) };
    }
  }
  async function plan(requirements: Requirements, employees: Employee[]): Promise<{ steps: PlanStep[]; mode: string; error?: string }> {
    if (!employees.length) throw new Error('请先注册一个可用员工');
    const brief = requirementBrief(requirements);
    try {
      const parsed = parse(await backend.infer(`APIX_PLAN_JSON\n${identity}\n生成有具体验收条件的执行计划，按员工岗位匹配。步骤1至8项；dependsOn 只能引用前序步骤的零基索引。只输出 JSON：{"steps":[{"prompt":"具体任务与验收要求","employeeId":"可用员工 ID","dependsOn":[]}]}\n已确认需求：${brief}\n员工：${JSON.stringify(employees)}`));
      if (!Array.isArray(parsed.steps) || !parsed.steps.length || parsed.steps.length > 8) throw new Error('计划步骤无效');
      const steps = parsed.steps.map((value, index) => {
        const step = object(value);
        const employeeId = text(step.employeeId, 100);
        if (!employees.some(e => e.id === employeeId)) throw new Error('计划引用了不可用的员工');
        if (!Array.isArray(step.dependsOn) || step.dependsOn.some(i => !Number.isInteger(i) || i < 0 || i >= index)) throw new Error('计划依赖无效');
        return { prompt: text(step.prompt, 10000), employeeId, dependsOn: [...new Set(step.dependsOn as number[])] };
      });
      return { steps, mode: 'pi' };
    } catch (error) {
      return { steps: [{ prompt: `按照已确认需求执行并提交验收证据：\n${brief}`, employeeId: employees[0]!.id, dependsOn: [] }], mode: 'rules', error: String(error instanceof Error ? error.message : error).slice(0, 300) };
    }
  }
  async function guide(requirements: Requirements, taskPrompt: string, report: { summary: string; blocked: boolean }): Promise<{ action: 'guide' | 'escalate' | 'observe'; focus: 'scope' | 'verification' | 'dependencies' | 'delivery'; mode: 'pi' | 'rules'; error?: string }> {
    try {
      const raw = await backend.infer(`APIX_GUIDE_JSON\n${identity}\n员工正在执行已获批准的任务。根据真实进度决定是否应提醒员工继续、请用户处理阻塞，或仅记录进度。不得添加任务、扩大范围、修改授权或声称成果已完成。只输出 JSON：{"action":"guide|escalate|observe","focus":"scope|verification|dependencies|delivery"}。focus 仅用于选择已经确认的需求片段，不输出新指令。\n已确认需求：${requirementBrief(requirements)}\n已批准任务：${taskPrompt}\n员工报告（未验证）：${JSON.stringify(report)}`);
      const parsed = parse(raw);
      if (!['guide','escalate','observe'].includes(String(parsed.action)) || !['scope','verification','dependencies','delivery'].includes(String(parsed.focus))) throw new Error('ApiX 指导决策无效');
      return { action: parsed.action as 'guide' | 'escalate' | 'observe', focus: parsed.focus as 'scope' | 'verification' | 'dependencies' | 'delivery', mode: 'pi' };
    } catch (error) {
      return { action: report.blocked ? 'escalate' : 'observe', focus: 'verification', mode: 'rules', error: String(error instanceof Error ? error.message : error).slice(0,300) };
    }
  }
  return { discuss, plan, guide };
}
export type ApiXAgent = ReturnType<typeof createApiXAgent>;
