// Shared input data for renderer unit tests and the isolated browser DOM checks.
export function rendererFixture(payload){
  const date='2026-10-25T00:00:00Z',citation='KB:space:document:1:0';
  const check={checkId:payload,passed:false,projectFingerprint:payload,checkContractVersion:payload,executionComplete:false,evidencePersisted:false,log:{complete:false},operationId:payload,npmValidation:{status:payload}};
  const task={id:'task-p9',project_id:'p9',plan_id:'plan-p9',employee_id:'p9',prompt:payload,status:'running',project_name:payload,created_at:date,updated_at:date};
  const employee={id:'p9',name:payload,role:payload,runtime:'codex',department:payload,enabled:1};
  const run={id:'run-p9',task_id:task.id,status:'running',started_at:date,ended_at:null,input_tokens:0,output_tokens:0,cached_tokens:0,usage_source:'fixture'};
  return {
    payload,citation,
    timeline:[
      {id:1,role:'user',kind:'message',body:{content:payload+' '+citation+' & '+citation}},
      {id:2,role:'system',kind:'tool_started',body:{tool:payload,args:{outputRef:payload}}},
      {id:3,role:'system',kind:'command_finished',body:{operationId:payload,exitCode:0,reason:payload,log:{complete:false,reason:null}}},
      {id:4,role:'tool',kind:'tool_result',body:{tool:'read_file',ok:true,result:{path:payload,content:payload,added:0,removed:null,outputRef:payload}}},
    ],
    review:{task:{id:payload,description:payload},history:[{id:payload,description:payload,version:0}],latestDelivery:{id:payload,version:0,status:'stale',staleReason:payload,requiresVerification:true,scope:{included:payload,excluded:[payload]},baselineVersion:payload,manifest:payload,netChanges:[{path:payload,kind:'modified',source:'agent_file_operations',beforeSha256:'before',afterSha256:'after',diff:payload,diffComplete:false}],verification:{verificationStatus:'failed',checks:[check]},feedback:[{comment:payload}]}},
    recovery:{status:'unknown',latestRun:{id:payload,status:payload,pid:null},processMayExist:null,managedActive:false,recoveryFingerprint:'fixture'},
    recoveryTask:{employee_id:payload,queue_reason:payload},employees:[{id:payload,name:payload,runtime:'codex'}],
    readiness:{projectId:'p9',checkedAt:date,canPlan:false,canExecute:false,authenticationVerified:false,checks:[{id:'model',state:'missing',message:payload,action:'model'},{id:'external',state:'check',message:payload,action:payload}]},
    threads:[{id:payload,project_id:'p9',kind:'assistant',title:payload,status:'idle',version:1}],
    employeeDetails:{employee,capability:{model:payload,version:1,accountId:null},accounts:[],tasks:[task],runs:[run],reports:[{id:'report-p9',taskId:task.id,summary:payload,blocked:true,createdAt:date}],usage:{inputTokens:0,outputTokens:0,cachedTokens:0,measuredRuns:1,totalRuns:1}},
    snapshot:{projects:[{id:'p9',name:payload}],tasks:[task],employees:[employee],departments:[{id:'department-p9',name:payload}],runs:[run]},
    goals:[{id:'goal-p9',title:payload,plan_id:task.plan_id,derivedStatus:'attention',status:'attention'}],
  };
}
