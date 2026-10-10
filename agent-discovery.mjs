import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

const catalog = [
  { id: "trae", name: "Trae" },
  { id: "qoder", name: "Qoder" },
  { id: "workbuddy", name: "WorkBuddy" },
];
let cached = catalog.map((item) => ({ ...item, available: false, managed: false, observable: false, cancellable: false, resumable: false, stateSource: "扫描中", detectedNames: [] }));
let inFlight = null;

export function externalAgents() { return cached; }

export function scanExternalAgents() {
  if (inFlight) return inFlight;
  inFlight = (async () => {
  let installed = [];
  if (process.platform === "win32") {
    try {
      const { stdout } = await execFileAsync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", "Get-StartApps | Where-Object { $_.Name -match 'Trae|Qoder|WorkBuddy' } | Select-Object Name,AppID | ConvertTo-Json -Compress"], { encoding: "utf8", timeout: 8000, windowsHide: true });
      const output = stdout.trim();
      installed = output ? [JSON.parse(output)].flat() : [];
    } catch { installed = []; }
  } else {
    for (const item of catalog) {
      try { await execFileAsync("which", [item.id], { timeout: 2000 }); installed.push({ Name: item.name, AppID: item.id }); } catch { /* Optional desktop app is absent. */ }
    }
  }
  cached = catalog.map((item) => {
    const matches = installed.filter((app) => String(app.Name ?? "").toLowerCase().includes(item.id));
    return { ...item, available: matches.length > 0, managed: false, observable: false, cancellable: false, resumable: false, stateSource: matches.length ? "本机应用列表" : "未发现", detectedNames: matches.map((app) => app.Name) };
  });
  return cached;
  })().finally(() => { inFlight = null; });
  return inFlight;
}

void scanExternalAgents();
