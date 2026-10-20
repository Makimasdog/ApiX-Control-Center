// Only explicit commands authorize a review; questions, quotations and negations must not change task state.
export function taskAcceptanceRequest(content:string):{taskNumber?:number}|null {
  const value=content.trim();
  const match=/^(?:请)?(?:确认验收通过|确认验收|验收通过|通过验收)(?:\s*(?:任务\s*)?([1-9]\d{0,2}))?[。！!]?$/.exec(value)
    ?? /^(?:请)?(?:确认|通过)\s*任务\s*([1-9]\d{0,2})\s*(?:的)?验收[。！!]?$/.exec(value);
  return match?{...(match[1]?{taskNumber:Number(match[1])}:{})}:null;
}
