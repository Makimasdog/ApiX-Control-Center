import {existsSync} from 'node:fs';
import {setTimeout} from 'node:timers/promises';
export async function waitForFile(path,timeoutMs=12000){
 const deadline=Date.now()+timeoutMs;
 while(!existsSync(path)){if(Date.now()>=deadline)throw new Error('ready signal missing: '+path);await setTimeout(25);}
}
