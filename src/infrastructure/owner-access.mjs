/**
 * 本机所有者身份认证 (Owner Access) - 本地单用户应用的 Capability 认证
 *
 * 所属层级：基础设施层
 * 核心功能：
 *   - 读取或自动生成所有者访问令牌（存储于 dataDir/owner-access.json）
 *   - 支持两种认证方式：Bearer Token（HTTP 头）和 HttpOnly Cookie
 *   - 使用 timingSafeEqual 防止时序攻击（Timing Attack）
 *   - 提供登录页面 HTML（供浏览器输入令牌完成认证）
 * 依赖关系：
 *   - 被 [→ 见 server.mjs] 调用，用于保护管理 API 路由
 *   - 依赖 node:crypto 的 timingSafeEqual 进行安全比较
 *
 * 安全设计：
 *   这是本地单用户应用的 Capability 认证，不是操作系统级沙箱。
 *   - 令牌首次使用时自动生成 32 字节随机串，写入文件时限制权限 0o600
 *   - flag:'wx' 排他创建，防止并发写入覆盖
 *   - Bearer Token 优先于 Cookie：显式传入错误的 Bearer 不会降级到 Cookie 尝试
 *   - Cookie 设置 HttpOnly（防 XSS 窃取）+ SameSite=Strict（防 CSRF）
 */
import {randomBytes,timingSafeEqual} from 'node:crypto';
import {readFileSync,writeFileSync,mkdirSync} from 'node:fs';
import {join} from 'node:path';
import {homedir} from 'node:os';

/**
 * readOwnerToken - 读取或自动生成所有者访问令牌
 * @param {string} directory - 数据目录路径
 * @returns {string} 64 字符的十六进制令牌（32 字节随机数）
 *
 * 令牌获取优先级：
 *   1. 环境变量 APIX_OWNER_TOKEN（适合自动化部署场景）
 *   2. dataDir/owner-access.json 文件中的 token 字段
 *   3. 都不存在时自动生成，以 flag:'wx'（排他创建）+ mode:0o600 写入文件
 *
 * 格式校验：令牌必须是 32-128 位的字母数字字符串，防止注入攻击
 */
export function readOwnerToken(directory) {
  mkdirSync(directory,{recursive:true});
  const file=join(directory,'owner-access.json');
  let token=process.env.APIX_OWNER_TOKEN;
  if(!token){try{token=JSON.parse(readFileSync(file,'utf8')).token;}catch(error){if(error.code!=='ENOENT')throw error;token=randomBytes(32).toString('hex');writeFileSync(file,JSON.stringify({token}),{flag:'wx',mode:0o600});}}
  // 严格格式校验：只允许字母数字和 -_，长度 32-128
  if(typeof token!=='string'||!/^[a-zA-Z0-9_-]{32,128}$/.test(token))throw new Error('所有者访问令牌格式无效');
  return token;
}

/**
 * createOwnerAccess - 创建所有者认证控制器
 * @param {number} port - HTTP 服务端口号，用于生成唯一的 Cookie 名
 * @param {string} directory - 数据目录路径，默认 ~/.apix-agent-os
 * @returns {{authorized: Function, cookie: Function, equals: Function}}
 *   - authorized(request): 验证请求是否携带有效令牌
 *   - cookie(): 生成 Set-Cookie 响应头值
 *   - equals(value): 安全比较令牌值（timingSafeEqual）
 *
 * 认证策略：
 *   - 如果请求携带 Authorization 头 → 必须用 Bearer 方式，不再尝试 Cookie（防降级攻击）
 *   - 否则从 Cookie 头中提取 apix_owner_<port> 的值进行比较
 */
export function createOwnerAccess(port, directory=process.env.APIX_DATA_DIR??join(homedir(),'.apix-agent-os')) {
  const token=readOwnerToken(directory);
  const cookieName='apix_owner_'+port;
  /** 使用 timingSafeEqual 进行常数时间比较，防止时序攻击泄漏令牌信息 */
  const equals=value=>typeof value==='string'&&Buffer.byteLength(value)===Buffer.byteLength(token)&&timingSafeEqual(Buffer.from(value),Buffer.from(token));
  const authorized=request=>{
    // 安全策略：显式传入 Bearer 头就必须走 Bearer 验证，绝不降级到 Cookie
    if(request.headers.authorization)return request.headers.authorization.startsWith('Bearer ')&&equals(request.headers.authorization.slice(7));
    // 无 Authorization 头时，从 Cookie 中提取令牌并验证
    const pair=(request.headers.cookie??'').split(';').map(p=>p.trim()).find(p=>p.startsWith(cookieName+'='));
    return equals(pair?.slice(cookieName.length+1));
  };
  /** 生成 Set-Cookie 头：HttpOnly 防 XSS、SameSite=Strict 防 CSRF、Path=/ 全站有效 */
  const cookie=()=>`${cookieName}=${token}; HttpOnly; SameSite=Strict; Path=/`;
  return {authorized,cookie,equals};
}

/**
 * ownerLoginHtml - 本机令牌登录页面 HTML
 *
 * 当未认证的浏览器访问管理页面时，返回此 HTML 让用户输入令牌。
 * 令牌存储在 dataDir/owner-access.json 中，Electron 桌面端会自动连接。
 */
export const ownerLoginHtml=`<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>ApiX 本机访问</title><link rel="stylesheet" href="/design-system.css"><body><main class="panel" style="max-width:560px;margin:12vh auto;padding:32px"><h1>连接你的 ApiX</h1><p>请输入本机数据目录 owner-access.json 中的 token。Electron 会自动连接。</p><form id="owner-login"><label>本机访问令牌 <input type="password" name="token" required autocomplete="off"></label><button>连接</button><p id="owner-error" role="alert"></p></form></main><script src="/owner-login.js"></script></body></html>`;
