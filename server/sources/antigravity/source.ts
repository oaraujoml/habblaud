import { existsSync, readdirSync, statSync } from 'node:fs';
import { basename, join } from 'node:path';
import type { AccountsService } from '../../accounts/service';
import type { Office } from '../../model/office';
import type { AgentSource } from '../source';
import type { Provider, SourceInfo } from '../../../shared/types';
import { detectAntigravityAccount } from './detect';
import { readConversationMeta } from './db';
import { parseAntigravityLine } from './transcript';
import { createAntigravityTerminalParser } from './terminal';
import { FileTail } from '../tail';
import { log } from '../../log';
import { tr } from '../../../shared/i18n';

export interface AntigravitySourceOptions {
  accounts: AccountsService;
  office: Office;
  dirs: string[];
  pollMs?: number;
  now?: () => number;
}

interface ActiveSession {
  conversationId: string;
  agentId: string;
  dir: string;
  tail?: FileTail;
  isMain: boolean;
  parentId?: string;
  cwd: string;
  lastSeenMs: number;
}

export class AntigravitySource implements AgentSource {
  readonly provider: Provider = 'antigravity';
  private timer: ReturnType<typeof setInterval> | null = null;
  private readonly sessions = new Map<string, ActiveSession>();
  private readonly dir: string;
  private readonly pollMs: number;
  private readonly now: () => number;

  constructor(private readonly opts: AntigravitySourceOptions) {
    this.dir = opts.dirs[0];
    this.pollMs = opts.pollMs ?? 2000;
    this.now = opts.now ?? Date.now;
  }

  start(): void {
    if (!this.dir || !existsSync(this.dir)) return;

    this.opts.office.beginBoot();
    try {
      const acc = detectAntigravityAccount(this.dir);
      this.opts.accounts.setProviderAccounts('antigravity', [
        {
          dir: this.dir,
          detected: acc,
        },
      ]);

      this.scanPresence();
    } finally {
      this.opts.office.endBoot();
    }

    this.timer = setInterval(() => {
      try {
        this.scanPresence();
      } catch (err) {
        log.warn(tr('Erro ao sincronizar sessões do Antigravity: {0}', [String(err)]));
      }
    }, this.pollMs);
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    this.sessions.clear();
  }

  sources(): SourceInfo[] {
    if (!this.dir) return [];
    return [
      {
        provider: 'antigravity',
        label: '.antigravity',
        path: this.dir,
        sessions: this.sessions.size,
        ok: true,
      },
    ];
  }

  transcriptPathOf(agentId: string): string | undefined {
    const session = Array.from(this.sessions.values()).find((s) => s.agentId === agentId);
    if (!session) return undefined;
    const path = join(session.dir, 'brain', session.conversationId, '.system_generated', 'logs', 'transcript.jsonl');
    return existsSync(path) ? path : undefined;
  }

  terminalParser(): ReturnType<typeof createAntigravityTerminalParser> {
    return createAntigravityTerminalParser();
  }

  openSessionIds(): Set<string> {
    return new Set(Array.from(this.sessions.values()).map((s) => s.conversationId));
  }

  private scanPresence(): void {
    const presenceDir = join(this.dir, 'presence');
    const dbPath = join(this.dir, 'conversation_summaries.db');
    const now = this.now();

    const activeLocks = new Set<string>();
    if (existsSync(presenceDir)) {
      try {
        const files = readdirSync(presenceDir);
        for (const file of files) {
          if (!file.endsWith('.lock')) continue;
          const convId = file.slice(0, -5);
          if (!/^[0-9a-fA-F-]+$/.test(convId)) continue;

          // Check lock freshness or recent activity
          const lockPath = join(presenceDir, file);
          let fresh = false;
          try {
            const st = statSync(lockPath);
            // Lock created/modified within last 4 hours is considered active
            if (now - st.mtimeMs < 4 * 3600_000) {
              fresh = true;
            }
          } catch {
            // ignore
          }

          const meta = readConversationMeta(dbPath, convId);
          if (meta?.notFullyIdle || meta?.status === 'CASCADE_RUN_STATUS_RUNNING') {
            fresh = true;
          }

          if (fresh) {
            activeLocks.add(convId);
          }
        }
      } catch {
        // ignore presence read error
      }
    }

    // 1. Remove closed sessions
    for (const [convId, s] of Array.from(this.sessions.entries())) {
      if (!activeLocks.has(convId)) {
        if (s.isMain) {
          this.opts.office.closeMain(s.agentId);
        } else {
          this.opts.office.completeSub(s.agentId, { notify: false });
        }
        this.sessions.delete(convId);
      }
    }

    // 2. Add or update sessions
    for (const convId of activeLocks) {
      let session = this.sessions.get(convId);
      const meta = readConversationMeta(dbPath, convId);
      const isSubagent = Boolean(meta?.parentConversationId);
      const parentConvId = meta?.parentConversationId;
      const parentSession = parentConvId ? this.sessions.get(parentConvId) : undefined;
      const parentId = parentSession ? parentSession.agentId : parentConvId ? `agy_${parentConvId.slice(0, 8)}` : undefined;

      const agentId = `agy_${convId.slice(0, 8)}`;
      const cwd = meta?.workspaceDir || join(this.dir, 'scratch');
      const transcriptPath = join(this.dir, 'brain', convId, '.system_generated', 'logs', 'transcript.jsonl');

      if (!session) {
        session = {
          conversationId: convId,
          agentId,
          dir: this.dir,
          isMain: !isSubagent,
          parentId,
          cwd,
          lastSeenMs: now,
        };

        if (existsSync(transcriptPath)) {
          session.tail = new FileTail(transcriptPath);
        }

        this.sessions.set(convId, session);

        const initialStatus = meta?.notFullyIdle ? 'working' : 'idle';
        if (session.isMain) {
          this.opts.office.addMain({
            id: agentId,
            provider: 'antigravity',
            account: '.antigravity',
            sessionId: convId,
            cwd,
            role: 'Google Antigravity',
            startedAt: now,
            status: initialStatus,
          });
        } else if (parentId) {
          this.opts.office.addSub({
            id: agentId,
            parentId,
            sessionId: convId,
            role: meta?.agentName || tr('Subagente (Antigravity)'),
            title: meta?.title,
            background: false,
            startedAt: now,
          });
        }
      }

      // Read new transcript lines if available
      if (!session.tail && existsSync(transcriptPath)) {
        session.tail = new FileTail(transcriptPath);
      }

      if (session.tail) {
        const readResult = session.tail.read();
        for (const line of readResult.lines) {
          const parsed = parseAntigravityLine(line);
          if (!parsed) continue;

          for (const act of parsed.activities) {
            this.opts.office.addActivity(agentId, act, true, { feed: true });
          }

          if (parsed.statusHint) {
            this.opts.office.setStatus(agentId, parsed.statusHint, parsed.waitingFor);
          }
        }
      }

      // Update idle status if running finished
      if (meta && !meta.notFullyIdle && meta.status === 'CASCADE_RUN_STATUS_IDLE') {
        const currentAgent = this.opts.office.get(agentId);
        if (currentAgent && currentAgent.status === 'working') {
          this.opts.office.setStatus(agentId, 'idle');
        }
      }
    }
  }
}
