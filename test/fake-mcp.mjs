import {Server} from '@modelcontextprotocol/sdk/server/index.js';
import {StdioServerTransport} from '@modelcontextprotocol/sdk/server/stdio.js';
import {ListToolsRequestSchema,CallToolRequestSchema} from '@modelcontextprotocol/sdk/types.js';
import {appendFileSync} from 'node:fs';
const record=name=>{if(process.env.MCP_TEST_LOG)appendFileSync(process.env.MCP_TEST_LOG,JSON.stringify({name})+'\n');};
const server=new Server({name:'apix-fixture',version:'1'},{capabilities:{tools:{}}});
server.setRequestHandler(ListToolsRequestSchema,()=>({tools:[
  {name:'echo',description:'回显中文与输入',inputSchema:{type:'object',properties:{text:{type:'string',minLength:1}},required:['text'],additionalProperties:false},annotations:{readOnlyHint:true}},
  {name:'failure',description:'返回明确失败',inputSchema:{type:'object'}},
  {name:'slow',description:'用于测试取消，记录副作用后等待',inputSchema:{type:'object'}},
]}));
server.setRequestHandler(CallToolRequestSchema,async request=>{
  record(request.params.name);
  if(request.params.name==='slow')await new Promise(resolve=>setTimeout(resolve,10000));
  if(request.params.name==='failure')return {isError:true,content:[{type:'text',text:'真实工具错误'}]};
  return {content:[{type:'text',text:String(request.params.arguments?.text??'')}],structuredContent:{cwd:process.cwd(),hasUnlistedSecret:!!process.env.MCP_UNLISTED_SECRET,hasAllowedSecret:process.env.MCP_ALLOWED_SECRET==='fixture-only'}};
});
await server.connect(new StdioServerTransport());
