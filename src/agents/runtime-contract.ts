import type {Command} from './runtime-adapters.js';
import {ToolError} from '../assistant/tool-governance.js';

export type RuntimeBackend='cli'|'codex-app-server'|'claude-agent-sdk';
export interface RuntimeCapabilities {
  steer:boolean;queue:boolean;questions:boolean;approvals:boolean;resume:boolean;usage:boolean;
  compatibility:'verified'|'unverified'|'incompatible';
}
export const cliCapabilities:RuntimeCapabilities={steer:false,queue:false,questions:false,approvals:false,resume:false,usage:true,compatibility:'verified'};
export interface RuntimeInput {
  command:Command;args:string[];cwd:string;env:NodeJS.ProcessEnv;
  runtime:string;format:'plain'|'jsonl';prompt:string;runId:string;
  fullAccess?:boolean;model?:string;resumeSessionId?:string;configArgs?:string[];
}
export type RuntimeTransportEvent=
  |{kind:'native';item:Record<string,any>}
  |{kind:'output'|'stderr'|'unparsed'|'trailing';text:string}
  |{kind:'error'|'stdin_error';message:string}
  |{kind:'batch';items:RuntimeTransportEvent[]}
  |{kind:'runtime';name:string;payload:Record<string,any>}
  |{kind:'closed';code:number|null;signal:NodeJS.Signals|null;evidence?:'quiescent'|'unknown';outcome?:'completed'|'failed'|'cancelled'};
export interface RunHandle {
  readonly events:AsyncIterable<RuntimeTransportEvent>;
  readonly pid:number|null;
  isActive():boolean;
  closeInput():void;
  interrupt():void;
  close():Promise<{evidence:'root_exited'|'quiescent'|'unknown'}>;
  send?(message:{messageId:string;content:string;mode:'steer'|'queue'}):Promise<{state:'accepted'|'queued'}>;
  answer?(id:string,answer:Record<string,any>):Promise<void>;
}

export function runtimeError(code:string,message:string,status=409){return new ToolError(code,message,'inspect_result',{},status);}
