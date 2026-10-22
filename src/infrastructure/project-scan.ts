import {createHash} from 'node:crypto';
import {openSync,readSync,closeSync,fstatSync,lstatSync,type Stats} from 'node:fs';

export const projectScanLimits={items:20000,bytes:256*1024*1024};
// Hash every byte, keeping only a bounded text preview in memory.
export function scanProjectFile(path:string,expected:Stats,captureLimit=0){
  const same=(s:Stats)=>s.isFile()&&s.ino===expected.ino&&s.size===expected.size&&s.mtimeMs===expected.mtimeMs&&s.ctimeMs===expected.ctimeMs;
  const fd=openSync(path,'r'),hash=createHash('sha256'),chunks:Buffer[]=[];let bytes=0;
  try {
    if(!same(fstatSync(fd)))throw new Error('扫描期间文件已变化，请重试');
    const buffer=Buffer.alloc(65536);let n;
    while((n=readSync(fd,buffer,0,buffer.length,null))>0){if((bytes+=n)>expected.size)throw new Error('扫描期间文件变大，请重试');hash.update(buffer.subarray(0,n));if(expected.size<=captureLimit)chunks.push(Buffer.from(buffer.subarray(0,n)));}
    if(bytes!==expected.size||!same(fstatSync(fd))||!same(lstatSync(path)))throw new Error('扫描期间文件已变化，请重试');
    return {sha256:hash.digest('hex'),bytes,data:expected.size<=captureLimit?Buffer.concat(chunks):undefined};
  } finally {closeSync(fd);}
}
