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
});
