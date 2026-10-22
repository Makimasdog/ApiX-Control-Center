import {existsSync,readFileSync,writeFileSync,renameSync,unlinkSync} from 'node:fs';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';

// Keep raw credentials outside settings/snapshots and out of worker environments.
// The local data directory has the same trust boundary as the existing .env file.
export function modelCredentials(dataDir, environment=process.env) {
  const path=join(dataDir,'model-credentials.json');
  const validName=name=>/^APIX_MANAGER_KEY_[A-F0-9]{32}$/.test(name);
  let values;
  try {values=existsSync(path)?JSON.parse(readFileSync(path,'utf8')):{};}
  catch {throw new Error('本地模型密钥文件无法读取，请检查应用数据目录');}
  if(!values || typeof values!=='object' || Array.isArray(values) || Object.entries(values).some(([name,key])=>!validName(name)||typeof key!=='string'||!key||/[\s\x00-\x1f\x7f]/.test(key)))throw new Error('本地模型密钥文件无效，请检查应用数据目录');
  for(const [name,key] of Object.entries(values))environment[name]=key;
  return {
    save(key) {
      if(typeof key!=='string'||!key.trim()||key.trim().length>8192||/[\s\x00-\x1f\x7f]/.test(key.trim()))throw new Error('API Key 格式无效，请填写完整密钥且不要包含空格或换行');
      const name='APIX_MANAGER_KEY_'+randomUUID().replaceAll('-','').toUpperCase();
      const next={...values,[name]:key.trim()},temporary=path+'.'+randomUUID()+'.tmp';
      try {writeFileSync(temporary,JSON.stringify(next),{mode:0o600,flag:'wx'});renameSync(temporary,path);}
      catch {try{unlinkSync(temporary);}catch{}throw new Error('模型密钥保存失败，请检查应用数据目录的写入权限');}
      values[name]=key.trim();environment[name]=key.trim();
      return name;
    }
  };
}
