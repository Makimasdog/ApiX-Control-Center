/**
 * 项目文件扫描 (Project Scan) - 对单个文件计算 SHA-256 哈希并可选捕获内容
 *
 * 所属层级：基础设施层
 * 核心功能：
 *   - 使用 SHA-256 对文件全内容计算哈希，用于项目文件完整性校验
 *   - 可选捕获文件内容（受 captureLimit 限制），用于文本预览
 *   - TOCTOU 防护：打开文件前后多次校验 inode/size/mtime，防止扫描期间文件被篡改
 * 依赖关系：
 *   - 被 [→ 见 src/projects/] 项目扫描模块调用，用于遍历项目目录中的文件
 *   - 纯底层工具函数，不依赖任何业务模块
 *
 * 安全设计：
 *   采用 TOCTOU（Time of Check to Time of Use）防护策略：
 *   打开文件前先 stat 获取元数据，打开后再 fstat 比对，读完后再 lstat 二次确认。
 *   任何阶段文件发生变化（修改、替换、大小改变）都立即抛错，拒绝产出不可信的哈希。
 */
import {createHash} from 'node:crypto';
import {openSync,readSync,closeSync,fstatSync,lstatSync,type Stats} from 'node:fs';

/**
 * 项目扫描的全局限制常量
 * - items: 单次扫描最多处理 20000 个文件，防止超大目录耗尽内存
 * - bytes: 所有文件累计字节数上限 256MB，防止磁盘级大项目拖垮进程
 */
export const projectScanLimits={items:20000,bytes:256*1024*1024};

/**
 * scanProjectFile - 对单个文件计算 SHA-256 哈希，可选捕获内容
 * @param {string} path - 文件的绝对路径
 * @param {Stats} expected - 调用方预先 stat 得到的文件元数据（ino/size/mtime/ctime）
 * @param {number} captureLimit - 内容捕获阈值；文件大小 <= 此值时返回原始内容 Buffer，否则 data 为 undefined
 * @returns {{sha256: string, bytes: number, data?: Buffer}} 哈希十六进制串、字节数、可选内容
 * @throws {Error} 扫描期间文件被修改/替换时抛出错误
 *
 * TOCTOU 防护流程：
 *   1. 打开文件前已有 expected（来自调用方 lstat）
 *   2. openSync 后立即 fstat 比对 inode/size/mtime/ctime —— 防止 open 期间文件被替换
 *   3. 读取循环中累计字节数，超过 expected.size 立即报错 —— 防止文件在读取时增长
 *   4. 读完后 fstat + lstat 双重校验 —— 防止读完后文件被修改或符号链接被替换
 */
export function scanProjectFile(path:string,expected:Stats,captureLimit=0){
  /** 比对当前 stat 结果与预期元数据是否一致（inode、大小、修改时间） */
  const same=(s:Stats)=>s.isFile()&&s.ino===expected.ino&&s.size===expected.size&&s.mtimeMs===expected.mtimeMs&&s.ctimeMs===expected.ctimeMs;
  const fd=openSync(path,'r'),hash=createHash('sha256'),chunks:Buffer[]=[];let bytes=0;
  try {
    // 第一次 TOCTOU 检查：打开后确认文件未被替换
    if(!same(fstatSync(fd)))throw new Error('扫描期间文件已变化，请重试');
    const buffer=Buffer.alloc(65536);let n;
    while((n=readSync(fd,buffer,0,buffer.length,null))>0){if((bytes+=n)>expected.size)throw new Error('扫描期间文件变大，请重试');hash.update(buffer.subarray(0,n));if(expected.size<=captureLimit)chunks.push(Buffer.from(buffer.subarray(0,n)));}
    // 第二次 TOCTOU 检查：读完后确认大小一致 + fstat/lstat 双重校验
    if(bytes!==expected.size||!same(fstatSync(fd))||!same(lstatSync(path)))throw new Error('扫描期间文件已变化，请重试');
    return {sha256:hash.digest('hex'),bytes,data:expected.size<=captureLimit?Buffer.concat(chunks):undefined};
  } finally {closeSync(fd);}
}
