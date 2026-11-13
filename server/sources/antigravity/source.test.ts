import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AntigravitySource } from './source';

describe('AntigravitySource', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = join(tmpdir(), `habblaud-agy-test-${Date.now()}`);
    mkdirSync(join(tempDir, 'presence'), { recursive: true });
    mkdirSync(join(tempDir, 'brain', '12345678-aaaa-bbbb-cccc-123456789abc', '.system_generated', 'logs'), { recursive: true });
  });

  afterEach(() => {
    try {
      rmSync(tempDir, { recursive: true, force: true });
    } catch {
      // ignore
    }
  });

  it('inicia e detecta sessões ativas do Antigravity', () => {
    const convId = '12345678-aaaa-bbbb-cccc-123456789abc';
    const lockPath = join(tempDir, 'presence', `${convId}.lock`);
    writeFileSync(lockPath, '');

    const transcriptPath = join(tempDir, 'brain', convId, '.system_generated', 'logs', 'transcript.jsonl');
    writeFileSync(
      transcriptPath,
      JSON.stringify({
        step_index: 0,
        source: 'USER_EXPLICIT',
        type: 'USER_INPUT',
        status: 'DONE',
        created_at: new Date().toISOString(),
        content: '<USER_REQUEST>\nOlá do Antigravity\n</USER_REQUEST>',
      }) + '\n'
    );

    const accounts = {
      setProviderAccounts: vi.fn(),
    } as any;

    const addedMains: any[] = [];
    const addedActivities: any[] = [];
    const office = {
      beginBoot: vi.fn(),
      endBoot: vi.fn(),
      addMain: vi.fn((m) => addedMains.push(m)),
      addSub: vi.fn(),
      addActivity: vi.fn((id, a) => addedActivities.push({ id, a })),
      setStatus: vi.fn(),
      closeMain: vi.fn(),
      completeSub: vi.fn(),
      get: vi.fn(),
      has: vi.fn(() => true),
      fillWorkingActivity: vi.fn(),
    } as any;

    const source = new AntigravitySource({
      accounts,
      office,
      dirs: [tempDir],
      pollMs: 1000,
    });

    source.start();

    expect(accounts.setProviderAccounts).toHaveBeenCalledWith(
      'antigravity',
      expect.arrayContaining([
        expect.objectContaining({
          dir: tempDir,
        }),
      ])
    );

    expect(office.addMain).toHaveBeenCalledWith(
      expect.objectContaining({
        id: 'agy_12345678',
        provider: 'antigravity',
        sessionId: convId,
      })
    );

    expect(addedActivities.length).toBeGreaterThan(0);
    expect(addedActivities[0].a.kind).toBe('prompt');

    source.stop();
  });

  it('detecta e aciona subagentes quando o orchestrator cria subagentes', () => {
    const parentConvId = '12345678-aaaa-bbbb-cccc-123456789abc';
    const subConvId = '87654321-bbbb-cccc-dddd-987654321cba';

    writeFileSync(join(tempDir, 'presence', `${parentConvId}.lock`), '');

    // Parent transcript with invoke_subagent and created subagents
    const parentTranscript = join(tempDir, 'brain', parentConvId, '.system_generated', 'logs', 'transcript.jsonl');
    writeFileSync(
      parentTranscript,
      JSON.stringify({
        step_index: 0,
        source: 'MODEL',
        type: 'PLANNER_RESPONSE',
        status: 'DONE',
        created_at: new Date().toISOString(),
        tool_calls: [
          {
            name: 'invoke_subagent',
            args: {
              Role: 'Explorer Specialist',
              TypeName: 'researcher',
              Prompt: 'Analisar arquivos',
            },
          },
        ],
      }) +
        '\n' +
        JSON.stringify({
          step_index: 1,
          source: 'MODEL',
          type: 'GENERIC',
          status: 'DONE',
          created_at: new Date().toISOString(),
          content: `Created the following subagents:\n{\n  "conversationId": "${subConvId}"\n}`,
        }) +
        '\n'
    );

    // Subagent transcript
    mkdirSync(join(tempDir, 'brain', subConvId, '.system_generated', 'logs'), { recursive: true });
    const subTranscript = join(tempDir, 'brain', subConvId, '.system_generated', 'logs', 'transcript.jsonl');
    writeFileSync(
      subTranscript,
      JSON.stringify({
        step_index: 0,
        source: 'MODEL',
        type: 'PLANNER_RESPONSE',
        status: 'DONE',
        created_at: new Date().toISOString(),
        tool_calls: [{ name: 'read_file', args: { Path: 'src/app.ts' } }],
      }) + '\n'
    );

    const accounts = { setProviderAccounts: vi.fn() } as any;
    const addedSubs: any[] = [];
    const addedActivities: any[] = [];
    const office = {
      beginBoot: vi.fn(),
      endBoot: vi.fn(),
      addMain: vi.fn(),
      addSub: vi.fn((s) => addedSubs.push(s)),
      addActivity: vi.fn((id, a) => addedActivities.push({ id, a })),
      setStatus: vi.fn(),
      closeMain: vi.fn(),
      completeSub: vi.fn(),
      get: vi.fn(),
      has: vi.fn((id) => id === 'agy_12345678'),
      fillWorkingActivity: vi.fn(),
    } as any;

    const source = new AntigravitySource({
      accounts,
      office,
      dirs: [tempDir],
      pollMs: 1000,
    });

    source.start();

    expect(office.addMain).toHaveBeenCalledWith(
      expect.objectContaining({
        id: 'agy_12345678',
        sessionId: parentConvId,
      })
    );

    expect(office.addSub).toHaveBeenCalledWith(
      expect.objectContaining({
        id: 'agy_87654321',
        parentId: 'agy_12345678',
        sessionId: subConvId,
      })
    );

    // Verify subagent activity was read and added to office
    const subActivity = addedActivities.find((act) => act.id === 'agy_87654321');
    expect(subActivity).toBeDefined();
    expect(subActivity.a.tool).toBe('read_file');

    source.stop();
  });
});
