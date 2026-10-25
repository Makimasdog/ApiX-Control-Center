import {escapeAssistant} from './assistant-view.js';

// Text and quoted attribute values only; never use for tag names, scripts, styles or URLs.
// Compose markup by joining complete html templates, not by interpolating markup strings.
export function html(strings:TemplateStringsArray,...values:unknown[]):string{
  return strings.reduce((out,part,index)=>out+part+(index<values.length?escapeAssistant(values[index]):''),'');
}
