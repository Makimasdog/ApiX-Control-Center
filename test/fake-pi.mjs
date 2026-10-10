import { writeFileSync } from "node:fs";

let buffer = "";
process.stdin.on("data", (chunk) => {
  buffer += chunk.toString();
  let index;
  while ((index = buffer.indexOf("\n")) !== -1) {
    const line = buffer.slice(0, index); buffer = buffer.slice(index + 1);
    const command = JSON.parse(line);
    if (command.type === "abort") {
      process.stdout.write(JSON.stringify({ type: "agent_settled", aborted: true }) + "\n");
      process.exit(0);
    }
    if (command.type !== "prompt") continue;
    process.stdout.write(JSON.stringify({ id: command.id, type: "response", command: "prompt", success: true, data: { disposition: "started" } }) + "\n");
    process.stdout.write('{"type":"agent_start"}\n');
    if (command.message.startsWith('APIX_COORDINATOR_JSON\n') || command.message.startsWith('APIX_PLAN_JSON\n') || command.message.startsWith('APIX_GUIDE_JSON\n')) {
      let answer;
      if (command.message.startsWith('APIX_GUIDE_JSON\n')) {
        answer = {action:'guide',focus:'verification'};
      } else if (command.message.startsWith('APIX_PLAN_JSON\n')) {
        const employees = JSON.parse(command.message.split('\n员工：').at(-1));
        answer = {steps:[{prompt:'inspect coordination',employeeId:employees[0].id,dependsOn:[]}]};
      } else {
        const latest = command.message.split('用户最新消息：').at(-1);
        let values = {}; try { values = JSON.parse(latest); } catch {}
        answer = {kind:latest.includes('进度')?'progress':'clarification',question:'请检查这些需求，是否还有需要调整的约束？',updates:Object.entries(values).map(([field,value])=>({field,value,evidence:value})),conflicts:latest.includes('conflict')?['范围与交付物存在冲突']:[]};
      }
      if (process.env.APIX_FIXTURE_STREAM === '1' && command.message.startsWith('APIX_COORDINATOR_JSON\n')) {
        const raw=JSON.stringify(answer);
        for (const part of [raw.slice(0,20),raw.slice(20,48),raw.slice(48)]) process.stdout.write(JSON.stringify({type:'message_update',assistantMessageEvent:{type:'text_delta',delta:part}})+'\n');
        setTimeout(()=>{process.stdout.write(JSON.stringify({type:'message_end',message:{role:'assistant',stopReason:'stop',content:[{type:'text',text:raw}]}})+'\n');process.stdout.write('{"type":"agent_settled","aborted":false}\n');},40);
      } else {
        process.stdout.write(JSON.stringify({type:'message_end',message:{role:'assistant',stopReason:'stop',content:[{type:'text',text:JSON.stringify(answer)}]}})+'\n');
        process.stdout.write('{"type":"agent_settled","aborted":false}\n');
      }
      continue;
    }
    if (command.message.startsWith("APIX_DIRECTOR_JSON\n")) {
      const latest = command.message.split("用户最新消息：").at(-1);
      const employees = JSON.parse(command.message.match(/可用员工：(.*?)\n当前计划与任务状态：/)?.[1] ?? "[]");
      const answer = latest.includes("进度") ? { reply: "这是当前计划的状态摘要。", goal: "", steps: [], memoryCandidates: [] } : { reply: "我已整理目标和执行顺序，请检查员工与依赖。", goal: latest, steps: [{ prompt: `设计：${latest}`, employeeId: employees[0]?.id, dependsOn: [] }, { prompt: `实现并验证：${latest}`, employeeId: employees[1]?.id ?? employees[0]?.id, dependsOn: [0] }], memoryCandidates: [{ category: "需求", title: "多语言目标", content: "用户要求多语言支持", evidence: "多语言" }] };
      process.stdout.write(JSON.stringify({ type: "message_end", message: { role: "assistant", stopReason: "stop", content: [{ type: "text", text: JSON.stringify(answer) }] } }) + "\n");
      process.stdout.write('{"type":"agent_settled","aborted":false}\n');
      continue;
    }
    if (command.message === "hold" || process.env.APIX_FIXTURE_HOLD === '1') continue;
    if (command.message.startsWith("write-file:")) {
      const [filename, content] = command.message.slice(11).split(":", 2);
      if (!/^[a-z]\.txt$/.test(filename)) throw new Error("Invalid test filename");
      writeFileSync(filename, content);
    }
    if (command.message === "many-events") for (let number = 0; number < 350; number++) process.stdout.write(JSON.stringify({ type: "tool_execution_start", toolName: "read", args: { number } }) + "\n");
    process.stdout.write(JSON.stringify({ type: "message_end", message: { role: "assistant", stopReason: command.message.startsWith("provider-error") ? "error" : "stop", content: [{ type: "text", text: `Pi result: ${command.message}` }] } }) + "\n");
    process.stdout.write('{"type":"agent_settled","aborted":false}\n');
  }
});
