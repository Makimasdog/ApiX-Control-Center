import {randomUUID} from 'node:crypto';
import {ToolError} from '../../assistant/tool-governance.js';
import type {Store} from '../../coordination/contracts.js';
import type {MediaPart} from './message-format.js';

export const inlineMedia = new Set(['image/png','image/jpeg','image/gif','image/webp','audio/ogg','audio/mpeg','audio/mp4','audio/wav','audio/webm']);

export function createMessageMedia({db, row, now}: Store) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS assistant_message_media (
      id TEXT PRIMARY KEY, session_id TEXT NOT NULL REFERENCES assistant_sessions(id),
      kind TEXT NOT NULL, name TEXT NOT NULL, mime TEXT NOT NULL, body BLOB NOT NULL, created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS assistant_message_media_session ON assistant_message_media(session_id);
  `);
  return {
    save(sessionId: string, parts: MediaPart[]) {
      return parts.map(part => {
        const {kind, name, mime, bytes} = part;
        const id = randomUUID();
        db.prepare('INSERT INTO assistant_message_media VALUES (?,?,?,?,?,?,?)').run(id, sessionId, kind, name, mime, bytes, now());
        return {id, kind, name, mime, bytes: bytes.byteLength};
      });
    },
    read(sessionId: string, id: string) {
      const file = row<{name: string; mime: string; body: Uint8Array}>(`
        SELECT m.name,m.mime,m.body FROM assistant_message_media m
        JOIN assistant_sessions s ON s.id=m.session_id
        WHERE m.session_id=? AND m.id=? AND s.archived_at IS NULL AND s.deleted_at IS NULL
      `, sessionId, id);
      if (!file) throw new ToolError('NOT_FOUND', '附件不存在或会话不可访问', 'correct_input', {}, 404);
      const inline = inlineMedia.has(file.mime);
      return {name: file.name, mime: inline ? file.mime : 'application/octet-stream', inline, bytes: file.body};
    },
  };
}
