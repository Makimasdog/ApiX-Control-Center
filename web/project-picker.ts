import {html} from './html.js';
const picker=document.createElement('dialog');picker.className='editor-dialog';
picker.setAttribute('aria-label','选择项目文件夹');document.body.append(picker);
let revision=0;
async function browse(path=''){
  const current=++revision;
  picker.innerHTML='<p>正在读取文件夹…</p><button type="button" data-folder-close>取消</button>';
  try{
    const response=await fetch(`/api/project-folders?path=${encodeURIComponent(path)}`);const data=await response.json();
    if(!response.ok)throw new Error(data.error??'无法读取目录');if(current!==revision)return;
    picker.innerHTML=html`<h2>选择项目文件夹</h2><p>浏览 ApiX 所在电脑的目录</p><p>${data.path}</p><div class="form-actions"><button type="button" data-folder-path="${data.home}">用户目录</button>` + (data.roots.map((p:string)=>html`<button type="button" data-folder-path="${p}">${p}</button>`).join('')) + html`<button type="button" data-folder-path="${data.parent}">上一级</button></div><form data-folder-search><label>筛选子文件夹<input name="filter" aria-label="筛选子文件夹"></label></form><div data-folder-list style="max-height:40vh;overflow:auto">` + (data.directories.map((d:{name:string;path:string})=>html`<div><button class="text-action" type="button" data-folder-path="${d.path}">📁 ${d.name}</button></div>`).join('')||'<p>没有子文件夹</p>') + html`</div><div class="dialog-actions"><button type="button" data-folder-close>取消</button><button type="button" class="primary-button" data-folder-select="${data.path}">选择此文件夹</button></div>`;
  }catch(error){if(current===revision)picker.innerHTML=html`<p role="alert">${error instanceof Error?error.message:error}</p><button type="button" data-folder-path="">返回用户目录</button><button type="button" data-folder-close>取消</button>`;}
}
picker.addEventListener('input',event=>{const input=event.target as HTMLInputElement;if(input.name==='filter')for(const item of picker.querySelectorAll<HTMLElement>('[data-folder-list]>div'))item.hidden=!item.textContent?.toLowerCase().includes(input.value.toLowerCase());});
picker.addEventListener('submit',event=>event.preventDefault());
picker.addEventListener('click',event=>{const b=(event.target as Element).closest<HTMLElement>('button');if(!b)return;
  if(b.hasAttribute('data-folder-path'))void browse(b.dataset.folderPath);
  if(b.hasAttribute('data-folder-close')){revision++;picker.close();}
  if(b.dataset.folderSelect){const input=document.querySelector<HTMLInputElement>('#editor-form [name=path]');if(input){input.value=b.dataset.folderSelect;input.dispatchEvent(new Event('input',{bubbles:true}));}revision++;picker.close();}
});
picker.addEventListener('cancel',()=>revision++);
document.addEventListener('click',event=>{if((event.target as Element).closest('[data-choose-project-folder]')){picker.showModal();const value=document.querySelector<HTMLInputElement>('#editor-form [name=path]')?.value;void browse(value||'');}});
document.addEventListener('input',event=>{const input=event.target as HTMLInputElement;if(input.matches('#editor-form [name=name]'))delete input.dataset.folderName;if(input.matches('#editor-form [name=path]')){const name=document.querySelector<HTMLInputElement>('#editor-form [name=name]');if(name&&(!name.value.trim()||name.dataset.folderName)){const folder=input.value.trim().replace(/[\\/]+$/,'').split(/[\\/]/).at(-1);if(folder){name.value=folder;name.dataset.folderName='1';}}}});
