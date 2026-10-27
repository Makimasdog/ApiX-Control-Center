/**
 * API 路由注册表 (API Routes) - 集中声明所有 HTTP 路由的方法、路径模式、限额与处理器
 *
 * 所属层级：基础设施层
 * 核心功能：
 *   - 集中管理 140+ 条 API 路由声明，server.mjs 只保留执行管线
 *   - 每条路由声明包含：HTTP 方法、URL 正则模式、请求体限额、处理函数、可选标志
 *   - 请求体限额分三档：对话消息 256KB、配置类 64KB、其余默认 30000 字符
 *   - 支持 legacy 标志：未设 APIX_LEGACY_API=1 时旧接口返回 409
 *   - 支持 raw 标志：处理器自行写响应（用于 SSE、ETag 等流式场景）
 * 依赖关系：
 *   - 被 [→ 见 server.mjs] 的路由匹配管线消费
 *   - 导入 [→ 见 control-plane.mjs] 的大量业务处理函数
 *   - 导入 [→ 见 src/infrastructure/change-bus.mjs] 用于 SSE 事件订阅
 *   - 导入 [→ 见 src/projects/project-folders.mjs] 用于目录浏览
 *   - 导入 [→ 见 src/models/] 用于模型供应商和本地模型查询
 *   - 导入 [→ 见 src/assistant/tool-governance.ts] 的 ToolError 用于参数校验
 *
 * 路由分组说明（按功能域划分）：
 *   1. 总览与事件流 — snapshot、SSE 事件推送、协调会话流式消息
 *   2. 只读查询 — GET 接口，查询配置/状态/历史
 *   3. 对话与会话写操作 — POST 接口，消息发送/会话管理/协调讨论
 *   4. 运行时、供应商与配置 — 员工运行时、MCP、权限、模型供应商等配置
 *   5. 基础数据增删改 — 项目/员工/对话/记忆/部门/仓库/集成
 *   6. 信箱、消息与锁 — Mailbox 消息系统与租约锁
 *   7. 执行控制 — 审批、停止、验收、恢复
 *   8. 旧接口 — legacy:true 标记，引导迁移到新的协调会话 API
 */
import {ToolError} from '../../dist/src/assistant/tool-governance.js';
import {changeBus} from './change-bus.mjs';
import {browseFolders} from '../projects/project-folders.mjs';
// ── 控制面业务函数导入（来自 control-plane.mjs）──
// 项目记忆与助手上下文
import {projectMemoryState,saveProjectMemorySettings,assistantContext,assistantCompact,assistantOptimization} from '../../control-plane.mjs';
// 项目诊断与 npm 管理
import {assistantProjectDiagnosis,assistantNpmProposal,assistantApproveNpm} from '../../control-plane.mjs';
// 对话模型配置
import {conversationModel,saveConversationModel} from '../../control-plane.mjs';
// Agent 供应商管理
import {listAgentProviders,saveAgentProvider,bindAgentProvider,removeAgentProvider,adoptAgentProvider} from '../../control-plane.mjs';
// 员工运行时检测
import {inspectEmployeeRuntime} from '../../control-plane.mjs';
// MCP 服务器管理
import {mcpServers,saveMcpServer,discoverMcpTools} from '../../control-plane.mjs';
// 助手输出与日志
import {assistantOutput,assistantLogOutput} from '../../control-plane.mjs';
// 任务启动与交付
import {assistantStartTask,assistantDelivery,assistantDeliveryFile,assistantReviewDelivery} from '../../control-plane.mjs';
// 聊天历史
import {chatHistory,changeChatHistory} from '../../control-plane.mjs';
// 核心数据操作（项目/员工/对话/记忆/任务/消息/锁等）
import { snapshot, scanRuntimes, taskDetails, registerEmployee, updateEmployee, deleteEmployee, createProject, updateProject, createConversation, renameConversation, createTask, resumeTask, saveProjectProfile, createMemory, updateMemory, deleteMemory, searchMemories, createDirectorPlan, sendDirectorMessage, saveDirectorProposal, approveDirectorProposal, approveDirectorPlan, cancelPendingDirectorPlan, revisePendingPlanTask, resolveApproval, stopRun, acceptTask, createDepartment, updateDepartment, addRepository, saveWorkflowPack, workflowPack, createCollaborativePlan, createReviewMeeting, createManagerReview, prepareIntegration, applyIntegration, registerMailbox, listMailboxes, sendMessage, receiveMessages, ackMessage, nackMessage, completeMessage, rejectMessage, messageDetails, messageThread, messageEventsSince, acquireLock, renewLock, releaseLock, listLocks, attachMessageArtifact, freezeHistoricalDelivery } from '../../control-plane.mjs';
// 协调会话管理
import { listCoordinationSessions, coordinationSessionDetails, createCoordinationSession, answerCoordinationSession, confirmCoordinationSession, dispatchCoordinationSession, reviseCoordinationSession, coordinationTimeline } from '../../control-plane.mjs';
// 协调讨论、权限与管理者设置
import { discussCoordinationSession, setCoordinationInteractionMode, editCoordinationPlan, changePermission, permissionPolicy, managerSettings, saveManagerSettings, testManagerConnection, searchCoordinationMemory, employeeDetails } from '../../control-plane.mjs';
// 协调员工指令、运行时适配器与执行设置
import { instructCoordinationEmployee, registerRuntimeAdapter, executionSettings, saveExecutionSettings, changeRuntimePause, recoverTask } from '../../control-plane.mjs';
// 内置模型供应商常量
import { BUILTIN_PROVIDERS } from '../../dist/src/models/model-providers.js';
// 排程与能力管理
import { schedulingAccount, resumeSchedulingAccount, employeeCapability, saveEmployeeCapability, schedulingView, saveSchedulingPolicy, settleSchedulingCost, runPlanningMeeting, applyPlanningMeeting } from '../../control-plane.mjs';
// 本地模型扫描
import { readLocalModels } from '../../dist/src/models/local-models.js';
// 工作流、自治与就绪检查
import { workflowSettings, saveWorkflow, stopCoordinationSession, readiness, inspectTaskDelivery } from '../../control-plane.mjs';
// 自治设置
import { autonomySettings, saveAutonomySettings, resumeAutonomySession } from '../../control-plane.mjs';
// 助手会话管理
import { createAssistantSession, assistantSession, assistantSessions, assistantMessage, assistantReply, assistantStop, assistantResume, assistantEditMemory, assistantEvents } from '../../control-plane.mjs';

/**
 * requiredProject - 从查询参数中提取必需的 projectId
 * @param {URLSearchParams} query - 请求的查询参数
 * @returns {string} 非空的 projectId 值
 * @throws {ToolError} 缺少 projectId 时抛出 INVALID_ARGUMENTS 错误
 */
export const requiredProject = query => { const id=query.get('projectId'); if(!id?.trim()) throw new ToolError('INVALID_ARGUMENTS','缺少必需参数 projectId','correct_input'); return id; };

/**
 * 请求体限额常量（三档）
 * - messageLimit: 256KB，用于对话消息类（覆盖粘贴长日志的场景）
 * - configLimit: 64KB，用于配置类（供应商设置、MCP 配置等）
 * - defaultLimit: 30000 字符，用于其余默认场景
 *
 * 每项为 [数值, 是否按字节] 元组：true 表示按字节计算限额，false 表示按字符数
 */
export const messageLimit=[262144,true], configLimit=[65536,true], defaultLimit=[30000,false];

/**
 * get - 创建一条 GET 路由声明
 * @param {RegExp} pattern - URL 匹配正则（支持捕获组，捕获结果传入处理器的 m 参数）
 * @param {Function} handler - 处理函数，接收 ctx 对象
 * @param {Object} extra - 额外选项（如 raw:true 表示处理器自行写响应）
 * @returns {Object} 路由声明对象 { method, pattern, handler, limit:null, ...extra }
 */
const get=(pattern,handler,extra={})=>({method:'GET',pattern,handler,limit:null,...extra});

/**
 * post - 创建一条 POST 路由声明
 * @param {RegExp} pattern - URL 匹配正则
 * @param {Function} handler - 处理函数
 * @param {Array} limit - 请求体限额 [数值, 是否按字节]，默认 defaultLimit
 * @param {Object} extra - 额外选项（如 legacy:true 标记旧接口）
 * @returns {Object} 路由声明对象
 */
const post=(pattern,handler,limit=defaultLimit,extra={})=>({method:'POST',pattern,handler,limit,...extra});

/**
 * apiRoutes - 全量路由注册表
 *
 * 每条路由为一行紧凑声明，格式：方法(正则, 处理器, [限额], [额外选项])
 * 处理器收到的 ctx 对象：{ req, res, m(正则捕获组), query, body(POST 已解析), send }
 *
 * server.mjs 负责执行管线：匹配路由 → 解析参数 → 检查限额 → 调用处理器 → 序列化响应
 */
export const apiRoutes=[
  // ===== 总览与事件流 =====
  // raw:true 表示处理器自行写响应头和数据流（SSE/ETag），server.mjs 不再自动序列化
  //
  // 全局快照：支持 ETag 条件请求，未修改时返回 304 节省带宽
  get(/^\/api\/snapshot$/,({req,res})=>{const value=snapshot(req.headers['if-none-match']);if(value.notModified){res.writeHead(304,{'ETag':value.etag,'Cache-Control':'no-cache'});res.end();}else{res.writeHead(200,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-cache','ETag':value.etag});res.end(JSON.stringify(value.data));}},{raw:true}),
  //
  // SSE 事件流：按项目订阅增量变更，替代固定轮询
  // 机制：changeBus 订阅 + 30s 兜底轮询 + 15s 心跳保活
  // 支持 Last-Event-ID 断点续传（从 req.headers 或 query 参数获取）
  get(/^\/api\/events\/stream$/,({req,res,query})=>{const projectId=requiredProject(query),agentId=query.get('agentId');let lastId=Number(req.headers['last-event-id']??query.get('after')??0)||0;const write=events=>{for(const event of events){res.write(`id: ${event.id}\nevent: ${event.event_type}\ndata: ${JSON.stringify(event)}\n\n`);lastId=event.id;}};let stopped=false,debounce=null;const stop=()=>{stopped=true;clearTimeout(debounce);clearInterval(fallback);clearInterval(heartbeat);unsubscribe();};const poll=()=>{if(stopped)return;try{write(messageEventsSince(projectId,agentId,lastId));}catch(error){if(!res.destroyed)res.write(`event: error\ndata: ${JSON.stringify({error:error.message})}\n\n`);stop();}};const schedule=()=>{if(stopped||debounce)return;debounce=setTimeout(()=>{debounce=null;poll();},50);};res.writeHead(200,{'Content-Type':'text/event-stream; charset=utf-8','Cache-Control':'no-cache, no-store',Connection:'keep-alive','X-Accel-Buffering':'no'});const unsubscribe=changeBus.subscribe(change=>{if(!change.projectId||change.projectId===projectId)schedule();});const fallback=setInterval(poll,30000);const heartbeat=setInterval(()=>{if(!res.destroyed)res.write(`event: heartbeat\ndata: ${JSON.stringify({at:new Date().toISOString()})}\n\n`);},15000);req.on('close',stop);poll();},{raw:true}),
  //
  // 协调会话流式消息：SSE 推送 AI 推理的增量文本（delta）、工具调用（tool）和完成事件
  post(/^\/api\/coordination\/sessions\/([^/]+)\/messages\/stream$/,async({res,m,body})=>{const emit=(type,value)=>{if(!res.destroyed)res.write(`event: ${type}\ndata: ${JSON.stringify(value)}\n\n`);};res.writeHead(200,{'Content-Type':'text/event-stream; charset=utf-8','Cache-Control':'no-cache, no-store',Connection:'keep-alive','X-Accel-Buffering':'no'});emit('start',{sessionId:m[1]});try{const result=await discussCoordinationSession(m[1],body,delta=>emit('delta',{text:delta}),tool=>emit('tool',tool));emit('complete',result);}catch(error){emit('error',{error:error.message});}res.end();},messageLimit,{raw:true}),

  // ===== 只读查询（GET 接口）=====
  // 管理者设置与 Agent 供应商
  get(/^\/api\/manager\/settings$/,()=>managerSettings()),
  get(/^\/api\/agent-providers$/,()=>listAgentProviders()),
  // 聊天历史（支持 view 参数切换活跃/归档视图）
  get(/^\/api\/chat-history$/,({query})=>chatHistory(requiredProject(query),query.get('view')??'active')),
  // 项目目录浏览
  get(/^\/api\/project-folders$/,({query})=>browseFolders(query.get('path'))),
  // 项目级 MCP 服务器列表
  get(/^\/api\/projects\/([^/]+)\/mcp$/,({m})=>mcpServers(m[1])),
  // 助手会话事件历史（支持 before 游标分页）
  get(/^\/api\/assistant\/sessions\/([^/]+)\/events$/,({m,query})=>assistantEvents(m[1],query.get('before')??undefined)),
  // 助手会话的输出内容（支持 offset 分页，默认限制 6000 字符）
  get(/^\/api\/assistant\/sessions\/([^/]+)\/outputs\/([^/]+)$/,({m,query})=>assistantOutput(m[1],{id:m[2],offset:query.has('offset')?Number(query.get('offset')):0,limit:6000})),
  // 助手会话的日志输出（支持 channel/mode/offset 参数）
  get(/^\/api\/assistant\/sessions\/([^/]+)\/logs\/([^/]+)$/,({m,query})=>assistantLogOutput(m[1],{operationId:m[2],channel:query.get('channel')??'stdout',mode:query.get('mode')??'head',offset:Number(query.get('offset')??0),limit:6000})),
  // 助手交付物详情与文件列表
  get(/^\/api\/assistant\/sessions\/([^/]+)\/deliveries\/([^/]+)$/,({m})=>assistantDelivery(m[1],m[2])),
  get(/^\/api\/assistant\/sessions\/([^/]+)\/deliveries\/([^/]+)\/files$/,({m,query})=>assistantDeliveryFile(m[1],m[2],{version:Number(query.get('version')),path:query.get('path'),side:query.get('side'),offset:Number(query.get('offset')??0)})),
  // 对话模型配置查询（assistant 或 coordination 类型）
  get(/^\/api\/conversation-models\/(assistant|coordination)\/([^/]+)$/,({m})=>conversationModel(m[1],m[2])),
  // 项目诊断信息
  get(/^\/api\/assistant\/sessions\/([^/]+)\/project-diagnosis$/,({m})=>assistantProjectDiagnosis(m[1])),
  // 助手会话列表与会话详情
  get(/^\/api\/assistant\/sessions$/,({query})=>assistantSessions(query.get('projectId')??'')),
  get(/^\/api\/assistant\/sessions\/([^/]+)$/,({m})=>assistantSession(m[1])),
  // 就绪检查（员工/项目是否准备好执行任务）
  get(/^\/api\/readiness$/,async({query})=>readiness(query.get('projectId')??'')),
  // 项目级工作流与自治设置
  get(/^\/api\/projects\/([^/]+)\/workflow$/,({m})=>workflowSettings(m[1])),
  get(/^\/api\/projects\/([^/]+)\/autonomy$/,({m})=>autonomySettings(m[1])),
  // 内置模型供应商列表
  get(/^\/api\/manager\/providers$/,()=>({providers:BUILTIN_PROVIDERS})),
  // 权限策略查询
  get(/^\/api\/permissions$/,({query})=>permissionPolicy(query.get('projectId'),query.get('subject')??'apix')),
  // 项目记忆状态与助手上下文
  get(/^\/api\/projects\/([^/]+)\/memory-state$/,({m})=>projectMemoryState(m[1])),
  get(/^\/api\/assistant\/sessions\/([^/]+)\/context$/,({m})=>assistantContext(m[1])),
  // 协调会话相关查询
  get(/^\/api\/coordination\/memory$/,({query})=>searchCoordinationMemory(query.get('projectId'),query.get('q')??'')),
  get(/^\/api\/coordination\/sessions$/,({query})=>listCoordinationSessions(query.get('projectId'),query.get('summary')==='1')),
  get(/^\/api\/coordination\/sessions\/([^/]+)\/timeline$/,({m,query})=>coordinationTimeline(m[1],query.has('at')?Number(query.get('at')):undefined)),
  get(/^\/api\/coordination\/sessions\/([^/]+)$/,({m})=>coordinationSessionDetails(m[1])),
  // 记忆搜索
  get(/^\/api\/memories\/search$/,({query})=>searchMemories(query.get('projectId'),query.get('q'))),
  // Mailbox 与消息查询
  get(/^\/api\/mailboxes$/,({query})=>listMailboxes(requiredProject(query))),
  get(/^\/api\/messages$/,({query})=>receiveMessages({projectId:query.get('projectId'),agentId:query.get('agentId'),limit:query.get('limit')})),
  get(/^\/api\/messages\/thread$/,({query})=>messageThread(query.get('projectId'),query.get('correlationId'),query.get('agentId'))),
  get(/^\/api\/messages\/([^/]+)$/,({m,query})=>messageDetails(m[1],query.get('agentId'))),
  // 任务详情与交付检查
  get(/^\/api\/tasks\/([^/]+)\/details$/,({m})=>taskDetails(m[1])),
  get(/^\/api\/tasks\/([^/]+)\/delivery$/,async({m})=>inspectTaskDelivery(m[1])),
  // 员工与排程查询
  get(/^\/api\/projects\/([^/]+)\/execution$/,({m})=>executionSettings(m[1])),
  get(/^\/api\/employees\/([^/]+)\/details$/,({m})=>employeeDetails(m[1])),
  get(/^\/api\/employees\/([^/]+)\/capabilities$/,({m})=>employeeCapability(m[1])),
  get(/^\/api\/projects\/([^/]+)\/scheduling$/,({m})=>schedulingView(m[1])),
  // 工作流包查询
  get(/^\/api\/packs\/([^/]+)$/,({m})=>workflowPack(m[1])),

  // ===== 对话与会话写操作（消息类限额 256KB）=====
  // 对话模型配置保存
  post(/^\/api\/conversation-models\/(assistant|coordination)\/([^/]+)$/,({m,body})=>saveConversationModel(m[1],m[2],body),configLimit),
  // 助手会话：npm 提案与审批
  post(/^\/api\/assistant\/sessions\/([^/]+)\/npm-proposal$/,({m,body})=>assistantNpmProposal(m[1],body)),
  post(/^\/api\/assistant\/sessions\/([^/]+)\/npm-approval$/,({m,body})=>assistantApproveNpm(m[1],body)),
  // 助手会话：创建/发消息/启动任务/交付审查/回复/停止/恢复
  post(/^\/api\/assistant\/sessions$/,({body})=>createAssistantSession(body)),
  post(/^\/api\/assistant\/sessions\/([^/]+)\/messages$/,({m,body})=>assistantMessage(m[1],body),messageLimit),
  post(/^\/api\/assistant\/sessions\/([^/]+)\/tasks$/,({m,body})=>assistantStartTask(m[1],body),messageLimit),
  post(/^\/api\/assistant\/sessions\/([^/]+)\/delivery-review$/,({m,body})=>assistantReviewDelivery(m[1],body),messageLimit),
  post(/^\/api\/assistant\/sessions\/([^/]+)\/reply$/,async({m,body})=>assistantReply(m[1],body),messageLimit),
  post(/^\/api\/assistant\/sessions\/([^/]+)\/stop$/,({m})=>assistantStop(m[1])),
  post(/^\/api\/assistant\/sessions\/([^/]+)\/resume$/,({m,body})=>assistantResume(m[1],body)),
  // 助手会话：优化/压缩/记忆编辑/记忆设置
  post(/^\/api\/assistant\/sessions\/([^/]+)\/optimization$/,({m,body})=>assistantOptimization(m[1],body),configLimit),
  post(/^\/api\/assistant\/sessions\/([^/]+)\/compact$/,async({m,body})=>assistantCompact(m[1],body),messageLimit),
  post(/^\/api\/assistant\/sessions\/([^/]+)\/memory$/,({m,body})=>assistantEditMemory(m[1],body)),
  post(/^\/api\/projects\/([^/]+)\/memory-settings$/,({m,body})=>saveProjectMemorySettings(m[1],body),configLimit),
  // 协调会话：创建/讨论/切换交互模式/编辑计划
  post(/^\/api\/coordination\/sessions$/,({body})=>createCoordinationSession(body)),
  post(/^\/api\/coordination\/sessions\/([^/]+)\/messages$/,async({m,body})=>discussCoordinationSession(m[1],body),messageLimit),
  post(/^\/api\/coordination\/sessions\/([^/]+)\/mode$/,({m,body})=>setCoordinationInteractionMode(m[1],body)),
  post(/^\/api\/coordination\/sessions\/([^/]+)\/plan$/,({m,body})=>editCoordinationPlan(m[1],body),configLimit),
  // 协调会话：规划会议（运行与应用）
  post(/^\/api\/coordination\/sessions\/([^/]+)\/planning-meetings$/,async({m,body})=>runPlanningMeeting(m[1],body),configLimit),
  post(/^\/api\/coordination\/sessions\/([^/]+)\/planning-meetings\/apply$/,({m,body})=>applyPlanningMeeting(m[1],body)),
  // 协调会话：回答/确认/分派/修订/指令
  post(/^\/api\/coordination\/sessions\/([^/]+)\/answers$/,({m,body})=>answerCoordinationSession(m[1],body),messageLimit),
  post(/^\/api\/coordination\/sessions\/([^/]+)\/confirm$/,async({m,body})=>confirmCoordinationSession(m[1],body),messageLimit),
  post(/^\/api\/coordination\/sessions\/([^/]+)\/dispatch$/,({m,body})=>dispatchCoordinationSession(m[1],body)),
  post(/^\/api\/coordination\/sessions\/([^/]+)\/revise$/,({m,body})=>reviseCoordinationSession(m[1],body),messageLimit),
  post(/^\/api\/coordination\/sessions\/([^/]+)\/instructions$/,({m,body})=>instructCoordinationEmployee(m[1],body),messageLimit),
  // 协调会话：自治恢复与停止
  post(/^\/api\/coordination\/sessions\/([^/]+)\/autonomy\/resume$/,({m,body})=>resumeAutonomySession(m[1],body)),
  post(/^\/api\/coordination\/sessions\/([^/]+)\/stop$/,({m,body})=>stopCoordinationSession(m[1],body)),
  // 聊天历史修改（assistant 或 coordination 类型）
  post(/^\/api\/chat-history\/(assistant|coordination)\/([^/]+)$/,({m,body})=>changeChatHistory(m[1],m[2],body)),

  // ===== 运行时、供应商与配置（配置类限额 64KB）=====
  // 运行时扫描与适配器注册
  post(/^\/api\/runtimes\/scan$/,()=>scanRuntimes()),
  post(/^\/api\/adapters$/,({body})=>registerRuntimeAdapter(body)),
  // 员工运行时信息检测
  post(/^\/api\/employees\/([^/]+)\/runtime-info$/,async({m})=>inspectEmployeeRuntime(m[1])),
  // MCP 服务器保存与工具发现
  post(/^\/api\/projects\/([^/]+)\/mcp$/,async({m,body})=>saveMcpServer(m[1],body),configLimit),
  post(/^\/api\/projects\/([^/]+)\/mcp\/discover$/,async({m})=>discoverMcpTools(m[1])),
  // 权限变更与管理者设置
  post(/^\/api\/permissions$/,({body})=>changePermission(body.projectId,body),configLimit),
  post(/^\/api\/manager\/settings$/,({body})=>saveManagerSettings(body),configLimit),
  // Agent 供应商管理：保存/绑定/接管/删除
  post(/^\/api\/agent-providers$/,({body})=>saveAgentProvider(body),configLimit),
  post(/^\/api\/agent-providers\/bind$/,({body})=>bindAgentProvider(body),configLimit),
  post(/^\/api\/agent-providers\/adopt$/,({body})=>adoptAgentProvider(body),configLimit),
  post(/^\/api\/agent-providers\/remove$/,({body})=>removeAgentProvider(body),configLimit),
  // 管理者连接测试与本地模型扫描
  post(/^\/api\/manager\/test$/,async({body})=>testManagerConnection(body),configLimit),
  post(/^\/api\/manager\/models$/,async({body})=>readLocalModels(body),configLimit),
  // 项目级配置保存：工作流/自治/档案/执行设置
  post(/^\/api\/projects\/([^/]+)\/workflow$/,({m,body})=>saveWorkflow(m[1],body),configLimit),
  post(/^\/api\/projects\/([^/]+)\/autonomy$/,({m,body})=>saveAutonomySettings(m[1],body),configLimit),
  post(/^\/api\/projects\/([^/]+)\/profile$/,({m,body})=>saveProjectProfile(m[1],body),configLimit),
  post(/^\/api\/projects\/([^/]+)\/execution$/,({m,body})=>saveExecutionSettings(m[1],body),configLimit),
  // 运行时暂停/恢复
  post(/^\/api\/projects\/([^/]+)\/execution\/runtime$/,({m,body})=>changeRuntimePause(m[1],body)),
  // 排程账户与能力管理
  post(/^\/api\/scheduling\/accounts$/,({body})=>schedulingAccount(body),configLimit),
  post(/^\/api\/scheduling\/accounts\/resume$/,({body})=>resumeSchedulingAccount(body)),
  post(/^\/api\/employees\/([^/]+)\/capabilities$/,({m,body})=>saveEmployeeCapability(m[1],body),configLimit),
  post(/^\/api\/projects\/([^/]+)\/scheduling$/,({m,body})=>saveSchedulingPolicy(m[1],body),configLimit),
  post(/^\/api\/projects\/([^/]+)\/scheduling\/settle$/,({m,body})=>settleSchedulingCost(m[1],body)),
  // 工作流包保存
  post(/^\/api\/packs$/,({body})=>saveWorkflowPack(body),configLimit),

  // ===== 基础数据增删改 =====
  // 项目 CRUD
  post(/^\/api\/projects$/,({body})=>({id:createProject(body)})),
  post(/^\/api\/projects\/([^/]+)$/,({m,body})=>{updateProject(m[1],body);return {updated:true};}),
  // 员工 CRUD
  post(/^\/api\/employees$/,({body})=>({id:registerEmployee(body)})),
  post(/^\/api\/employees\/([^/]+)\/delete$/,({m})=>{deleteEmployee(m[1]);return {deleted:true};}),
  post(/^\/api\/employees\/([^/]+)$/,({m,body})=>{updateEmployee(m[1],body);return {updated:true};}),
  // 对话 CRUD
  post(/^\/api\/conversations$/,({body})=>({id:createConversation(body)})),
  post(/^\/api\/conversations\/([^/]+)$/,({m,body})=>{renameConversation(m[1],body);return {updated:true};}),
  // 记忆 CRUD
  post(/^\/api\/memories$/,({body})=>({id:createMemory(body)})),
  post(/^\/api\/memories\/([^/]+)\/delete$/,({m,body})=>{deleteMemory(m[1],body);return {deleted:true};}),
  post(/^\/api\/memories\/([^/]+)$/,({m,body})=>updateMemory(m[1],body)),
  // 部门管理
  post(/^\/api\/departments$/,({body})=>({id:createDepartment(body)})),
  post(/^\/api\/departments\/([^/]+)$/,({m,body})=>{updateDepartment(m[1],body);return {updated:true};}),
  // 仓库添加与集成（两阶段提交：prepare → apply）
  post(/^\/api\/repositories$/,async({body})=>({id:await addRepository(body)})),
  post(/^\/api\/integrations$/,({body})=>prepareIntegration(body)),
  post(/^\/api\/integrations\/([^/]+)\/apply$/,({m})=>applyIntegration(m[1])),

  // ===== 信箱、消息与锁 =====
  // Mailbox 注册与消息生命周期（发送 → ack → complete/reject/nack）
  post(/^\/api\/mailboxes$/,({body})=>registerMailbox(body)),
  post(/^\/api\/messages$/,({body})=>sendMessage(body),messageLimit),
  post(/^\/api\/messages\/([^/]+)\/ack$/,({m,body})=>ackMessage(m[1],body)),
  post(/^\/api\/messages\/([^/]+)\/nack$/,({m,body})=>nackMessage(m[1],body)),
  post(/^\/api\/messages\/([^/]+)\/complete$/,({m,body})=>completeMessage(m[1],body)),
  post(/^\/api\/messages\/([^/]+)\/reject$/,({m,body})=>rejectMessage(m[1],body)),
  // 消息附件（制品关联）
  post(/^\/api\/messages\/([^/]+)\/attachments$/,({m,body})=>attachMessageArtifact(m[1],body),configLimit),
  // 租约锁管理：获取/续租/释放/列表
  post(/^\/api\/locks\/acquire$/,({body})=>acquireLock(body)),
  post(/^\/api\/locks$/,({body})=>listLocks(body.projectId,body.includeReleased===true)),
  post(/^\/api\/locks\/([^/]+)\/renew$/,({m,body})=>renewLock(m[1],body)),
  post(/^\/api\/locks\/([^/]+)\/release$/,({m,body})=>releaseLock(m[1],body)),

  // ===== 执行控制 =====
  // 审批决议（批准/拒绝）
  post(/^\/api\/approvals\/([^/]+)$/,async ({m,body})=>({runId:(await resolveApproval(m[1],body.approved===true))})),
  // 停止运行中的推理
  post(/^\/api\/runs\/([^/]+)\/stop$/,({m})=>{stopRun(m[1]);return {requested:true};}),
  // 任务验收（接受/拒绝）与交付冻结
  post(/^\/api\/tasks\/([^/]+)\/review$/,async ({m,body})=>{(await acceptTask(m[1],body.accepted===true,body.fingerprint));return {reviewed:true};}),
  post(/^\/api\/tasks\/([^/]+)\/delivery$/,({m,body})=>freezeHistoricalDelivery(m[1],body),configLimit),
  // 任务恢复（从失败状态重试）
  post(/^\/api\/tasks\/([^/]+)\/recovery$/,async({m,body})=>recoverTask(m[1],body)),

  // ===== 旧接口（legacy:true）=====
  // 未设 APIX_LEGACY_API=1 时，server.mjs 对这些路由返回 409 Conflict，引导用户迁移到协调会话 API
  // 任务管理旧接口
  post(/^\/api\/tasks$/,({body})=>createTask(body),defaultLimit,{legacy:true}),
  post(/^\/api\/tasks\/([^/]+)\/resume$/,({m,body})=>resumeTask(m[1],body),defaultLimit,{legacy:true}),
  post(/^\/api\/tasks\/([^/]+)\/revise$/,({m,body})=>revisePendingPlanTask(m[1],body),defaultLimit,{legacy:true}),
  // 总监（Director）旧接口：计划/消息/提案/审批
  post(/^\/api\/director\/plans$/,({body})=>({id:createDirectorPlan(body)}),defaultLimit,{legacy:true}),
  post(/^\/api\/director\/messages$/,async({body})=>sendDirectorMessage(body),messageLimit,{legacy:true}),
  post(/^\/api\/director\/proposals\/([^/]+)\/approve$/,({m,body})=>approveDirectorProposal(m[1],body),configLimit,{legacy:true}),
  post(/^\/api\/director\/proposals\/([^/]+)$/,({m,body})=>saveDirectorProposal(m[1],body),configLimit,{legacy:true}),
  post(/^\/api\/director\/plans\/([^/]+)\/approve$/,({m,body})=>approveDirectorPlan(m[1],body),defaultLimit,{legacy:true}),
  post(/^\/api\/director\/plans\/([^/]+)\/cancel-pending$/,({m})=>cancelPendingDirectorPlan(m[1]),defaultLimit,{legacy:true}),
  // 协作计划与评审会议旧接口
  post(/^\/api\/collaboration\/plans$/,({body})=>createCollaborativePlan(body),configLimit,{legacy:true}),
  post(/^\/api\/meetings$/,({body})=>({id:createReviewMeeting(body)}),configLimit,{legacy:true}),
  post(/^\/api\/manager-reviews$/,({body})=>createManagerReview(body),configLimit,{legacy:true}),
];
