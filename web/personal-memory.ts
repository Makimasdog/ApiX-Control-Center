import {html} from './html.js';
import type {PersonalMemory} from '../src/assistant-core/personal-memory.js';

const base = '/api/personal-memory';

export function mountPersonalMemory(
  root: HTMLElement,
  api: <T>(path: string, body?: unknown) => Promise<T>,
  sessionId: () => string | undefined,
) {
  const dialog = document.createElement('dialog');
  dialog.className = 'assistant-dialog personal-memory-dialog';
  dialog.setAttribute('aria-labelledby', 'personal-memory-title');
  dialog.innerHTML = html`
    <form method="dialog">
      <h2 id="personal-memory-title">个人记忆</h2>
      <p>记忆保存在本机，召回结果仅显示在这里。</p>
      <button type="submit" class="text-action">关闭</button>
    </form>
    <form class="stacked-form" data-memory-search>
      <label>召回关键词<input name="query" maxlength="10000" required></label>
      <div>
        <button class="outline-button" type="submit">召回</button>
        <button class="outline-button" type="button" data-memory-session>按本对话最近消息召回</button>
        <button class="text-action" type="button" data-memory-list>全部记忆</button>
      </div>
    </form>
    <label>条目<select data-memory-items></select></label>
    <form class="stacked-form" data-memory-edit>
      <label>存储层<select name="tier"><option value="work">工作记忆</option><option value="long-term">长期记忆</option></select></label>
      <label>标题<input name="title" maxlength="120" required></label>
      <label>内容<textarea name="content" rows="4" maxlength="3000" required></textarea></label>
      <label>到期时间<input type="datetime-local" name="expiresAt" step="1"></label>
      <label><input name="recall" type="checkbox" checked>参与召回</label>
      <div>
        <button class="outline-button" type="submit">保存记忆</button>
        <button class="text-action" type="button" data-memory-delete hidden>删除记忆</button>
      </div>
    </form>
    <p role="status" data-memory-status></p>`;
  root.append(dialog);

  const open = root.querySelector<HTMLButtonElement>('#assistant-personal-memory')!;
  const search = dialog.querySelector<HTMLFormElement>('[data-memory-search]')!;
  const edit = dialog.querySelector<HTMLFormElement>('[data-memory-edit]')!;
  const status = dialog.querySelector<HTMLElement>('[data-memory-status]')!;
  const list = dialog.querySelector<HTMLSelectElement>('[data-memory-items]')!;
  const recallSession = dialog.querySelector<HTMLButtonElement>('[data-memory-session]')!;
  const remove = dialog.querySelector<HTMLButtonElement>('[data-memory-delete]')!;
  const fields = edit.elements;
  const tier = fields.namedItem('tier') as HTMLSelectElement;
  const title = fields.namedItem('title') as HTMLInputElement;
  const content = fields.namedItem('content') as HTMLTextAreaElement;
  const expiresAt = fields.namedItem('expiresAt') as HTMLInputElement;
  const recall = fields.namedItem('recall') as HTMLInputElement;
  let items: PersonalMemory[] = [];
  let selected: PersonalMemory | undefined;
  let busy = false;

  function showSelection() {
    selected = items.find(item => item.id === list.value);
    edit.reset();
    tier.disabled = Boolean(selected);
    remove.hidden = !selected;
    if (!selected) return;
    tier.value = selected.tier;
    title.value = selected.title;
    content.value = selected.content;
    recall.checked = selected.recall;
    if (selected.expiresAt) {
      const time = new Date(selected.expiresAt);
      expiresAt.value = new Date(time.getTime() - time.getTimezoneOffset() * 60000).toISOString().slice(0, -1);
    }
  }

  function display(records: PersonalMemory[], id = '') {
    items = records;
    list.replaceChildren(new Option('新建记忆', ''), ...records.map(item => new Option(
      (item.tier === 'work' ? '工作 · ' : '长期 · ') + item.title, item.id,
    )));
    list.value = records.some(item => item.id === id) ? id : '';
    showSelection();
  }

  async function run(action: () => Promise<void>) {
    if (busy) return;
    busy = true;
    const controls = [...dialog.querySelectorAll<HTMLInputElement | HTMLButtonElement | HTMLSelectElement | HTMLTextAreaElement>(
      'input, button, select, textarea',
    )];
    const previous = controls.map(control => control.disabled);
    controls.forEach(control => { control.disabled = true; });
    status.textContent = '正在处理…';
    try {
      await action();
    } catch (error) {
      status.textContent = error instanceof Error ? error.message : String(error);
    } finally {
      controls.forEach((control, index) => { control.disabled = previous[index]!; });
      tier.disabled = Boolean(selected);
      busy = false;
    }
  }

  async function showAll(message?: string, id?: string) {
    display(await api<PersonalMemory[]>(base), id);
    status.textContent = message ?? (items.length ? '共 ' + items.length + ' 条记忆' : '暂无个人记忆');
  }

  async function showRecall(results: Promise<PersonalMemory[]>) {
    const found = await results;
    display(found, found[0]?.id);
    status.textContent = found.length ? '召回 ' + found.length + ' 条记忆' : '没有匹配的记忆';
  }

  open.addEventListener('click', () => {
    if (dialog.open) return;
    search.reset();
    display([]);
    recallSession.hidden = !sessionId();
    dialog.showModal();
    void run(() => showAll());
  });
  dialog.addEventListener('cancel', event => { if (busy) event.preventDefault(); });
  dialog.addEventListener('close', () => { display([]); status.textContent = ''; });
  list.addEventListener('change', showSelection);
  dialog.querySelector('[data-memory-list]')!.addEventListener('click', () => void run(() => showAll()));
  recallSession.addEventListener('click', () => {
    const id = sessionId();
    if (id) void run(() => showRecall(api(base + '/sessions/' + encodeURIComponent(id) + '/recall')));
  });
  search.addEventListener('submit', event => {
    event.preventDefault();
    const query = new FormData(search).get('query');
    void run(() => showRecall(api(base + '/recall', {query})));
  });
  edit.addEventListener('submit', event => {
    event.preventDefault();
    const path = base + '/' + tier.value + (selected ? '/' + selected.id : '');
    const input = {title: title.value, content: content.value, recall: recall.checked,
      expiresAt: expiresAt.value ? new Date(expiresAt.value).toISOString() : null, version: selected?.version};
    void run(async () => {
      const saved = await api<PersonalMemory>(path, input);
      await showAll('记忆已保存', saved.id);
    });
  });
  remove.addEventListener('click', () => {
    const item = selected;
    if (!item || !window.confirm('删除这条个人记忆？')) return;
    void run(async () => {
      await api(base + '/' + item.tier + '/' + item.id + '/delete', {version: item.version});
      await showAll('记忆已删除');
    });
  });
}
