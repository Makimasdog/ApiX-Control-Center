import {existsSync} from 'node:fs';
import {fileURLToPath} from 'node:url';

export function loadEnvironment(path=fileURLToPath(new URL('../../.env',import.meta.url))) {
  if(existsSync(path))process.loadEnvFile(path);
  // The settings validator uses uppercase names; the existing .env uses ali_api_key.
  if(!process.env.APIX_ALI_API_KEY && process.env.ali_api_key)process.env.APIX_ALI_API_KEY=process.env.ali_api_key;
}

export function workerEnvironment(source, runtime, managerKey) {
  const keyNames=new Set(['APIX_ALI_API_KEY','ALI_API_KEY',...(Array.isArray(managerKey)?managerKey:[managerKey]).map(key=>String(key??'').toUpperCase())]);
  const managerValues=new Set(Object.entries(source).filter(([name,value])=>keyNames.has(name.toUpperCase()) && value).map(([,value])=>value));
  const credentials={codex:['OPENAI_API_KEY','CODEX_API_KEY'],claude:['ANTHROPIC_API_KEY','ANTHROPIC_AUTH_TOKEN','CLAUDE_CODE_OAUTH_TOKEN'],gemini:['GEMINI_API_KEY','GOOGLE_API_KEY'],kimi:['KIMI_API_KEY','MOONSHOT_API_KEY']};
  const sharedCredentials=['OPENAI_API_KEY','ANTHROPIC_API_KEY','ANTHROPIC_AUTH_TOKEN','GEMINI_API_KEY','GOOGLE_API_KEY','KIMI_API_KEY','MOONSHOT_API_KEY'];
  const workerKeys=new Set(['pi','opencode'].includes(runtime)?sharedCredentials:Object.hasOwn(credentials,runtime)?credentials[runtime]:[]);
  const environment={};
  for(const [name,value] of Object.entries(source)) {
    const upper=name.toUpperCase();
    const secret=keyNames.has(upper) || value && managerValues.has(value);
    if(secret && value && workerKeys.has(upper))throw Object.assign(new Error(`员工 ${runtime} 的 ${upper} 与管理者凭据共用；请配置不同的管理者密钥（使用 APIX_MANAGER_* 变量）与员工密钥，或移除员工共用变量并使用其独立登录后重试`),{code:'WORKER_CREDENTIAL_CONFLICT'});
    if(secret || /^APIX_(?:.*_ENTRY|DATA_DIR|MANAGER_.*|AGENT_TOKEN|PROJECT_ID|AGENT_ID|TASK_ID|RUN_ID|MAILBOX_URL)$/.test(upper))continue;
    environment[name]=value;
  }
  return environment;
}
