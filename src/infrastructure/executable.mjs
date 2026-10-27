/**
 * PATH 可执行文件查找 (Executable Lookup) - 在系统 PATH 中定位可执行程序
 *
 * 所属层级：基础设施层
 * 核心功能：
 *   - 跨平台查找 PATH 环境变量中指定名称的可执行文件
 *   - Windows 平台自动尝试 .exe/.cmd 后缀
 *   - Unix 平台使用 X_OK 权限位验证可执行性
 * 依赖关系：
 *   - 被员工运行时检测模块调用，用于确认 CLI 工具（如 pi、codex、claude）是否可用
 */
import {accessSync,constants,statSync} from 'node:fs';
import {delimiter,isAbsolute,join} from 'node:path';

/**
 * executableOnPath - 在系统 PATH 中查找指定名称的可执行文件
 * @param {string} name - 要查找的可执行文件名（如 "node"、"pi"）
 * @param {Object} env - 环境变量对象，默认使用 process.env
 * @returns {string|null} 找到则返回完整绝对路径，未找到返回 null
 *
 * 查找策略：
 *   1. 从 PATH（Windows 上可能是 Path）中拆出所有目录，过滤掉非绝对路径
 *   2. Windows 依次尝试 .exe/.cmd 后缀，Unix 不加后缀
 *   3. 先 stat 确认是文件，再 access 验证权限（Unix 用 X_OK，Windows 只检查存在性 F_OK）
 */
export function executableOnPath(name,env=process.env){
  // 解析 PATH 变量，去除首尾引号，只保留绝对路径目录
  const directories=(env.PATH??env.Path??'').split(delimiter).map(p=>p.replace(/^"|"$/g,'')).filter(isAbsolute);
  // Windows 需要尝试常见可执行后缀，Unix 直接使用空后缀
  const suffixes=process.platform==='win32'?['.exe','.cmd']:[''];
  for(const suffix of suffixes)for(const directory of directories){
    const path=join(directory,name+suffix);
    try{if(statSync(path).isFile()){accessSync(path,process.platform==='win32'?constants.F_OK:constants.X_OK);return path;}}catch{}
  }
  return null;
}
