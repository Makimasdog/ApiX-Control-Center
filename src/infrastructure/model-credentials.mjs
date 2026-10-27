/**
 * 模型密钥安全存储 (Model Credentials) - 将 API Key 持久化到本地数据目录
 *
 * 所属层级：基础设施层
 * 核心功能：
 *   - 从 dataDir/model-credentials.json 读取已保存的模型 API Key
 *   - 原子写入：先写临时文件再 rename，防止写入中断导致密钥文件损坏
 *   - 严格的格式校验：密钥名必须符合 APIX_MANAGER_KEY_<32位十六进制> 格式
 *   - 密钥值校验：不允许空白、控制字符，长度上限 8192
 * 依赖关系：
 *   - 被 [→ 见 src/models/] 模型调用模块读取密钥使用
 *   - 密钥注入到 process.env，供下游 HTTP 请求携带
 *
 * 安全设计：
 *   - 密钥存储文件与 .env 处于同一信任边界（本机数据目录）
 *   - 文件权限设为 0o600（仅所有者可读写），防止其他用户读取
 *   - 原子写入使用 flag:'wx'（排他创建）+ rename，避免并发写入覆盖
 *   - 密钥与 settings/snapshot 分离，不出现在员工环境变量中
 */
import {existsSync,readFileSync,writeFileSync,renameSync,unlinkSync} from 'node:fs';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';

/**
 * modelCredentials - 加载并管理本地模型密钥存储
 * @param {string} dataDir - 应用数据目录（默认 ~/.apix-agent-os）
 * @param {Object} environment - 目标环境变量对象，默认 process.env；密钥会注入其中
 * @returns {{save: Function}} 返回包含 save 方法的控制器对象
 *
 * 初始化流程：
 *   1. 读取 dataDir/model-credentials.json（不存在则视为空对象）
 *   2. 校验文件格式：必须是对象、键名符合正则、值不能为空且无控制字符
 *   3. 将已保存的密钥注入到 environment 中，供后续模型调用使用
 */
export function modelCredentials(dataDir, environment=process.env) {
  const path=join(dataDir,'model-credentials.json');
  /** 校验密钥名格式：必须是 APIX_MANAGER_KEY_ 前缀 + 32 位大写十六进制 */
  const validName=name=>/^APIX_MANAGER_KEY_[A-F0-9]{32}$/.test(name);
  let values;
  try {values=existsSync(path)?JSON.parse(readFileSync(path,'utf8')):{};}
  catch {throw new Error('本地模型密钥文件无法读取，请检查应用数据目录');}
  // 全面校验文件内容：必须是普通对象、每个键名合法、每个值非空且无控制字符
  if(!values || typeof values!=='object' || Array.isArray(values) || Object.entries(values).some(([name,key])=>!validName(name)||typeof key!=='string'||!key||/[\s\x00-\x1f\x7f]/.test(key)))throw new Error('本地模型密钥文件无效，请检查应用数据目录');
  // 将已保存的密钥注入环境变量，供模型 HTTP 请求使用
  for(const [name,key] of Object.entries(values))environment[name]=key;
  return {
    /**
     * save - 保存一个新的模型 API Key 到密钥文件
     * @param {string} key - 要保存的 API Key 字符串
     * @returns {string} 生成的密钥名（如 APIX_MANAGER_KEY_A1B2C3D4...）
     * @throws {Error} 密钥格式无效或文件写入失败时抛出
     *
     * 原子写入流程：
     *   1. 生成唯一密钥名（UUID 转大写十六进制）
     *   2. 写入临时文件（flag:'wx' 排他创建，mode:0o600 仅所有者可读写）
     *   3. rename 临时文件为正式文件（原子操作，不会出现半写状态）
     *   4. 写入失败时清理临时文件，避免残留
     */
    save(key) {
      // 格式校验：非空、无首尾空白、长度不超 8192、无控制字符
      if(typeof key!=='string'||!key.trim()||key.trim().length>8192||/[\s\x00-\x1f\x7f]/.test(key.trim()))throw new Error('API Key 格式无效，请填写完整密钥且不要包含空格或换行');
      const name='APIX_MANAGER_KEY_'+randomUUID().replaceAll('-','').toUpperCase();
      const next={...values,[name]:key.trim()},temporary=path+'.'+randomUUID()+'.tmp';
      try {
        // 原子写入：先写临时文件（排他创建 + 限制权限），再 rename 覆盖正式文件
        writeFileSync(temporary,JSON.stringify(next),{mode:0o600,flag:'wx'});renameSync(temporary,path);
      }
      catch {try{unlinkSync(temporary);}catch{}throw new Error('模型密钥保存失败，请检查应用数据目录的写入权限');}
      // 同步更新内存中的缓存和环境变量
      values[name]=key.trim();environment[name]=key.trim();
      return name;
    }
  };
}
