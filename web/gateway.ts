import {html} from './html.js';
import type {GatewayTrigger} from '../src/assistant-core/gateway-triggers.js';

interface Rule {
  id: string;
  revision: number;
  name: string;
  enabled: boolean;
  trigger: GatewayTrigger;
  nextAt: number | null;
  lastError: string | null;
}
interface Run {
  id: string;
  rule_name: string;
  status: 'delivered' | 'failed';
  message: string;
  created_at: number;
  read_at: number | null;
}
interface ProjectState {rules: Rule[]; runs: Run[]; unread: number}

async function request<T>(path: string, body?: unknown): Promise<T> {
  const response = await fetch(path, body === undefined ? undefined : {
    method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify(body),
  });
  const value = await response.json();
  if (!response.ok) throw new Error(value.error ?? '请求失败');
  return value as T;
}

export function mountGateway(root: HTMLElement, projectId: () => string) {
  const button = root.querySelector<HTMLButtonElement>('#overview-gateway')!;
  const dialog = document.createElement('dialog');
  dialog.className = 'assistant-dialog personal-gateway-dialog';
  dialog.setAttribute('aria-labelledby', 'gateway-title');
  dialog.innerHTML = html`
    <form method="dialog" class="gateway-heading"><h2 id="gateway-title">主动提醒</h2><button class="text-action">关闭</button></form>
    <section aria-label="提醒收件箱">
      <div class="gateway-heading"><h3>收件箱</h3><button class="text-action" type="button" data-gateway-refresh>刷新</button></div>
      <div data-gateway-runs></div>
    </section>
    <form class="stacked-form" data-gateway-form>
      <h3>提醒规则</h3>
      <label>规则<select name="rule"></select></label>
      <label>名称<input name="name" maxlength="120" required></label>
      <label>触发方式<select name="kind"><option value="cron">Cron 待办汇报</option><option value="heartbeat">Heartbeat 待办变化</option><option value="file">项目文件变化</option><option value="git.push">Git 推送</option><option value="mail.received">邮件到达</option></select></label>
      <label data-field="expression">Cron 表达式<input name="expression" value="0 8 * * *" maxlength="120"></label>
      <label data-field="timeZone">IANA 时区<input name="timeZone" maxlength="80"></label>
      <label data-field="intervalSeconds">检查间隔（秒）<input name="intervalSeconds" type="number" max="86400"></label>
      <label data-field="path">项目相对路径<input name="path" maxlength="1000"></label>
      <label data-field="source">事件来源<input name="source" maxlength="120"></label>
      <label><input name="enabled" type="checkbox" checked>启用规则</label>
      <p data-gateway-rule-status></p>
      <div><button class="outline-button" type="submit">保存规则</button><button class="text-action" type="button" data-gateway-delete hidden>删除规则</button></div>
    </form>
    <p role="status" data-gateway-feedback></p>`;
  root.append(dialog);
  const form = dialog.querySelector<HTMLFormElement>('[data-gateway-form]')!;
  const select = form.elements.namedItem('rule') as HTMLSelectElement;
  const kind = form.elements.namedItem('kind') as HTMLSelectElement;
  const input = (name: string) => form.elements.namedItem(name) as HTMLInputElement;
  const remove = dialog.querySelector<HTMLButtonElement>('[data-gateway-delete]')!;
  const feedback = dialog.querySelector<HTMLElement>('[data-gateway-feedback]')!;
  const ruleStatus = dialog.querySelector<HTMLElement>('[data-gateway-rule-status]')!;
  const runs = dialog.querySelector<HTMLElement>('[data-gateway-runs]')!;
  const localZone = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  const pathFor = (id: string) => '/api/projects/' + encodeURIComponent(id) + '/gateway';
  let rules: Rule[] = [];
  let busy = false;

  function renderFields() {
    const trigger = kind.value;
    const visible: Record<string, string[]> = {
      cron: ['expression', 'timeZone'], heartbeat: ['intervalSeconds'], file: ['intervalSeconds', 'path'],
      'git.push': ['source'], 'mail.received': ['source'],
    };
    for (const label of form.querySelectorAll<HTMLElement>('[data-field]')) {
      const name = label.dataset.field!;
      const field = input(name);
      label.hidden = !visible[trigger]?.includes(name);
      field.disabled = label.hidden;
      field.required = !label.hidden;
    }
    input('intervalSeconds').min = trigger === 'file' ? '2' : '60';
  }

  function selectRule() {
    const id = select.value;
    const rule = rules.find(item => item.id === id);
    form.reset();
    select.value = id;
    input('timeZone').value = localZone;
    input('intervalSeconds').value = '300';
    remove.hidden = !rule;
    ruleStatus.textContent = '';
    if (rule) {
      input('name').value = rule.name;
      kind.value = rule.trigger.kind;
      input('enabled').checked = rule.enabled;
      for (const [field, value] of Object.entries(rule.trigger)) {
        if (field !== 'kind') input(field).value = String(value);
      }
      ruleStatus.textContent = rule.lastError ?? (rule.nextAt === null ? '' : '下次运行 ' + new Date(rule.nextAt).toLocaleString());
    }
    renderFields();
  }

  function display(state: ProjectState, selection: string) {
    rules = state.rules;
    select.replaceChildren(new Option('新建规则', ''), ...rules.map(rule => new Option(rule.name, rule.id)));
    select.value = rules.some(rule => rule.id === selection) ? selection : '';
    selectRule();
    runs.innerHTML = state.runs.map(run => {
      const details = html`<div class="gateway-heading"><strong>${run.rule_name}</strong><small>${new Date(run.created_at).toLocaleString()}</small></div>
        <p>${run.status === 'failed' ? '运行失败 · ' : ''}${run.message}</p>`;
      const mark = run.read_at === null ? html`<button class="text-action" type="button" data-gateway-read="${run.id}">标为已读</button>` : '';
      return '<article class="gateway-run">' + details + mark + '</article>';
    }).join('') || html`<p>暂无提醒</p>`;
    badge(state.unread);
  }

  function badge(unread: number) {
    button.textContent = unread ? '主动提醒（' + unread + '）' : '主动提醒';
  }

  async function load(id: string, selection: string) {
    const state = await request<ProjectState>(pathFor(id));
    if (dialog.open && projectId() === id) display(state, selection);
  }

  async function perform(action: (id: string) => Promise<void>) {
    const id = projectId();
    if (!id || busy) return;
    busy = true;
    dialog.setAttribute('aria-busy', 'true');
    const controls = [...dialog.querySelectorAll<HTMLInputElement | HTMLSelectElement | HTMLButtonElement>('input,select,button')];
    const disabled = controls.map(control => control.disabled);
    controls.forEach(control => { control.disabled = true; });
    feedback.textContent = '正在处理…';
    try {
      await action(id);
      feedback.textContent = '';
    } catch (error) {
      feedback.textContent = error instanceof Error ? error.message : String(error);
    } finally {
      controls.forEach((control, index) => { control.disabled = disabled[index]!; });
      renderFields();
      busy = false;
      dialog.removeAttribute('aria-busy');
    }
  }

  button.addEventListener('click', () => {
    if (!projectId() || busy || dialog.open) return;
    display({rules: [], runs: [], unread: 0}, '');
    dialog.showModal();
    void perform(id => load(id, ''));
  });
  dialog.addEventListener('cancel', event => { if (busy) event.preventDefault(); });
  select.addEventListener('change', selectRule);
  kind.addEventListener('change', () => {
    input('intervalSeconds').value = kind.value === 'file' ? '10' : '300';
    renderFields();
  });
  form.addEventListener('submit', event => {
    event.preventDefault();
    const selected = rules.find(rule => rule.id === select.value);
    const trigger: Record<string, unknown> = {kind: kind.value};
    for (const label of form.querySelectorAll<HTMLElement>('[data-field]:not([hidden])')) {
      const name = label.dataset.field!;
      trigger[name] = name === 'intervalSeconds' ? input(name).valueAsNumber : input(name).value;
    }
    const body = {name: input('name').value, enabled: input('enabled').checked, revision: selected?.revision, trigger};
    void perform(async id => {
      const path = pathFor(id) + '/rules' + (selected ? '/' + selected.id : '');
      const saved = await request<Rule>(path, body);
      await load(id, saved.id);
    });
  });
  remove.addEventListener('click', () => {
    const rule = rules.find(item => item.id === select.value);
    if (busy || !rule || !window.confirm('删除这条提醒规则？')) return;
    void perform(async id => {
      await request(pathFor(id) + '/rules/' + rule.id + '/delete', {revision: rule.revision});
      await load(id, '');
    });
  });
  dialog.querySelector('[data-gateway-refresh]')!.addEventListener('click', () => void perform(id => load(id, select.value)));
  runs.addEventListener('click', event => {
    const id = (event.target as Element).closest<HTMLElement>('[data-gateway-read]')?.dataset.gatewayRead;
    if (id) void perform(async project => {
      await request(pathFor(project) + '/runs/' + id + '/read', {});
      await load(project, select.value);
    });
  });

  let badgeRequest = false;
  const updateBadge = async () => {
    const id = projectId();
    button.disabled = !id;
    if (!id) { badge(0); return; }
    if (badgeRequest || busy || dialog.open || !root.classList.contains('active-page') || document.hidden) return;
    badgeRequest = true;
    try {
      const state = await request<ProjectState>(pathFor(id));
      if (projectId() === id && !dialog.open) badge(state.unread);
    } catch {
      if (projectId() === id) badge(0);
    } finally {
      badgeRequest = false;
    }
  };
  let badgeProject = '';
  document.addEventListener('apix:snapshot', () => {
    const id = projectId();
    button.disabled = !id;
    if (id === badgeProject) return;
    badgeProject = id;
    badge(0);
    void updateBadge();
  });
  document.addEventListener('apix:page', () => void updateBadge());
  setInterval(() => void updateBadge(), 10000);
}
