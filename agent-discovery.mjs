// 发现本机已安装的桌面 Agent 应用。它们只会作为“ApiX 可见但无法驱动”的运行时上报给 UI，
// 因此本模块从不设置任何能力标志位。
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

// 仅登记已知应用；下方 Windows 分支的正则字面量重复了这份清单，新增应用时两处必须同步修改。
const catalog = [
  { id: "trae", name: "Trae" },
  { id: "qoder", name: "Qoder" },
  { id: "workbuddy", name: "WorkBuddy" },
];
// 扫描结果只驻留内存：控制面重启后一律从“扫描中”重新起步，各字段均由本机实时重建，
// 不从数据库回灌。
let cached = catalog.map((item) => ({ ...item, available: false, managed: false, observable: false, cancellable: false, resumable: false, stateSource: "扫描中", detectedNames: [] }));
// 单飞标记：并发扫描请求复用同一次本机查询，而不是堆叠子进程；在 `finally` 中释放，
// 扫描异常时同样释放。
let inFlight = null;

// 供 runtimes() 使用的同步读模型：返回上一次扫描结果，或“扫描中”占位值。
export function externalAgents() { return cached; }

// 执行一次全新扫描并刷新缓存，完成后以刷新后的数组作为结果。
export function scanExternalAgents() {
  if (inFlight) return inFlight;
  inFlight = (async () => {
  let installed = [];
  // 两条发现路径：Windows 读开始菜单项（这类应用不提供控制台启动器），其余平台查 PATH。
  // 两者都是尽力而为，应用缺失不算错误。
  if (process.platform === "win32") {
    try {
      // Get-StartApps 无需提权，读取当前用户可见的应用项。8 秒上界避免挂起的 PowerShell 钉住
      // 整次扫描；windowsHide 用于防止控制台窗口闪现。
      const { stdout } = await execFileAsync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", "Get-StartApps | Where-Object { $_.Name -match 'Trae|Qoder|WorkBuddy' } | Select-Object Name,AppID | ConvertTo-Json -Compress"], { encoding: "utf8", timeout: 8000, windowsHide: true });
      const output = stdout.trim();
      // ConvertTo-Json 在只命中一项时输出裸对象而非数组，故用“包一层 + flat()”统一两种形态。
      installed = output ? [JSON.parse(output)].flat() : [];
    } catch { installed = []; }
  } else {
    for (const item of catalog) {
      // execFile 会以 reject 表达非零退出码，因此“不在 PATH 上”也走 catch。这里伪造出的结构
      // 与 Windows 条目同形，使后续匹配逻辑无需区分平台。
      try { await execFileAsync("which", [item.id], { timeout: 2000 }); installed.push({ Name: item.name, AppID: item.id }); } catch { /* 可选的桌面应用未安装，忽略即可。 */ }
    }
  }
  cached = catalog.map((item) => {
    // 只按显示名做小写子串匹配（AppID 未被使用），因此 `Trae CN`、`Qoder CN IDE` 这类厂商变体
    // 仍会归入其所属的 catalog 条目。
    const matches = installed.filter((app) => String(app.Name ?? "").toLowerCase().includes(item.id));
    // 发现仅证明“已安装”，不证明任何控制权：能力标志位恒为 false，stateSource 标明来源是操作系统
    // 应用列表，从而避免 UI 把非托管应用读成 ApiX 运行时。
    return { ...item, available: matches.length > 0, managed: false, observable: false, cancellable: false, resumable: false, stateSource: matches.length ? "本机应用列表" : "未发现", detectedNames: matches.map((app) => app.Name) };
  });
  return cached;
  })().finally(() => { inFlight = null; });
  // 调用方拿到的是共享的在途 promise，其结果即刷新后的缓存数组。
  return inFlight;
}

// 导入时异步预热缓存；首个 runtimes() 读取可能仍返回“扫描中”，命令查询失败按未发现处理。
void scanExternalAgents();
