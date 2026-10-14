// Capability acceptance outside the existing regression suite: a failure is a real gap.
import {parseArchitecture} from '../dist/src/architecture.js';
const checks=[{id:'tests',args:['verify.mjs'],timeoutMs:1000}];
const module={id:'core',name:'core',paths:['a.txt'],dependsOn:[],risk:'high',difficulty:2,workload:{inputTokens:10,outputTokens:10,calls:1},acceptance:['valid JSON Schema'],checkIds:['tests']};
const cases=[
  {id:'A05-interface-schema',interfaces:[{name:'read',consumer:'external',protocol:'HTTP',request:{type:'not-a-json-schema-type'},response:{type:'string'}}],dataStructures:[]},
  {id:'A05-data-schema',interfaces:[],dataStructures:[{name:'Item',schema:{type:123,required:'not-an-array'}}]}
].map(({id,...fields})=>{let rejected=false;try{parseArchitecture({summary:'invalid schema probe',modules:[{...module,...fields}]},checks);}catch{rejected=true;}return {id,expected:'reject malformed JSON Schema',actual:rejected?'rejected':'accepted',pass:rejected};});
console.log(JSON.stringify({kind:'architecture capability acceptance',pass:cases.every(c=>c.pass),cases},null,2));process.exitCode=cases.every(c=>c.pass)?0:1;
