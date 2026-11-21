import { execFileSync } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import {readFileSync,writeFileSync} from 'node:fs';

let prompt = "";
process.stdin.on("data", (chunk) => { prompt += chunk.toString(); });
process.stdin.on("end", async () => {
  if(prompt.includes('fixture-autonomy:'))writeFileSync('a.txt',prompt.includes('ApiX 修复任务')?'good':'bad');
  if(prompt.includes('fixture-codex-reconnect'))process.stdout.write(JSON.stringify({type:'error',message:'Reconnecting... 2/5 (request timed out)'})+'\n');
  if (prompt.split("\n")[0].trim() === "cli-error") { process.stderr.write("Codex fixture failed before a response.\n"); process.exitCode = 1; return; }
  if (!process.argv.includes("--skip-git-repo-check")) {
    try { execFileSync("git", ["rev-parse", "--show-toplevel"], { cwd: process.cwd(), stdio: "ignore" }); }
    catch { process.stderr.write("Not inside a trusted directory and --skip-git-repo-check was not specified.\n"); process.exitCode = 1; return; }
  }
  if (prompt.startsWith("hold-codex:")) await delay(2000);
  const modelIndex=process.argv.indexOf('--model');process.stdout.write(JSON.stringify({type:'thread.started',thread_id:'fake',...(modelIndex>=0?{model:process.argv[modelIndex+1]}:{})})+'\n');
  const task=prompt.split('\n',1)[0];
  if(task.includes('terminal-question')){
    const answer=prompt.match(/ApiX 已答复终端提问：([^\n]+)/)?.[1];
    if(!answer){
      process.stdout.write(JSON.stringify({type:'item.completed',item:{type:'agent_message',text:'我需要确认 a.txt 统一使用哪种换行？请回答 LF 或 CRLF。'}})+'\n');
    }else{
      writeFileSync('a.txt',answer==='LF'?'good\n':'good\r\n');
      process.stdout.write(JSON.stringify({type:'item.completed',item:{type:'agent_message',text:'已按 ApiX 答复继续并完成写入。'}})+'\n');
    }
    process.stdout.write('{"type":"turn.completed","usage":{"input_tokens":1,"output_tokens":1}}\n');
    return;
  }
  if(task.startsWith('接收全部已验收模块的冻结代码')){
    try{execFileSync(process.execPath,['verify.mjs'],{cwd:process.cwd(),stdio:'ignore'});}catch{
      const expected=readFileSync('verify.mjs','utf8').includes("'good\\n'")?'good\n':'good';
      writeFileSync('a.txt',expected);
    }
    process.stdout.write(JSON.stringify({type:'item.completed',item:{type:'agent_message',text:'已核对冻结模块并完成系统集成验收。'}})+'\n');
    process.stdout.write('{"type":"turn.completed","usage":{"input_tokens":1,"output_tokens":1}}\n');
    return;
  }
  if(task.startsWith('ask-cli-')){
    if(!prompt.includes('worker_question_answer'))throw new Error('缺少 CLI 提问约定');
    const business=task.startsWith('ask-cli-business'),early=task.startsWith('ask-cli-early');
    const question=business?'应使用哪种计费方案？':'a.txt 规定使用什么换行？';
    async function mailbox(path,body){
      const response=await fetch(process.env.APIX_MAILBOX_URL+path,{headers:{Authorization:'Bearer '+process.env.APIX_AGENT_TOKEN,'Content-Type':'application/json'},...(body===undefined?{}:{method:'POST',body:JSON.stringify(body)})});
      if(!response.ok)throw new Error('信箱请求失败：'+response.status+' '+await response.text());
      return await response.json();
    }
    const request={to:'apix-director',type:'request',idempotencyKey:'fixture-cli-question',payload:{kind:'worker_question',question,options:business?['月付','年付']:['LF','CRLF']}};
    const posted=await mailbox('/messages',request),duplicate=await mailbox('/messages',request);
    if(posted.status==='rejected'||duplicate.id!==posted.id||!duplicate.duplicate)throw new Error('问题未保存或重复登记');
    if(early){
      // 模拟尚未确认答复就退出；普通文本仍不得绕过信箱确认直接验收。
      process.stdout.write(JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: '这是一次不该自动接管的提前退出测试？' } }) + "\n");
      process.stdout.write('{"type":"turn.completed","usage":{"input_tokens":1,"output_tokens":1}}\n');
      return;
    }
    process.stdout.write(JSON.stringify({type:'item.completed',item:{type:'agent_message',text:question}})+'\n');
    const deadline=Date.now()+30000;
    let reply;
    while(Date.now()<deadline&&!reply){reply=(await mailbox('/messages')).find(m=>m.reply_to===posted.id&&m.payload.kind==='worker_question_answer');if(!reply)await delay(100);}
    if(reply?.payload.content!==(business?'月付':'LF'))throw new Error('没有收到正确答复');
    await mailbox('/messages/'+reply.id+'/complete',{});
    writeFileSync('a.txt','good');
    process.stdout.write(JSON.stringify({type:'item.completed',item:{type:'agent_message',text:'已完成写入。先前通过信箱请示「a.txt 规定使用什么换行？」并确认了 LF 答复。'}})+'\n');
    process.stdout.write('{"type":"turn.completed","usage":{"input_tokens":1,"output_tokens":1}}\n');
    return;
  }
  process.stdout.write(JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: `Codex result: ${prompt}` } }) + "\n");
  process.stdout.write('{"type":"turn.completed","usage":{"input_tokens":120,"cached_input_tokens":10,"output_tokens":34}}\n');
});
