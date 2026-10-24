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
    if(command.message.startsWith('APIX_COMPACT_JSON\n')){
      process.stdout.write(JSON.stringify({type:'message_end',message:{role:'assistant',stopReason:'stop',content:[{type:'text',text:JSON.stringify({summary:'已保留用户目标、约束、工具证据与未完成事项。'})}]}})+'\n');process.stdout.write('{"type":"agent_end"}\n');continue;
    }
    if(command.message.startsWith('APIX_AGENT_LOOP_JSON\n')){
      if(!process.argv.includes('--no-tools'))throw new Error('Assistant decisions must use the host tool registry');
      const context=JSON.parse(command.message.split('\n当前上下文：')[1]);const history=context.history;const message=history.filter(e=>e.role==='user'&&e.kind==='message').at(-1)?.body.content??'';
      let answer={action:'finish',outcome:'completed',message:'ApiX 已检查上下文并完成回答。'};
      const results=history.filter(e=>e.kind==='tool_result');
      const action=(tool,args)=>({action:'tool',tool,args,message:'正在执行 '+tool});
      if(history.some(e=>e.kind==='request_answer'&&e.body.approved===false))answer={action:'finish',outcome:'blocked',message:'用户拒绝了操作，未继续执行。'};
      else if(message.includes('fixture-loop-write')){
        const writes=history.filter(e=>e.kind==='tool_started'&&e.body.tool==='write_file');const last=results.at(-1);
        const trusted=message.includes('fixture-loop-write-trusted');
        if(trusted&&!context.verificationState.contract)answer=action('configure_verification',{checks:[{id:'tests',args:['verify.mjs'],timeoutMs:5000}],writablePaths:['a.txt']});
        else if(!writes.length)answer=action('write_file',{path:'a.txt',content:'bad'});
        else if(last?.body.tool==='write_file')answer=trusted?action('run_check',{checkId:'tests'}):action('verify',{executable:'node',args:['-e',"require('node:assert/strict').equal(require('node:fs').readFileSync('a.txt','utf8'),'good');console.log('actual verification passed')"]});
        else if(last?.body.result?.exitCode!==0)answer=action('write_file',{path:'a.txt',content:'good'});
        else answer={action:'finish',outcome:'completed',message:'已修复 a.txt，实际断言检查通过。'};
      }else if(message.includes('fixture-loop-delegate')){
        if(!context.context.workflow.enabled){answer=!results.some(e=>e.body.tool==='read_file')?action('read_file',{path:'verify.mjs'}):action('configure_agents',{runtimes:['codex'],profiles:[{runtime:'codex',model:'fixture-model',reasoningLevel:3,contextTokens:32000}],checks:[{id:'tests',args:['verify.mjs'],timeoutMs:5000}]});}
        else if(context.context.child)answer={action:'finish',outcome:'completed',message:'已核对当前委派，继续等待验收。'};
        else if(!history.some(e=>e.kind==='delegation_result'))answer=action('delegate',{goal:'实现 a.txt 内容接口',requirements:{scope:'仅实现 a.txt',constraints:'保留 verify.mjs，不扩大范围',deliverable:'a.txt 内容为 good',acceptance:'实际执行 verify.mjs，通过后对照冻结契约审查'}});
        else answer={action:'finish',outcome:'completed',message:'员工已完成修复、实际验证和集成验收。'};
      }else if(message.includes('fixture-loop-quota')){
        const inspected=results.some(e=>e.body.tool==='inspect_agents'),queried=results.some(e=>e.body.tool==='inspect_quota');answer=!inspected?action('inspect_agents',{}):!queried?action('inspect_quota',{employeeId:results.find(e=>e.body.tool==='inspect_agents').body.result.employees[0].id}):{action:'finish',outcome:'completed',message:'已读取真实运行时额度，未知信息不作推测。'};
      }else if(message.includes('fixture-loop-mcp')){
        const found=results.find(e=>e.body.tool==='search_tools');const called=results.find(e=>e.body.tool?.startsWith('mcp_'));const verified=results.find(e=>e.body.tool==='verify');
        answer=!found?action('search_tools',{query:'echo'}):!called?action(found.body.result.tools[0].name,{text:'工具回显验收'}):!verified?action('verify',{executable:'node',args:['-e',"const fs=require('node:fs'),assert=require('node:assert/strict');assert(fs.readFileSync('mcp-calls.jsonl','utf8').includes('echo'));console.log('MCP call evidence verified')"]}):{action:'finish',outcome:'completed',message:'MCP 回显和实际调用证据已核对。'};
      }else if(message.includes('fixture-loop-readlarge')){
        answer=!results.some(e=>e.body.tool==='read_file')?action('read_file',{path:'large.txt'}):{action:'finish',outcome:'completed',message:'大文件结果已保存，可分段核对完整内容。'};
      }else if(message.includes('fixture-loop-skill')){
        answer=!results.some(e=>e.body.tool==='load_skill')?action('load_skill',{id:context.context.skills[0].id}):!results.some(e=>e.body.tool==='remember')?action('remember',{title:'项目验证约定',content:'使用实际断言检查，不能把进程成功当作交付。',kind:'reference',evidence:'Use actual assertions.'}):{action:'finish',outcome:'completed',message:'已加载 Skill 并记录项目约定。'};
      }else if(message.includes('fixture-loop-choice')){
        const response=history.find(e=>e.kind==='request_answer');answer=response?{action:'finish',outcome:'completed',message:'选择已保存：'+JSON.stringify(response.body)}:{action:'ask',question:'本次包含哪些部分？',options:['后端','前端','文档'],multiple:true};
      }else if(message.includes('fixture-loop-read')&&!results.length)answer=action('read_file',{path:'README.md'});
      process.stdout.write(JSON.stringify({type:'message_end',message:{role:'assistant',stopReason:'stop',content:[{type:'text',text:JSON.stringify(answer)}]}})+'\n');process.stdout.write('{"type":"agent_end"}\n');continue;
    }
    if(command.message.startsWith('APIX_ARCHITECTURE_JSON\n') || command.message.startsWith('APIX_QUALITY_JSON\n')){
      if(!process.argv.includes('--no-tools'))throw new Error('Architecture/quality inference must not execute project tools');
      const answer=command.message.startsWith('APIX_ARCHITECTURE_JSON\n')?{summary:'fixture frozen architecture',modules:[{id:'core',name:'核心',paths:['a.txt'],dependsOn:[],risk:'high',difficulty:2,workload:{inputTokens:1000,outputTokens:500,calls:1},interfaces:[{name:'text',consumer:'external',protocol:'file',request:{type:'null'},response:{type:'string',const:'good'}}],dataStructures:[{name:'content',schema:{type:'string',const:'good'}}],acceptance:['a.txt 内容必须为 good'],checkIds:['tests']}]}:{passed:process.env.APIX_FIXTURE_QUALITY_FAIL!=='1',findings:process.env.APIX_FIXTURE_QUALITY_FAIL==='1'?['实际测试不足以证明交付符合内容接口，补齐实现与证据']:[]};
      const frames=JSON.stringify({type:'message_end',message:{role:'assistant',stopReason:'stop',content:[{type:'text',text:JSON.stringify(answer)}]}})+'\n'+JSON.stringify({type:'agent_end'})+'\n';
      if(command.message.startsWith('APIX_ARCHITECTURE_JSON\n')&&process.env.APIX_FIXTURE_ARCH_DELAY_MS)setTimeout(()=>process.stdout.write(frames),Number(process.env.APIX_FIXTURE_ARCH_DELAY_MS));else process.stdout.write(frames);continue;
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
    const taskDirective=command.message.split(/\r?\n/)[0];
    if (taskDirective === "hold" || process.env.APIX_FIXTURE_HOLD === '1') continue;
    if (command.message.startsWith("write-file:")) {
      const [filename, content] = taskDirective.slice(11).split(":", 2);
      if (!/^[a-z]\.txt$/.test(filename)) throw new Error("Invalid test filename");
      writeFileSync(filename, content);
    }
    if (taskDirective === "many-events") for (let number = 0; number < 350; number++) process.stdout.write(JSON.stringify({ type: "tool_execution_start", toolName: "read", args: { number } }) + "\n");
    process.stdout.write(JSON.stringify({ type: "message_end", message: { role: "assistant", stopReason: command.message.startsWith("provider-error") ? "error" : "stop", content: [{ type: "text", text: `Pi result: ${command.message}` }] } }) + "\n");
    process.stdout.write(JSON.stringify({type:process.env.APIX_FIXTURE_MODERN_PI === '1' ? 'agent_end' : 'agent_settled',aborted:false})+'\n');
  }
});
