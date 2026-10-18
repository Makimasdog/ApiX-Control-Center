import {existsSync} from 'node:fs';
import {resolve} from 'node:path';
export function commandCapabilities(platform:string=process.platform){
 const available=platform==='win32'&&!!process.env.SystemRoot&&existsSync(resolve(process.env.SystemRoot,'System32/WindowsPowerShell/v1.0/powershell.exe'));
 return {platform,managedCommands:{available,reason:available?null:platform==='win32'?'系统 Windows PowerShell 不可用':'本平台尚无可确认的命令托管；文件工具仍可使用'}};
}
