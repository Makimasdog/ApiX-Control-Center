// This is the single, versioned projection used by host history, model context and UI.
export const hostResultFields=['hostResultVersion','operationId','reason','processesEnded','executionComplete','sideEffectsNeedReview','evidencePersisted','passed','exitCode','timedOut','aborted','unknown','isError','error','fingerprint','truncated','log','path','beforeSha256','afterSha256','startLine','endLine','conflict','diffTruncated','added','removed','sha256','nextCursor','hasMore','bytesReturned','byteBudget','fileBytes','bytesScanned','lineTruncated','scanComplete','truncationReason'] as const;
export function hostResultSummary(value:unknown):Record<string,unknown>{
 const r=value&&typeof value==='object'?value as Record<string,unknown>:{};
 return Object.fromEntries(hostResultFields.filter(k=>k in r).map(k=>[k,r[k]]));
}
export function hostResultSucceeded(value:unknown){
 if(!value||typeof value!=='object')return true;const r=value as Record<string,unknown>;
 if(r.hostResultVersion!==undefined&&r.hostResultVersion!==1)return false;
 if(r.hostResultVersion===1&&(typeof r.operationId!=='string'||!r.operationId||typeof r.reason!=='string'||!Number.isInteger(r.exitCode)||r.timedOut!==false||r.aborted!==false||r.unknown!==false))return false;
 if((r.hostResultVersion===1||r.operationId&&('exitCode' in r||'processesEnded' in r))&&(r.processesEnded!==true||r.executionComplete!==true||r.sideEffectsNeedReview!==false||r.evidencePersisted!==true))return false;
 if(r.passed===false||r.error||r.isError===true||r.conflict||r.executionComplete===false||r.sideEffectsNeedReview||r.evidencePersisted===false)return false;
 // New command logs describe completeness separately. A shortened preview is not an execution failure.
 return !('exitCode' in r)||r.exitCode===0&&!r.timedOut&&!r.aborted&&!r.unknown&&(!r.truncated||r.hostResultVersion===1);
}
