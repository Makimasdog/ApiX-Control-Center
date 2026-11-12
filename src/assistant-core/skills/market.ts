import {ToolError} from '../../assistant/tool-governance.js';
import {readManifest,operations,type AgentSkill,type Operation} from './manifest.js';

export interface SkillMarket {
  search(query:string):AgentSkill[];
  get(id:string,version:string):AgentSkill;
}
const entries:[string,string,Operation,string][]=[
  ['file-read','读取项目文件','file.read','读取授权目录内的小型 UTF-8 文件'],
  ['file-write','写入项目文件','file.write','写入授权目录内的 UTF-8 文件'],
  ['web-search','网页搜索','web.search','使用 Brave Search 查询公开网页'],
  ['code-run','执行隔离 JavaScript','code.run','在无宿主 API 的沙箱运行短函数'],
  ['calendar-list','查看本地日程','calendar.list','查询项目日程及时间范围'],
  ['calendar-add','添加本地日程','calendar.add','在项目中保存带起止时间的日程'],
  ['calendar-remove','删除本地日程','calendar.remove','删除本项目内指定日程'],
];
const manifests=entries.map(([id,name,operation,description])=>readManifest({
  schema:1,id,name,operation,description,version:'1.0.0',permissions:[operations[operation].permission],
}));

export const builtinMarket:SkillMarket={
  search(query){
    const term=query.trim().slice(0,120).toLowerCase();
    return manifests.filter(item=>!term||[item.id,item.name,item.description].some(value=>value.toLowerCase().includes(term)));
  },
  get(id,version){
    const found=manifests.find(item=>item.id===id&&item.version===version);
    if(!found)throw new ToolError('NOT_FOUND','市场中没有该技能版本','correct_input',{},404);
    return found;
  },
};
