import {providerCenter} from './provider-center.js';
export function applicationModelSettings(container:HTMLElement,project:()=>string){
  providerCenter(container,{project});
}
