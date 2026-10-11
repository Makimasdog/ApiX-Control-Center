export type StreamEvent = { type: string; data: unknown };

// TextDecoder retains incomplete UTF-8 bytes; the frame buffer retains incomplete lines.
export class ConversationParser {
  private decoder = new TextDecoder();
  private buffer = '';
  *push(bytes: Uint8Array, done = false): Iterable<StreamEvent> {
    this.buffer += this.decoder.decode(bytes, { stream: !done });
    let match: RegExpExecArray | null;
    while ((match = /\r?\n\r?\n/.exec(this.buffer))) {
      const frame = this.buffer.slice(0, match.index);
      this.buffer = this.buffer.slice(match.index + match[0].length);
      let type = 'message'; const data: string[] = [];
      for (const line of frame.split(/\r?\n/)) {
        const colon = line.indexOf(':');
        const field = colon < 0 ? line : line.slice(0, colon);
        const value = colon < 0 ? '' : line.slice(colon + 1).replace(/^ /, '');
        if (field === 'event') type = value;
        if (field === 'data') data.push(value);
      }
      if (data.length) yield { type, data: JSON.parse(data.join('\n')) };
    }
  }
}

export interface ConversationResult {
  id: string; revision: number; turns: { role: string; content: string }[];
}
export async function readConversation<T extends ConversationResult>(response: Response, sessionId: string, callbacks: {
  delta: (text: string) => void; complete: (session: T) => void;
}): Promise<void> {
  if (!response.ok || !response.body) {
    let error = `流式连接失败（HTTP ${response.status}）`;
    try { error = (await response.json()).error || error; } catch { /* 非 JSON 错误 */ }
    throw new Error(error);
  }
  const reader = response.body.getReader(); const parser = new ConversationParser();
  try {
    while (true) {
      const { done, value } = await reader.read();
      for (const event of parser.push(value ?? new Uint8Array(), done)) {
        const data = event.data as Record<string, unknown>;
        if (event.type === 'start' && data.sessionId !== sessionId) throw new Error('对话目标不匹配');
        if (event.type === 'error') throw new Error(String(data.error || '对话生成失败'));
        if (event.type === 'delta') {
          if (typeof data.text !== 'string') throw new Error('无效的对话增量');
          callbacks.delta(data.text);
        }
        if (event.type === 'complete') {
          const session = event.data as T;
          if (session.id !== sessionId || !Number.isInteger(session.revision) || !Array.isArray(session.turns) || session.turns.at(-1)?.role !== 'apix') throw new Error('无效的正式对话');
          callbacks.complete(session);
          return; // A terminal event wins; later frames cannot change this reply.
        }
      }
      if (done) throw new Error('对话连接中断；正在同步目标状态，请勿重复发送');
    }
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}
