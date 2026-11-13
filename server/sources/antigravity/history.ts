import { existsSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type { HistoryProvider, HistoryResolveResult } from '../source';
import type { Provider, RecentSession } from '../../../shared/types';
import { listRecentConversations } from './db';
import { createAntigravityTerminalParser } from './terminal';
import { tr } from '../../../shared/i18n';

export interface AntigravityHistoryOptions {
  dir: string;
  openSessionIds?: () => Set<string>;
}

export class AntigravityHistory implements HistoryProvider {
  readonly provider: Provider = 'antigravity';

  constructor(private readonly opts: AntigravityHistoryOptions) {}

  hasAccount(account: string): boolean {
    return account === '.antigravity' || account.includes('antigravity');
  }

  async list(): Promise<RecentSession[]> {
    const dbPath = join(this.opts.dir, 'conversation_summaries.db');
    const recent = listRecentConversations(dbPath, 30);
    const openSet = this.opts.openSessionIds?.() ?? new Set<string>();
    const out: RecentSession[] = [];

    for (const c of recent) {
      const transcript = join(this.opts.dir, 'brain', c.conversationId, '.system_generated', 'logs', 'transcript.jsonl');
      let size = 0;
      let lastAt = c.lastModifiedTime ? Date.parse(c.lastModifiedTime) : Date.now();
      if (Number.isNaN(lastAt)) lastAt = Date.now();

      if (existsSync(transcript)) {
        try {
          const st = statSync(transcript);
          size = st.size;
          if (st.mtimeMs > lastAt) lastAt = st.mtimeMs;
        } catch {
          // ignore stat error
        }
      }

      out.push({
        account: '.antigravity',
        provider: 'antigravity',
        sessionId: c.conversationId,
        projectDir: c.workspaceDir || c.conversationId,
        title: c.title,
        lastAt,
        size,
        open: openSet.has(c.conversationId),
      });
    }

    return out;
  }

  resolve(account: string, sessionId: string): HistoryResolveResult {
    if (!this.hasAccount(account)) {
      return { status: 404, error: tr('Conta desconhecida: {0}', [account]) };
    }
    // Validation against path traversal: only UUID / alphanumeric and dashes
    if (!/^[0-9a-zA-Z_-]+$/.test(sessionId)) {
      return { status: 400, error: tr('Id de sessão inválido') };
    }
    const transcript = join(this.opts.dir, 'brain', sessionId, '.system_generated', 'logs', 'transcript.jsonl');
    if (!existsSync(transcript)) {
      return { status: 404, error: tr('Conversa não encontrada') };
    }
    return {
      path: transcript,
      createParser: () => createAntigravityTerminalParser(),
    };
  }
}
