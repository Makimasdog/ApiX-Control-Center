import { writeFileSync,readFileSync } from "node:fs";

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
    if(command.message.startsWith('APIX_ARCHITECTURE_JSON\n') || command.message.startsWith('APIX_QUALITY_JSON\n')){
      if(!process.argv.includes('--no-tools'))throw new Error('Architecture/quality inference must not execute project tools');
      const answer=command.message.startsWith('APIX_ARCHITECTURE_JSON\n')?{summary:'fixture frozen architecture',modules:[{id:'core',name:'核心',paths:['a.txt'],dependsOn:[],risk:'high',difficulty:2,workload:{inputTokens:1000,outputTokens:500,calls:1},interfaces:[{name:'text',consumer:'external',protocol:'file',request:{type:'null'},response:{type:'string',const:'good'}}],dataStructures:[{name:'content',schema:{type:'string',const:'good'}}],acceptance:['a.txt 内容必须为 good'],checkIds:['tests']}]}:{passed:process.env.APIX_FIXTURE_QUALITY_FAIL!=='1',findings:process.env.APIX_FIXTURE_QUALITY_FAIL==='1'?['实际测试不足以证明交付符合内容接口，补齐实现与证据']:[]};
      process.stdout.write(JSON.stringify({type:'message_end',message:{role:'assistant',stopReason:'stop',content:[{type:'text',text:JSON.stringify(answer)}]}})+'\n');process.stdout.write(JSON.stringify({type:'agent_end'})+'\n');continue;
    }
    if(process.argv.includes('fixture-manager-quota')){process.stderr.write('insufficient_quota',()=>process.exit(1));return;}
    process.stdout.write(JSON.stringify({ id: command.id, type: "response", command: "prompt", success: true, data: { disposition: "started" } }) + "\n");
    process.stdout.write('{"type":"agent_start"}\n');
    if(command.message.startsWith('APIX_CONNECTION_TEST\n')){
      if(!process.argv.includes('--no-tools') || !process.argv.includes('--no-context-files') || process.argv.includes('--tools') || process.env.APIX_AGENT_TOKEN)throw new Error('Connection test exposed tools, context files or worker credentials');
      const result=JSON.parse(command.message.split('只返回 JSON：')[1]);
      const mode=process.env.APIX_FIXTURE_CONNECTION_MODE;
      setTimeout(()=>{
        if(mode==='error' || mode==='quota'){process.stderr.write((mode==='quota'?'insufficient_quota ':'')+'fixture-secret-should-not-leak');process.exit(1);return;}
        process.stdout.write(JSON.stringify({type:'message_end',message:{role:'assistant',stopReason:'stop',content:[{type:'text',text:JSON.stringify(mode==='invalid'?{nonce:'wrong'}:result)}]}})+'\n');
        process.stdout.write(JSON.stringify({type:'agent_end'})+'\n');
      },Number(process.env.APIX_FIXTURE_CONNECTION_DELAY_MS ?? 0));continue;
    }
    if(command.message.startsWith('APIX_PLANNING_CLAIM_JSON\n')){
      const args=process.argv;
      if(args.includes('fixture-meeting-fail')){process.stderr.write('fixture consultation unavailable');process.exit(1);}
      const tasks=JSON.parse(command.message.split('\n任务：')[1].split('\n需要澄清')[0]);
      const safe=args.includes('--no-tools') && args.includes('--no-extensions') && args.includes('--no-skills') && args.includes('--no-context-files') && !process.env.APIX_AGENT_TOKEN && !process.env.APIX_DATA_DIR && !process.env.APIX_ALI_API_KEY && !process.env.ali_api_key && /consultations/.test(process.cwd());
      if(!safe)throw new Error('Consultation isolation flags missing');
      const answer={claims:tasks.map((_,step)=>({step,reason:'fixture: no project tools, isolated identity and cwd',risk:'declared capability only',minutes:5})),decline:''};
      process.stdout.write(JSON.stringify({type:'message_end',message:{role:'assistant',stopReason:'stop',content:[{type:'text',text:JSON.stringify(answer)}]}})+'\n');process.stdout.write(JSON.stringify({type:process.env.APIX_FIXTURE_MODERN_PI === '1' ? 'agent_end' : 'agent_settled',aborted:false})+'\n');continue;
    }
    if (command.message.startsWith('APIX_COORDINATOR_JSON\n') || command.message.startsWith('APIX_PLAN_JSON\n') || command.message.startsWith('APIX_GUIDE_JSON\n')) {
      let answer;
      if (command.message.startsWith('APIX_GUIDE_JSON\n')) {
        answer = {action:'guide',focus:'verification'};
      } else if (command.message.startsWith('APIX_PLAN_JSON\n')) {
        const employees = JSON.parse(command.message.split('\n员工：').at(-1).split('\n冻结架构：')[0]);
        answer = {steps:[{...(command.message.includes('冻结架构：')?{moduleId:'core'}:{}),prompt:command.message.includes('冻结架构：')?'fixture-autonomy: 实现 core 模块 a.txt 内容接口':'inspect coordination',employeeId:employees[0].id,dependsOn:[]}]};
        if(process.env.APIX_FIXTURE_PLAN_INVALID==='always' || process.env.APIX_FIXTURE_PLAN_INVALID==='once' && !command.message.includes('上次计划未通过宿主校验：'))answer.steps[0].dependsOn=[0];
      } else {
        const latest = command.message.split('用户最新消息：').at(-1).split('\n本次工具阶段的答复')[0];
        if(process.env.APIX_FIXTURE_NON_JSON_AFTER_TOOLS==='1' && process.argv.includes('--tools')){
          if(!process.argv.includes('--append-system-prompt'))throw new Error('Manager JSON system instruction missing');
          process.stdout.write(JSON.stringify({type:'tool_execution_start',toolName:'read'})+'\n');
          process.stdout.write(JSON.stringify({type:'tool_execution_end',toolName:'read',isError:false})+'\n');
          process.stdout.write(JSON.stringify({type:'message_end',message:{role:'assistant',stopReason:'stop',content:[{type:'text',text:'已读取项目，准备安排任务。'}]}})+'\n');
          process.stdout.write(JSON.stringify({type:'agent_end'})+'\n');continue;
        }
        if(latest==='fixture-manager-tools' || latest==='fixture-manager-wait'){
          const tools=process.argv.includes('--tools')?process.argv[process.argv.indexOf('--tools')+1].split(','):[];
          if(process.env.APIX_FIXTURE_MANAGER_LOG)writeFileSync(process.env.APIX_FIXTURE_MANAGER_LOG,JSON.stringify({tools,cwd:process.cwd()}));
          if(latest==='fixture-manager-wait')continue;
          if(tools.includes('read')){
            readFileSync('README.md','utf8');
            process.stdout.write(JSON.stringify({type:'tool_execution_start',toolName:'read',args:{path:'README.md'}})+'\n');
            process.stdout.write(JSON.stringify({type:'tool_execution_end',toolName:'read',isError:false})+'\n');
          }
          if(tools.includes('write'))writeFileSync('manager-tool-fixture.txt','manager write fixture');
          answer={kind:'progress',question:`实际提供工具：${tools.join(',') || '无'}`,updates:[],conflicts:[]};
        }
        let values = {}; try { values = JSON.parse(latest); } catch {}
        answer ??= {kind:latest.startsWith('开始工作')?'work':latest.includes('进度')?'progress':'clarification',question:'请检查这些需求，是否还有需要调整的约束？',updates:Object.entries(values).map(([field,value])=>({field,value,evidence:value})),conflicts:latest.includes('conflict')?['范围与交付物存在冲突']:[]};
        if (latest === 'fixture-long-reply') answer.question = '这是较长的自然回复。\n'.repeat(160) + '结束。';
        if (latest === 'fixture-context') {
          const history = JSON.parse(command.message.split('\n历史：')[1].split('\n真实进度：')[0]);
          answer.question = `前文：${history.filter(turn=>turn.role==='user').map(turn=>turn.content).join('；')}`;
        }
        if (latest === 'fixture-invalid-reply') answer.kind = 'invalid';
        if (latest === 'fixture-progress-state') {
          answer.kind = 'progress';
          answer.question = command.message.split('\n真实进度：')[1].split('\n用户最新消息：')[0];
        }
      }
      if (process.env.APIX_FIXTURE_STREAM === '1' && command.message.startsWith('APIX_COORDINATOR_JSON\n')) {
        const raw=JSON.stringify(answer);
        const delay = Number(process.env.APIX_FIXTURE_STREAM_DELAY_MS ?? 10);
        const parts = [raw.slice(0,20),raw.slice(20,48),raw.slice(48)];
        parts.forEach((part,index)=>setTimeout(()=>process.stdout.write(JSON.stringify({type:'message_update',assistantMessageEvent:{type:'text_delta',delta:part}})+'\n'),delay*index));
        setTimeout(()=>{process.stdout.write(JSON.stringify({type:'message_end',message:{role:'assistant',stopReason:command.message.endsWith('用户最新消息：fixture-runtime-error')?'error':'stop',content:[{type:'text',text:raw}]}})+'\n');process.stdout.write(JSON.stringify({type:process.env.APIX_FIXTURE_MODERN_PI === '1' ? 'agent_end' : 'agent_settled',aborted:false})+'\n');},delay*3);
      } else {
        setTimeout(()=>{
        process.stdout.write(JSON.stringify({type:'message_end',message:{role:'assistant',stopReason:'stop',content:[{type:'text',text:JSON.stringify(answer)}]}})+'\n');
        process.stdout.write(JSON.stringify({type:process.env.APIX_FIXTURE_MODERN_PI === '1' ? 'agent_end' : 'agent_settled',aborted:false})+'\n');
        },command.message.startsWith('APIX_PLAN_JSON\n')?Number(process.env.APIX_FIXTURE_PLAN_DELAY_MS??0):0);
      }
      continue;
    }
    if (command.message.startsWith("APIX_DIRECTOR_JSON\n")) {
      const latest = command.message.split("用户最新消息：").at(-1);
      const employees = JSON.parse(command.message.match(/可用员工：(.*?)\n当前计划与任务状态：/)?.[1] ?? "[]");
      const answer = latest.includes("进度") ? { reply: "这是当前计划的状态摘要。", goal: "", steps: [], memoryCandidates: [] } : { reply: "我已整理目标和执行顺序，请检查员工与依赖。", goal: latest, steps: [{ prompt: `设计：${latest}`, employeeId: employees[0]?.id, dependsOn: [] }, { prompt: `实现并验证：${latest}`, employeeId: employees[1]?.id ?? employees[0]?.id, dependsOn: [0] }], memoryCandidates: [{ category: "需求", title: "多语言目标", content: "用户要求多语言支持", evidence: "多语言" }] };
      process.stdout.write(JSON.stringify({ type: "message_end", message: { role: "assistant", stopReason: "stop", content: [{ type: "text", text: JSON.stringify(answer) }] } }) + "\n");
      process.stdout.write(JSON.stringify({type:process.env.APIX_FIXTURE_MODERN_PI === '1' ? 'agent_end' : 'agent_settled',aborted:false})+'\n');
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
    process.stdout.write(JSON.stringify({type:process.env.APIX_FIXTURE_MODERN_PI === '1' ? 'agent_end' : 'agent_settled',aborted:false})+'\n');
  }
});
