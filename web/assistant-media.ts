import {html} from './html.js';

const previewImages = new Set(['image/png','image/jpeg','image/gif','image/webp']);
const playableAudio = new Set(['audio/ogg','audio/mpeg','audio/mp4','audio/wav','audio/webm']);

export function attachmentCards(sessionId: string, input: unknown) {
  if (!sessionId || !Array.isArray(input)) return '';
  return input.map(file => {
    if (!file || typeof file.id !== 'string' || typeof file.name !== 'string') return '';
    const url = '/api/assistant/sessions/' + encodeURIComponent(sessionId) + '/media/' + encodeURIComponent(file.id);
    const preview = file.kind === 'image' && previewImages.has(file.mime)
      ? html`<img loading="lazy" src="${url}" alt="${file.name}">`
      : file.kind === 'voice' && playableAudio.has(file.mime)
        ? html`<audio controls preload="none" src="${url}" aria-label="${file.name}"></audio>`
        : '';
    return '<figure class="assistant-attachment">' + preview + html`<figcaption><a href="${url}" download="${file.name}">${file.name}</a></figcaption></figure>`;
  }).join('');
}

export async function readAttachments(files: File[]) {
  if (files.length > 4 || files.some(file => !file.size || file.name.length > 160) ||
      files.reduce((size,file) => size + file.size, 0) > 4 * 1024 * 1024) {
    throw new Error('附件最多 4 个，合计不超过 4 MiB，文件名不超过 160 字符');
  }
  return Promise.all(files.map(file => new Promise<{name: string; mime: string; data: string}>((resolve, reject) => {
    const reader = new FileReader();
    reader.addEventListener('error', () => reject(new Error('附件读取失败')));
    reader.addEventListener('load', () => resolve({
      name: file.name, mime: file.type, data: String(reader.result).split(',')[1] ?? '',
    }));
    reader.readAsDataURL(file);
  })));
}
