/**
 * 结果聚合 (Result Aggregation) — 统一的宿主结果投影和成功判定
 *
 * 所属层级：助手层 - 结果处理
 * 核心功能：
 *   1. hostResultFields — 定义宿主结果的标准化字段列表（版本化投影）
 *   2. hostResultSummary — 从任意结果对象中提取标准化字段子集
 *   3. hostResultSucceeded — 判断宿主结果是否成功（检查 exitCode、超时、中止、未知状态等）
 * 依赖关系：
 *   - 被 [→ 见 src/assistant/assistant-loop.ts] 的 executeInner 调用
 *   - 被 [→ 见 src/assistant/assistant-context.ts] 的 history 折叠调用
 *   - 被历史记录、模型上下文和 UI 共同使用
 */
// 这是宿主结果的标准投影，被历史记录、模型上下文和 UI 共同使用。
/** hostResultFields — 宿主结果的所有标准化字段（版本化投影） */
export const hostResultFields=['hostResultVersion','operationId','reason','processesEnded','executionComplete','sideEffectsNeedReview','evidencePersisted','passed','exitCode','timedOut','aborted','unknown','isError','error','fingerprint','truncated','log','path','beforeSha256','afterSha256','startLine','endLine','conflict','diffTruncated','added','removed','sha256','nextCursor','hasMore','bytesReturned','byteBudget','fileBytes','bytesScanned','lineTruncated','scanComplete','truncationReason'] as const;
/**
 * hostResultSummary - 从任意结果对象中提取标准化字段子集
 * @param value - 原始结果对象
 * @returns 只包含 hostResultFields 中定义的字段的精简对象
 */
export function hostResultSummary(value:unknown):Record<string,unknown>{
 const r=value&&typeof value==='object'?value as Record<string,unknown>:{};
 return Object.fromEntries(hostResultFields.filter(k=>k in r).map(k=>[k,r[k]]));
}
/**
 * hostResultSucceeded - 判断宿主结果是否成功
 * @param value - 结果对象
 * @returns true=成功（exitCode=0、未超时、未中止、状态已知、无副作用待核对）
 * 设计意图：不能仅看 exitCode===0，还要检查进程完整性、副作用状态、证据持久化等
 */
export function hostResultSucceeded(value:unknown){
 if(!value||typeof value!=='object')return true;const r=value as Record<string,unknown>;
 if(r.hostResultVersion!==undefined&&r.hostResultVersion!==1)return false;
 if(r.hostResultVersion===1&&(typeof r.operationId!=='string'||!r.operationId||typeof r.reason!=='string'||!Number.isInteger(r.exitCode)||r.timedOut!==false||r.aborted!==false||r.unknown!==false))return false;
 if((r.hostResultVersion===1||r.operationId&&('exitCode' in r||'processesEnded' in r))&&(r.processesEnded!==true||r.executionComplete!==true||r.sideEffectsNeedReview!==false||r.evidencePersisted!==true))return false;
 if(r.passed===false||r.error||r.isError===true||r.conflict||r.executionComplete===false||r.sideEffectsNeedReview||r.evidencePersisted===false)return false;
 // New command logs describe completeness separately. A shortened preview is not an execution failure.
 return !('exitCode' in r)||r.exitCode===0&&!r.timedOut&&!r.aborted&&!r.unknown&&(!r.truncated||r.hostResultVersion===1);
}
