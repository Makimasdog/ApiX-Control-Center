import {startNpmFixture} from '../../test/npm-service-fixture.mjs';
import {writeFileSync,existsSync,readFileSync} from 'node:fs';import {join} from 'node:path';
const h=await startNpmFixture(),result=join(h.dir,'browser-result.json');
writeFileSync('.tmp-p0-p2/npm-browser.json',JSON.stringify({origin:h.origin,projectId:h.projectId,directory:h.dir,result},null,2));
console.log(JSON.stringify({origin:h.origin,projectId:h.projectId,directory:h.dir,result}));
const timer=setTimeout(async()=>{console.error('npm browser watchdog failed');await h.close(true);process.exit(1);},15*60*1000);
const poll=setInterval(async()=>{if(!existsSync(result))return;clearInterval(poll);clearTimeout(timer);const data=JSON.parse(readFileSync(result));await h.close(true);process.exit(data.passed===true?0:1);},500);
