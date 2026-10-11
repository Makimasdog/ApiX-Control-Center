export function instructionState(status: string) {
  return ({queued:'待接收',delivered:'已送达，待确认',processing:'员工已确认接收',completed:'员工已报告处理',failed:'处理失败',expired:'已超时',rejected:'已拒绝'} as Record<string,string>)[status] ?? status;
}
