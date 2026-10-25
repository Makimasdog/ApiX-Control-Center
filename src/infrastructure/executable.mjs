import {accessSync,constants,statSync} from 'node:fs';
import {delimiter,isAbsolute,join} from 'node:path';

export function executableOnPath(name,env=process.env){
  const directories=(env.PATH??env.Path??'').split(delimiter).map(p=>p.replace(/^"|"$/g,'')).filter(isAbsolute);
  const suffixes=process.platform==='win32'?['.exe','.cmd']:[''];
  for(const suffix of suffixes)for(const directory of directories){
    const path=join(directory,name+suffix);
    try{if(statSync(path).isFile()){accessSync(path,process.platform==='win32'?constants.F_OK:constants.X_OK);return path;}}catch{}
  }
  return null;
}
