// API 路由表(P7):每条路由一行,集中声明方法、路径模式、请求体限额与处理函数;server.mjs 只保留执行管线。
// 请求体限额(P13):对话消息类 256KB(字节,覆盖粘贴长日志)、配置类 64KB、知识上传 1.5MB(见 server.mjs 知识域)、
// 其余默认 30000 字符。方法不匹配回 405,路径未注册回 404;legacy:true 的路由在未设 APIX_LEGACY_API=1 时回 409。
// 处理器收到 ctx = { req, res, m(正则捕获组), query, body(POST 已解析), send };raw:true 表示处理器自行写响应(SSE/ETag)。
import {ToolError} from '../../dist/src/assistant/tool-governance.js';
import {browseFolders} from '../projects/project-folders.mjs';
import {projectMemoryState,saveProjectMemorySettings,assistantContext,assistantCompact} from '../../control-plane.mjs';
import {assistantProjectDiagnosis,assistantNpmProposal,assistantApproveNpm} from '../../control-plane.mjs';
import {conversationModel,saveConversationModel} from '../../control-plane.mjs';
import {listAgentProviders,saveAgentProvider,bindAgentProvider,removeAgentProvider,adoptAgentProvider} from '../../control-plane.mjs';
import {inspectEmployeeRuntime} from '../../control-plane.mjs';
import {mcpServers,saveMcpServer,discoverMcpTools} from '../../control-plane.mjs';
import {assistantOutput,assistantLogOutput} from '../../control-plane.mjs';
import {assistantStartTask,assistantDelivery,assistantDeliveryFile,assistantReviewDelivery} from '../../control-plane.mjs';
import {chatHistory,changeChatHistory} from '../../control-plane.mjs';
import { snapshot, scanRuntimes, taskDetails, registerEmployee, updateEmployee, deleteEmployee, createProject, updateProject, createConversation, renameConversation, createTask, resumeTask, saveProjectProfile, createMemory, updateMemory, deleteMemory, searchMemories, createDirectorPlan, sendDirectorMessage, saveDirectorProposal, approveDirectorProposal, approveDirectorPlan, cancelPendingDirectorPlan, revisePendingPlanTask, resolveApproval, stopRun, acceptTask, createDepartment, updateDepartment, addRepository, saveWorkflowPack, workflowPack, createCollaborativePlan, createReviewMeeting, createManagerReview, prepareIntegration, applyIntegration, registerMailbox, listMailboxes, sendMessage, receiveMessages, ackMessage, nackMessage, completeMessage, rejectMessage, messageDetails, messageThread, messageEventsSince, acquireLock, renewLock, releaseLock, listLocks, attachMessageArtifact, freezeHistoricalDelivery } from '../../control-plane.mjs';
import { listCoordinationSessions, coordinationSessionDetails, createCoordinationSession, answerCoordinationSession, confirmCoordinationSession, dispatchCoordinationSession, reviseCoordinationSession, coordinationTimeline } from '../../control-plane.mjs';
import { discussCoordinationSession, setCoordinationInteractionMode, editCoordinationPlan, changePermission, permissionPolicy, managerSettings, saveManagerSettings, testManagerConnection, searchCoordinationMemory, employeeDetails } from '../../control-plane.mjs';
import { instructCoordinationEmployee, registerRuntimeAdapter, executionSettings, saveExecutionSettings, changeRuntimePause, recoverTask } from '../../control-plane.mjs';
import { BUILTIN_PROVIDERS } from '../../dist/src/models/model-providers.js';
import { schedulingAccount, resumeSchedulingAccount, employeeCapability, saveEmployeeCapability, schedulingView, saveSchedulingPolicy, settleSchedulingCost, runPlanningMeeting, applyPlanningMeeting } from '../../control-plane.mjs';
import { readLocalModels } from '../../dist/src/models/local-models.js';
import { workflowSettings, saveWorkflow, stopCoordinationSession, readiness, inspectTaskDelivery } from '../../control-plane.mjs';
import { autonomySettings, saveAutonomySettings, resumeAutonomySession } from '../../control-plane.mjs';
import { createAssistantSession, assistantSession, assistantSessions, assistantMessage, assistantReply, assistantStop, assistantResume, assistantEditMemory, assistantEvents } from '../../control-plane.mjs';
export const requiredProject = query => { const id=query.get('projectId'); if(!id?.trim()) throw new ToolError('INVALID_ARGUMENTS','缺少必需参数 projectId','correct_input'); return id; };
export const messageLimit=[262144,true], configLimit=[65536,true], defaultLimit=[30000,false];
const get=(pattern,handler,extra={})=>({method:'GET',pattern,handler,limit:null,...extra});
const post=(pattern,handler,limit=defaultLimit,extra={})=>({method:'POST',pattern,handler,limit,...extra});
export const apiRoutes=[
  // ===== 总览与事件流(raw:处理器自行写响应)=====
  get(/^\/api\/snapshot$/,({req,res})=>{const value=snapshot(req.headers['if-none-match']);if(value.notModified){res.writeHead(304,{'ETag':value.etag,'Cache-Control':'no-cache'});res.end();}else{res.writeHead(200,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-cache','ETag':value.etag});res.end(JSON.stringify(value.data));}},{raw:true}),
  get(/^\/api\/events\/stream$/,({req,res,query})=>{const projectId=requiredProject(query),agentId=query.get('agentId');let lastId=Number(req.headers['last-event-id']??query.get('after')??0)||0;const write=events=>{for(const event of events){res.write(`id: ${event.id}\nevent: ${event.event_type}\ndata: ${JSON.stringify(event)}\n\n`);lastId=event.id;}};const poll=()=>{try{write(messageEventsSince(projectId,agentId,lastId));}catch(error){res.write(`event: error\ndata: ${JSON.stringify({error:error.message})}\n\n`);clearInterval(timer);}};res.writeHead(200,{'Content-Type':'text/event-stream; charset=utf-8','Cache-Control':'no-cache, no-store',Connection:'keep-alive','X-Accel-Buffering':'no'});const timer=setInterval(poll,500);const heartbeat=setInterval(()=>res.write(`event: heartbeat\ndata: ${JSON.stringify({at:new Date().toISOString()})}\n\n`),15000);req.on('close',()=>{clearInterval(timer);clearInterval(heartbeat);});poll();},{raw:true}),
  post(/^\/api\/coordination\/sessions\/([^/]+)\/messages\/stream$/,async({res,m,body})=>{const emit=(type,value)=>{if(!res.destroyed)res.write(`event: ${type}\ndata: ${JSON.stringify(value)}\n\n`);};res.writeHead(200,{'Content-Type':'text/event-stream; charset=utf-8','Cache-Control':'no-cache, no-store',Connection:'keep-alive','X-Accel-Buffering':'no'});emit('start',{sessionId:m[1]});try{const result=await discussCoordinationSession(m[1],body,delta=>emit('delta',{text:delta}),tool=>emit('tool',tool));emit('complete',result);}catch(error){emit('error',{error:error.message});}res.end();},messageLimit,{raw:true}),
  // ===== 只读查询 =====
  get(/^\/api\/manager\/settings$/,()=>managerSettings()),
  get(/^\/api\/agent-providers$/,()=>listAgentProviders()),
  get(/^\/api\/chat-history$/,({query})=>chatHistory(requiredProject(query),query.get('view')??'active')),
  get(/^\/api\/project-folders$/,({query})=>browseFolders(query.get('path'))),
  get(/^\/api\/projects\/([^/]+)\/mcp$/,({m})=>mcpServers(m[1])),
  get(/^\/api\/assistant\/sessions\/([^/]+)\/events$/,({m,query})=>assistantEvents(m[1],query.get('before')??undefined)),
  get(/^\/api\/assistant\/sessions\/([^/]+)\/outputs\/([^/]+)$/,({m,query})=>assistantOutput(m[1],{id:m[2],offset:query.has('offset')?Number(query.get('offset')):0,limit:6000})),
  get(/^\/api\/assistant\/sessions\/([^/]+)\/logs\/([^/]+)$/,({m,query})=>assistantLogOutput(m[1],{operationId:m[2],channel:query.get('channel')??'stdout',mode:query.get('mode')??'head',offset:Number(query.get('offset')??0),limit:6000})),
  get(/^\/api\/assistant\/sessions\/([^/]+)\/deliveries\/([^/]+)$/,({m})=>assistantDelivery(m[1],m[2])),
  get(/^\/api\/assistant\/sessions\/([^/]+)\/deliveries\/([^/]+)\/files$/,({m,query})=>assistantDeliveryFile(m[1],m[2],{version:Number(query.get('version')),path:query.get('path'),side:query.get('side'),offset:Number(query.get('offset')??0)})),
  get(/^\/api\/conversation-models\/(assistant|coordination)\/([^/]+)$/,({m})=>conversationModel(m[1],m[2])),
  get(/^\/api\/assistant\/sessions\/([^/]+)\/project-diagnosis$/,({m})=>assistantProjectDiagnosis(m[1])),
  get(/^\/api\/assistant\/sessions$/,({query})=>assistantSessions(query.get('projectId')??'')),
  get(/^\/api\/assistant\/sessions\/([^/]+)$/,({m})=>assistantSession(m[1])),
  get(/^\/api\/readiness$/,async({query})=>readiness(query.get('projectId')??'')),
  get(/^\/api\/projects\/([^/]+)\/workflow$/,({m})=>workflowSettings(m[1])),
  get(/^\/api\/projects\/([^/]+)\/autonomy$/,({m})=>autonomySettings(m[1])),
  get(/^\/api\/manager\/providers$/,()=>({providers:BUILTIN_PROVIDERS})),
  get(/^\/api\/permissions$/,({query})=>permissionPolicy(query.get('projectId'),query.get('subject')??'apix')),
  get(/^\/api\/projects\/([^/]+)\/memory-state$/,({m})=>projectMemoryState(m[1])),
  get(/^\/api\/assistant\/sessions\/([^/]+)\/context$/,({m})=>assistantContext(m[1])),
  get(/^\/api\/coordination\/memory$/,({query})=>searchCoordinationMemory(query.get('projectId'),query.get('q')??'')),
  get(/^\/api\/coordination\/sessions$/,({query})=>listCoordinationSessions(query.get('projectId'),query.get('summary')==='1')),
  get(/^\/api\/coordination\/sessions\/([^/]+)\/timeline$/,({m,query})=>coordinationTimeline(m[1],query.has('at')?Number(query.get('at')):undefined)),
  get(/^\/api\/coordination\/sessions\/([^/]+)$/,({m})=>coordinationSessionDetails(m[1])),
  get(/^\/api\/memories\/search$/,({query})=>searchMemories(query.get('projectId'),query.get('q'))),
  get(/^\/api\/mailboxes$/,({query})=>listMailboxes(requiredProject(query))),
  get(/^\/api\/messages$/,({query})=>receiveMessages({projectId:query.get('projectId'),agentId:query.get('agentId'),limit:query.get('limit')})),
  get(/^\/api\/messages\/thread$/,({query})=>messageThread(query.get('projectId'),query.get('correlationId'),query.get('agentId'))),
  get(/^\/api\/messages\/([^/]+)$/,({m,query})=>messageDetails(m[1],query.get('agentId'))),
  get(/^\/api\/tasks\/([^/]+)\/details$/,({m})=>taskDetails(m[1])),
  get(/^\/api\/tasks\/([^/]+)\/delivery$/,async({m})=>inspectTaskDelivery(m[1])),
  get(/^\/api\/projects\/([^/]+)\/execution$/,({m})=>executionSettings(m[1])),
  get(/^\/api\/employees\/([^/]+)\/details$/,({m})=>employeeDetails(m[1])),
  get(/^\/api\/employees\/([^/]+)\/capabilities$/,({m})=>employeeCapability(m[1])),
  get(/^\/api\/projects\/([^/]+)\/scheduling$/,({m})=>schedulingView(m[1])),
  get(/^\/api\/packs\/([^/]+)$/,({m})=>workflowPack(m[1])),
  // ===== 对话与会话写操作(消息类限额 256KB)=====
  post(/^\/api\/conversation-models\/(assistant|coordination)\/([^/]+)$/,({m,body})=>saveConversationModel(m[1],m[2],body),configLimit),
  post(/^\/api\/assistant\/sessions\/([^/]+)\/npm-proposal$/,({m,body})=>assistantNpmProposal(m[1],body)),
  post(/^\/api\/assistant\/sessions\/([^/]+)\/npm-approval$/,({m,body})=>assistantApproveNpm(m[1],body)),
  post(/^\/api\/assistant\/sessions$/,({body})=>createAssistantSession(body)),
  post(/^\/api\/assistant\/sessions\/([^/]+)\/messages$/,({m,body})=>assistantMessage(m[1],body),messageLimit),
  post(/^\/api\/assistant\/sessions\/([^/]+)\/tasks$/,({m,body})=>assistantStartTask(m[1],body),messageLimit),
  post(/^\/api\/assistant\/sessions\/([^/]+)\/delivery-review$/,({m,body})=>assistantReviewDelivery(m[1],body),messageLimit),
  post(/^\/api\/assistant\/sessions\/([^/]+)\/reply$/,async({m,body})=>assistantReply(m[1],body),messageLimit),
  post(/^\/api\/assistant\/sessions\/([^/]+)\/stop$/,({m})=>assistantStop(m[1])),
  post(/^\/api\/assistant\/sessions\/([^/]+)\/resume$/,({m,body})=>assistantResume(m[1],body)),
  post(/^\/api\/assistant\/sessions\/([^/]+)\/compact$/,async({m,body})=>assistantCompact(m[1],body),messageLimit),
  post(/^\/api\/assistant\/sessions\/([^/]+)\/memory$/,({m,body})=>assistantEditMemory(m[1],body)),
  post(/^\/api\/projects\/([^/]+)\/memory-settings$/,({m,body})=>saveProjectMemorySettings(m[1],body),configLimit),
  post(/^\/api\/coordination\/sessions$/,({body})=>createCoordinationSession(body)),
  post(/^\/api\/coordination\/sessions\/([^/]+)\/messages$/,async({m,body})=>discussCoordinationSession(m[1],body),messageLimit),
  post(/^\/api\/coordination\/sessions\/([^/]+)\/mode$/,({m,body})=>setCoordinationInteractionMode(m[1],body)),
  post(/^\/api\/coordination\/sessions\/([^/]+)\/plan$/,({m,body})=>editCoordinationPlan(m[1],body),configLimit),
  post(/^\/api\/coordination\/sessions\/([^/]+)\/planning-meetings$/,async({m,body})=>runPlanningMeeting(m[1],body),configLimit),
  post(/^\/api\/coordination\/sessions\/([^/]+)\/planning-meetings\/apply$/,({m,body})=>applyPlanningMeeting(m[1],body)),
  post(/^\/api\/coordination\/sessions\/([^/]+)\/answers$/,({m,body})=>answerCoordinationSession(m[1],body),messageLimit),
  post(/^\/api\/coordination\/sessions\/([^/]+)\/confirm$/,async({m,body})=>confirmCoordinationSession(m[1],body),messageLimit),
  post(/^\/api\/coordination\/sessions\/([^/]+)\/dispatch$/,({m,body})=>dispatchCoordinationSession(m[1],body)),
  post(/^\/api\/coordination\/sessions\/([^/]+)\/revise$/,({m,body})=>reviseCoordinationSession(m[1],body),messageLimit),
  post(/^\/api\/coordination\/sessions\/([^/]+)\/instructions$/,({m,body})=>instructCoordinationEmployee(m[1],body),messageLimit),
  post(/^\/api\/coordination\/sessions\/([^/]+)\/autonomy\/resume$/,({m,body})=>resumeAutonomySession(m[1],body)),
  post(/^\/api\/coordination\/sessions\/([^/]+)\/stop$/,({m,body})=>stopCoordinationSession(m[1],body)),
  post(/^\/api\/chat-history\/(assistant|coordination)\/([^/]+)$/,({m,body})=>changeChatHistory(m[1],m[2],body)),
  // ===== 运行时、供应商与配置(配置类限额 64KB)=====
  post(/^\/api\/runtimes\/scan$/,()=>scanRuntimes()),
  post(/^\/api\/adapters$/,({body})=>registerRuntimeAdapter(body)),
  post(/^\/api\/employees\/([^/]+)\/runtime-info$/,async({m})=>inspectEmployeeRuntime(m[1])),
  post(/^\/api\/projects\/([^/]+)\/mcp$/,async({m,body})=>saveMcpServer(m[1],body),configLimit),
  post(/^\/api\/projects\/([^/]+)\/mcp\/discover$/,async({m})=>discoverMcpTools(m[1])),
  post(/^\/api\/permissions$/,({body})=>changePermission(body.projectId,body),configLimit),
  post(/^\/api\/manager\/settings$/,({body})=>saveManagerSettings(body),configLimit),
  post(/^\/api\/agent-providers$/,({body})=>saveAgentProvider(body),configLimit),
  post(/^\/api\/agent-providers\/bind$/,({body})=>bindAgentProvider(body),configLimit),
  post(/^\/api\/agent-providers\/adopt$/,({body})=>adoptAgentProvider(body),configLimit),
  post(/^\/api\/agent-providers\/remove$/,({body})=>removeAgentProvider(body),configLimit),
  post(/^\/api\/manager\/test$/,async({body})=>testManagerConnection(body),configLimit),
  post(/^\/api\/manager\/models$/,async({body})=>readLocalModels(body),configLimit),
  post(/^\/api\/projects\/([^/]+)\/workflow$/,({m,body})=>saveWorkflow(m[1],body),configLimit),
  post(/^\/api\/projects\/([^/]+)\/autonomy$/,({m,body})=>saveAutonomySettings(m[1],body),configLimit),
  post(/^\/api\/projects\/([^/]+)\/profile$/,({m,body})=>saveProjectProfile(m[1],body),configLimit),
  post(/^\/api\/projects\/([^/]+)\/execution$/,({m,body})=>saveExecutionSettings(m[1],body),configLimit),
  post(/^\/api\/projects\/([^/]+)\/execution\/runtime$/,({m,body})=>changeRuntimePause(m[1],body)),
  post(/^\/api\/scheduling\/accounts$/,({body})=>schedulingAccount(body),configLimit),
  post(/^\/api\/scheduling\/accounts\/resume$/,({body})=>resumeSchedulingAccount(body)),
  post(/^\/api\/employees\/([^/]+)\/capabilities$/,({m,body})=>saveEmployeeCapability(m[1],body),configLimit),
  post(/^\/api\/projects\/([^/]+)\/scheduling$/,({m,body})=>saveSchedulingPolicy(m[1],body),configLimit),
  post(/^\/api\/projects\/([^/]+)\/scheduling\/settle$/,({m,body})=>settleSchedulingCost(m[1],body)),
  post(/^\/api\/packs$/,({body})=>saveWorkflowPack(body),configLimit),
  // ===== 基础数据增删改 =====
  post(/^\/api\/projects$/,({body})=>({id:createProject(body)})),
  post(/^\/api\/projects\/([^/]+)$/,({m,body})=>{updateProject(m[1],body);return {updated:true};}),
  post(/^\/api\/employees$/,({body})=>({id:registerEmployee(body)})),
  post(/^\/api\/employees\/([^/]+)\/delete$/,({m})=>{deleteEmployee(m[1]);return {deleted:true};}),
  post(/^\/api\/employees\/([^/]+)$/,({m,body})=>{updateEmployee(m[1],body);return {updated:true};}),
  post(/^\/api\/conversations$/,({body})=>({id:createConversation(body)})),
  post(/^\/api\/conversations\/([^/]+)$/,({m,body})=>{renameConversation(m[1],body);return {updated:true};}),
  post(/^\/api\/memories$/,({body})=>({id:createMemory(body)})),
  post(/^\/api\/memories\/([^/]+)\/delete$/,({m,body})=>{deleteMemory(m[1],body);return {deleted:true};}),
  post(/^\/api\/memories\/([^/]+)$/,({m,body})=>updateMemory(m[1],body)),
  post(/^\/api\/departments$/,({body})=>({id:createDepartment(body)})),
  post(/^\/api\/departments\/([^/]+)$/,({m,body})=>{updateDepartment(m[1],body);return {updated:true};}),
  post(/^\/api\/repositories$/,({body})=>({id:addRepository(body)})),
  post(/^\/api\/integrations$/,({body})=>prepareIntegration(body)),
  post(/^\/api\/integrations\/([^/]+)\/apply$/,({m})=>applyIntegration(m[1])),
  // ===== 信箱、消息与锁 =====
  post(/^\/api\/mailboxes$/,({body})=>registerMailbox(body)),
  post(/^\/api\/messages$/,({body})=>sendMessage(body),messageLimit),
  post(/^\/api\/messages\/([^/]+)\/ack$/,({m,body})=>ackMessage(m[1],body)),
  post(/^\/api\/messages\/([^/]+)\/nack$/,({m,body})=>nackMessage(m[1],body)),
  post(/^\/api\/messages\/([^/]+)\/complete$/,({m,body})=>completeMessage(m[1],body)),
  post(/^\/api\/messages\/([^/]+)\/reject$/,({m,body})=>rejectMessage(m[1],body)),
  post(/^\/api\/messages\/([^/]+)\/attachments$/,({m,body})=>attachMessageArtifact(m[1],body),configLimit),
  post(/^\/api\/locks\/acquire$/,({body})=>acquireLock(body)),
  post(/^\/api\/locks$/,({body})=>listLocks(body.projectId,body.includeReleased===true)),
  post(/^\/api\/locks\/([^/]+)\/renew$/,({m,body})=>renewLock(m[1],body)),
  post(/^\/api\/locks\/([^/]+)\/release$/,({m,body})=>releaseLock(m[1],body)),
  // ===== 执行控制 =====
  post(/^\/api\/approvals\/([^/]+)$/,({m,body})=>({runId:resolveApproval(m[1],body.approved===true)})),
  post(/^\/api\/runs\/([^/]+)\/stop$/,({m})=>{stopRun(m[1]);return {requested:true};}),
  post(/^\/api\/tasks\/([^/]+)\/review$/,({m,body})=>{acceptTask(m[1],body.accepted===true,body.fingerprint);return {reviewed:true};}),
  post(/^\/api\/tasks\/([^/]+)\/delivery$/,({m,body})=>freezeHistoricalDelivery(m[1],body),configLimit),
  post(/^\/api\/tasks\/([^/]+)\/recovery$/,async({m,body})=>recoverTask(m[1],body)),
  // ===== 旧接口(未设 APIX_LEGACY_API=1 时一律 409,引导去 ApiX 目标工作台)=====
  post(/^\/api\/tasks$/,({body})=>createTask(body),defaultLimit,{legacy:true}),
  post(/^\/api\/tasks\/([^/]+)\/resume$/,({m,body})=>resumeTask(m[1],body),defaultLimit,{legacy:true}),
  post(/^\/api\/tasks\/([^/]+)\/revise$/,({m,body})=>revisePendingPlanTask(m[1],body),defaultLimit,{legacy:true}),
  post(/^\/api\/director\/plans$/,({body})=>({id:createDirectorPlan(body)}),defaultLimit,{legacy:true}),
  post(/^\/api\/director\/messages$/,async({body})=>sendDirectorMessage(body),messageLimit,{legacy:true}),
  post(/^\/api\/director\/proposals\/([^/]+)\/approve$/,({m,body})=>approveDirectorProposal(m[1],body),configLimit,{legacy:true}),
  post(/^\/api\/director\/proposals\/([^/]+)$/,({m,body})=>saveDirectorProposal(m[1],body),configLimit,{legacy:true}),
  post(/^\/api\/director\/plans\/([^/]+)\/approve$/,({m,body})=>approveDirectorPlan(m[1],body),defaultLimit,{legacy:true}),
  post(/^\/api\/director\/plans\/([^/]+)\/cancel-pending$/,({m})=>cancelPendingDirectorPlan(m[1]),defaultLimit,{legacy:true}),
  post(/^\/api\/collaboration\/plans$/,({body})=>createCollaborativePlan(body),configLimit,{legacy:true}),
  post(/^\/api\/meetings$/,({body})=>({id:createReviewMeeting(body)}),configLimit,{legacy:true}),
  post(/^\/api\/manager-reviews$/,({body})=>createManagerReview(body),configLimit,{legacy:true}),
];
