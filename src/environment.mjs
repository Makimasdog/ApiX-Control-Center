import {existsSync} from 'node:fs';
import {fileURLToPath} from 'node:url';

export function loadEnvironment(path=fileURLToPath(new URL('../.env',import.meta.url))) {
  if(existsSync(path))process.loadEnvFile(path);
  // The settings validator uses uppercase names; the existing .env uses ali_api_key.
  if(!process.env.APIX_ALI_API_KEY && process.env.ali_api_key)process.env.APIX_ALI_API_KEY=process.env.ali_api_key;
}
