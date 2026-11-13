import { existsSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type { AccountsService } from '../../accounts/service';
import type { Office } from '../../model/office';
import type { AgentSource } from '../source';
import type { Provider, SourceInfo } from '../../../shared/types';
import { detectAntigravityAccount } from './detect';
import { listRecentConversations, listSubagents, readConversationMeta, type AntigravityConversationMeta } from './db';
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
  subDone?: boolean;
}

export class AntigravitySource implements AgentSource {
  readonly provider: Provider = 'antigravity';
  private timer: ReturnType<typeof setInterval> | null = null;
  private readonly sessions = new Map<string, ActiveSession>();
  private readonly discoveredSubagents = new Map<string, string>(); // childConvId -> parentConvId
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
    this.discoveredSubagents.clear();
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

    // 1. Detect active main conversations
    const activeMainConvIds = new Set<string>();
    if (existsSync(presenceDir)) {
      try {
        const files = readdirSync(presenceDir);
        for (const file of files) {
          if (!file.endsWith('.lock')) continue;
          const convId = file.slice(0, -5);
          if (!/^[0-9a-fA-F-]+$/.test(convId)) continue;

          const lockPath = join(presenceDir, file);
          let fresh = false;
          try {
            const st = statSync(lockPath);
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
            activeMainConvIds.add(convId);
          }
        }
      } catch {
        // ignore presence read error
      }
    }

    // Also include any active main conversation in DB
    const recent = listRecentConversations(dbPath, 20);
    for (const r of recent) {
      if (!r.parentConversationId && (r.notFullyIdle || r.status === 'CASCADE_RUN_STATUS_RUNNING')) {
        activeMainConvIds.add(r.conversationId);
      }
    }

    // 2. Discover subagents linked to active parent conversations
    const activeSubagents = new Map<string, AntigravityConversationMeta>();
    const allKnownActive = new Set<string>(activeMainConvIds);

    const subList = listSubagents(dbPath);
    let addedAny = true;
    while (addedAny) {
      addedAny = false;
      for (const sub of subList) {
        if (!sub.parentConversationId) continue;
        if (allKnownActive.has(sub.parentConversationId) && !allKnownActive.has(sub.conversationId)) {
          const isTracked = this.sessions.has(sub.conversationId);
          const isRunning = sub.notFullyIdle || sub.status === 'CASCADE_RUN_STATUS_RUNNING';
          const notKilled = !sub.killed;

          if (notKilled && (isRunning || isTracked)) {
            allKnownActive.add(sub.conversationId);
            activeSubagents.set(sub.conversationId, sub);
            addedAny = true;
          }
        }
      }
    }

    // Also include subagents discovered from transcript
    for (const [subConvId, parentConvId] of this.discoveredSubagents.entries()) {
      if (allKnownActive.has(parentConvId) && !allKnownActive.has(subConvId)) {
        allKnownActive.add(subConvId);
        if (!activeSubagents.has(subConvId)) {
          const meta = readConversationMeta(dbPath, subConvId);
          if (meta && !meta.killed) {
            activeSubagents.set(subConvId, meta);
          }
        }
      }
    }

    // 3. Remove closed sessions
    for (const [convId, s] of Array.from(this.sessions.entries())) {
      if (!allKnownActive.has(convId)) {
        if (s.isMain) {
          this.opts.office.closeMain(s.agentId);
        } else {
          if (!s.subDone) {
            this.opts.office.completeSub(s.agentId, { notify: false });
          }
        }
        this.sessions.delete(convId);
        this.discoveredSubagents.delete(convId);
      }
    }

    // 4. Sync main sessions (this reads main transcripts and discovers subagents)
    for (const convId of activeMainConvIds) {
      this.syncSession(convId, true, undefined, undefined, dbPath, now);
    }

    // Also include any subagents discovered from reading transcripts
    for (const [subConvId, parentConvId] of this.discoveredSubagents.entries()) {
      if (allKnownActive.has(parentConvId) && !allKnownActive.has(subConvId)) {
        allKnownActive.add(subConvId);
        if (!activeSubagents.has(subConvId)) {
          const meta = readConversationMeta(dbPath, subConvId);
          activeSubagents.set(
            subConvId,
            meta ?? {
              conversationId: subConvId,
              parentConversationId: parentConvId,
              title: '',
              status: 'CASCADE_RUN_STATUS_RUNNING',
              notFullyIdle: true,
              killed: false,
            }
          );
        }
      }
    }

    // 5. Sync subagent sessions ordered by nesting depth
    const sortedSubagents = Array.from(activeSubagents.values()).sort(
      (a, b) => (a.nestingDepth ?? 1) - (b.nestingDepth ?? 1)
    );
    for (const sub of sortedSubagents) {
      const parentConvId = sub.parentConversationId;
      const parentSession = parentConvId ? this.sessions.get(parentConvId) : undefined;
      const parentId = parentSession ? parentSession.agentId : parentConvId ? `agy_${parentConvId.slice(0, 8)}` : undefined;
      this.syncSession(sub.conversationId, false, parentId, sub, dbPath, now);
    }
  }

  private syncSession(
    convId: string,
    isMain: boolean,
    parentId: string | undefined,
    subMeta: AntigravityConversationMeta | undefined,
    dbPath: string,
    now: number
  ): void {
    let session = this.sessions.get(convId);
    const meta = subMeta ?? readConversationMeta(dbPath, convId);
    const agentId = `agy_${convId.slice(0, 8)}`;
    const parentSession = parentId ? Array.from(this.sessions.values()).find((s) => s.agentId === parentId) : undefined;
    const cwd = meta?.workspaceDir || parentSession?.cwd || join(this.dir, 'scratch');
    const transcriptPath = join(this.dir, 'brain', convId, '.system_generated', 'logs', 'transcript.jsonl');

    if (!session) {
      session = {
        conversationId: convId,
        agentId,
        dir: this.dir,
        isMain,
        parentId,
        cwd,
        lastSeenMs: now,
      };

      if (existsSync(transcriptPath)) {
        session.tail = new FileTail(transcriptPath);
      }

      const initialStatus = meta?.notFullyIdle || meta?.status === 'CASCADE_RUN_STATUS_RUNNING' ? 'working' : 'idle';

      if (isMain) {
        this.sessions.set(convId, session);
        this.opts.office.addMain({
          id: agentId,
          provider: 'antigravity',
          account: '.antigravity',
          sessionId: convId,
          cwd,
          role: meta?.agentName || 'Google Antigravity',
          startedAt: now,
          status: initialStatus,
        });
      } else if (parentId && this.opts.office.has(parentId)) {
        this.sessions.set(convId, session);
        const role = meta?.agentName || tr('Subagente (Antigravity)');
        this.opts.office.addSub({
          id: agentId,
          parentId,
          sessionId: convId,
          role,
          title: meta?.title,
          background: false,
          startedAt: now,
        });
      } else {
        // Parent not ready in office yet; will be added on next cycle
        return;
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
          if (session.subDone && parsed.statusHint === 'working') {
            this.opts.office.reactivateSub(agentId);
            session.subDone = false;
          }
        }

        if (parsed.createdSubagents) {
          for (const childId of parsed.createdSubagents) {
            this.discoveredSubagents.set(childId, convId);
          }
        }
      }
    }

    // Update subagent completion or main agent idle status
    if (!isMain) {
      const isIdle = meta && !meta.notFullyIdle && meta.status === 'CASCADE_RUN_STATUS_IDLE';
      if (isIdle && !session.subDone) {
        this.opts.office.completeSub(agentId, { notify: true });
        session.subDone = true;
      } else if (meta?.status === 'CASCADE_RUN_STATUS_RUNNING' && session.subDone) {
        this.opts.office.reactivateSub(agentId);
        session.subDone = false;
      }
    } else {
      this.opts.office.fillWorkingActivity(agentId);
      if (meta && !meta.notFullyIdle && meta.status === 'CASCADE_RUN_STATUS_IDLE') {
        const currentAgent = this.opts.office.get(agentId);
        if (currentAgent && currentAgent.status === 'working') {
          this.opts.office.setStatus(agentId, 'idle');
        }
      }
    }
  }
}
