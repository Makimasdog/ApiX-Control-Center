/**
 * 平台能力检测 - 检查当前运行环境是否支持受管命令执行
 *
 * 所属层级：执行层（src/execution/）
 * 核心功能：
 *   - 检测当前操作系统是否为 Windows
 *   - 验证 Windows PowerShell 是否存在且可用
 *   - 返回结构化的能力报告，供上层决策是否启用受管命令
 * 依赖关系：
 *   - 被 [→ 见 src/execution/command-lifecycle.ts] 间接依赖（运行时判断能否执行）
 *   - 被前端/路由层调用，用于展示当前平台的命令执行能力状态
 */
import {existsSync} from 'node:fs';
import {resolve} from 'node:path';

/**
 * commandCapabilities - 检测当前平台是否具备受管命令执行能力
 * @param platform - 操作系统标识，默认取 process.platform；仅在 'win32' 时可能返回可用
 * @returns 包含平台名称和 managedCommands 能力报告的对象
 *   - available: 布尔值，表示 PowerShell 监督执行是否可用
 *   - reason: 不可用时的原因说明（null 表示可用）
 * 设计意图：受管命令依赖 Windows PowerShell + Job Object 机制实现进程组隔离，
 *   非 Windows 平台无法提供同等保证，因此需要显式检测并告知调用方。
 */
export function commandCapabilities(platform:string=process.platform){
 // 可用性判定：必须是 Windows + 有 SystemRoot 环境变量 + PowerShell 文件确实存在
 const available=platform==='win32'&&!!process.env.SystemRoot&&existsSync(resolve(process.env.SystemRoot,'System32/WindowsPowerShell/v1.0/powershell.exe'));
 return {platform,managedCommands:{available,reason:available?null:platform==='win32'?'系统 Windows PowerShell 不可用':'本平台尚无可确认的命令托管；文件工具仍可使用'}};
}
