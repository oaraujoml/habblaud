import { existsSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';

export interface AntigravityConversationMeta {
  conversationId: string;
  title: string;
  workspaceDir?: string;
  status: string;
  notFullyIdle: boolean;
  killed: boolean;
  parentConversationId?: string;
  agentName?: string;
  nestingDepth?: number;
  lastModifiedTime?: string;
}

export function parseWorkspaceDir(raw: string | undefined): string | undefined {
  if (!raw || !raw.trim()) return undefined;
  try {
    const list = JSON.parse(raw);
    if (Array.isArray(list) && list.length > 0 && typeof list[0] === 'string') {
      const u = new URL(list[0]);
      let pathname = decodeURIComponent(u.pathname);
      // On Windows: /C:/Users/... -> C:/Users/...
      if (/^\/[a-zA-Z]:/.test(pathname)) pathname = pathname.slice(1);
      return pathname;
    }
  } catch {
    // fallback if raw string
  }
  return undefined;
}

export function readConversationMeta(dbPath: string, conversationId: string): AntigravityConversationMeta | undefined {
  if (!existsSync(dbPath)) return undefined;
  let db: DatabaseSync | null = null;
  try {
    db = new DatabaseSync(dbPath, { readOnly: true, open: true });
    const stmt = db.prepare(
      'SELECT conversation_id, title, workspace_uris, status, not_fully_idle, killed, parent_conversation_id, agent_name, nesting_depth, last_modified_time FROM conversation_summaries WHERE conversation_id = ?'
    );
    const row = stmt.get(conversationId) as Record<string, unknown> | undefined;
    if (!row) return undefined;

    const parentId = typeof row.parent_conversation_id === 'string' && row.parent_conversation_id.trim() ? row.parent_conversation_id.trim() : undefined;
    const name = typeof row.agent_name === 'string' && row.agent_name.trim() ? row.agent_name.trim() : undefined;
    const title = typeof row.title === 'string' && row.title.trim() ? row.title.trim() : 'Nova Sessão';

    return {
      conversationId: String(row.conversation_id),
      title,
      workspaceDir: parseWorkspaceDir(typeof row.workspace_uris === 'string' ? row.workspace_uris : undefined),
      status: String(row.status ?? ''),
      notFullyIdle: Number(row.not_fully_idle) === 1,
      killed: Number(row.killed) === 1,
      parentConversationId: parentId,
      agentName: name,
      nestingDepth: typeof row.nesting_depth === 'number' ? row.nesting_depth : 0,
      lastModifiedTime: typeof row.last_modified_time === 'string' ? row.last_modified_time : undefined,
    };
  } catch {
    return undefined;
  } finally {
    if (db) {
      try {
        db.close();
      } catch {
        // ignore
      }
    }
  }
}

export function listSubagents(dbPath: string): AntigravityConversationMeta[] {
  if (!existsSync(dbPath)) return [];
  let db: DatabaseSync | null = null;
  try {
    db = new DatabaseSync(dbPath, { readOnly: true, open: true });
    const stmt = db.prepare(
      'SELECT conversation_id, title, workspace_uris, status, not_fully_idle, killed, parent_conversation_id, agent_name, nesting_depth, last_modified_time FROM conversation_summaries WHERE parent_conversation_id IS NOT NULL AND parent_conversation_id != "" ORDER BY nesting_depth ASC, last_modified_time ASC'
    );
    const rows = stmt.all() as Array<Record<string, unknown>>;
    return rows.map((row) => ({
      conversationId: String(row.conversation_id),
      title: typeof row.title === 'string' && row.title.trim() ? row.title.trim() : '',
      workspaceDir: parseWorkspaceDir(typeof row.workspace_uris === 'string' ? row.workspace_uris : undefined),
      status: String(row.status ?? ''),
      notFullyIdle: Number(row.not_fully_idle) === 1,
      killed: Number(row.killed) === 1,
      parentConversationId: typeof row.parent_conversation_id === 'string' && row.parent_conversation_id.trim() ? row.parent_conversation_id.trim() : undefined,
      agentName: typeof row.agent_name === 'string' && row.agent_name.trim() ? row.agent_name.trim() : undefined,
      nestingDepth: typeof row.nesting_depth === 'number' ? row.nesting_depth : 1,
      lastModifiedTime: typeof row.last_modified_time === 'string' ? row.last_modified_time : undefined,
    }));
  } catch {
    return [];
  } finally {
    if (db) {
      try {
        db.close();
      } catch {
        // ignore
      }
    }
  }
}

export function listRecentConversations(dbPath: string, limit = 50): AntigravityConversationMeta[] {
  if (!existsSync(dbPath)) return [];
  let db: DatabaseSync | null = null;
  try {
    db = new DatabaseSync(dbPath, { readOnly: true, open: true });
    const stmt = db.prepare(
      'SELECT conversation_id, title, workspace_uris, status, not_fully_idle, killed, parent_conversation_id, agent_name, nesting_depth, last_modified_time FROM conversation_summaries ORDER BY last_modified_time DESC LIMIT ?'
    );
    const rows = stmt.all(limit) as Array<Record<string, unknown>>;
    return rows.map((row) => ({
      conversationId: String(row.conversation_id),
      title: typeof row.title === 'string' && row.title.trim() ? row.title.trim() : 'Nova Sessão',
      workspaceDir: parseWorkspaceDir(typeof row.workspace_uris === 'string' ? row.workspace_uris : undefined),
      status: String(row.status ?? ''),
      notFullyIdle: Number(row.not_fully_idle) === 1,
      killed: Number(row.killed) === 1,
      parentConversationId: typeof row.parent_conversation_id === 'string' && row.parent_conversation_id.trim() ? row.parent_conversation_id.trim() : undefined,
      agentName: typeof row.agent_name === 'string' && row.agent_name.trim() ? row.agent_name.trim() : undefined,
      nestingDepth: typeof row.nesting_depth === 'number' ? row.nesting_depth : 0,
      lastModifiedTime: typeof row.last_modified_time === 'string' ? row.last_modified_time : undefined,
    }));
  } catch {
    return [];
  } finally {
    if (db) {
      try {
        db.close();
      } catch {
        // ignore
      }
    }
  }
}
