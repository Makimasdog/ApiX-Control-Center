import { execFileSync } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import {writeFileSync} from 'node:fs';

let prompt = "";
process.stdin.on("data", (chunk) => { prompt += chunk.toString(); });
process.stdin.on("end", async () => {
  if(prompt.includes('fixture-autonomy:'))writeFileSync('a.txt',prompt.includes('ApiX 修复任务')?'good':'bad');
  if(prompt.includes('fixture-codex-reconnect'))process.stdout.write(JSON.stringify({type:'error',message:'Reconnecting... 2/5 (request timed out)'})+'\n');
  if (prompt.trim() === "cli-error") { process.stderr.write("Codex fixture failed before a response.\n"); process.exitCode = 1; return; }
  if (!process.argv.includes("--skip-git-repo-check")) {
    try { execFileSync("git", ["rev-parse", "--show-toplevel"], { cwd: process.cwd(), stdio: "ignore" }); }
    catch { process.stderr.write("Not inside a trusted directory and --skip-git-repo-check was not specified.\n"); process.exitCode = 1; return; }
  }
  if (prompt.startsWith("hold-codex:")) await delay(2000);
  const modelIndex=process.argv.indexOf('--model');process.stdout.write(JSON.stringify({type:'thread.started',thread_id:'fake',...(modelIndex>=0?{model:process.argv[modelIndex+1]}:{})})+'\n');
  process.stdout.write(JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: `Codex result: ${prompt}` } }) + "\n");
  process.stdout.write('{"type":"turn.completed","usage":{"input_tokens":120,"cached_input_tokens":10,"output_tokens":34}}\n');
});
