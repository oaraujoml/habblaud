import { existsSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { DetectedAccount } from '../../accounts/detect';
import { expandHome } from '../../accounts/detect';

export function isDir(p: string): boolean {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
}

export function isAntigravityDir(p: string): boolean {
  if (!isDir(p)) return false;
  return existsSync(join(p, 'presence')) || existsSync(join(p, 'brain')) || existsSync(join(p, 'conversation_summaries.db'));
}

export function defaultAntigravityDir(env: NodeJS.ProcessEnv = process.env, home: string = env.HOME || homedir()): string {
  const custom = env.HABBLAUD_ANTIGRAVITY_DIR?.trim() || env.ANTIGRAVITY_HOME?.trim();
  if (custom) return expandHome(custom, home);
  return join(home, '.gemini', 'antigravity');
}

export function discoverAntigravityDirs(env: NodeJS.ProcessEnv = process.env, home: string = env.HOME || homedir()): string[] {
  const dirs: string[] = [];
  const primary = defaultAntigravityDir(env, home);
  if (isAntigravityDir(primary)) {
    dirs.push(primary);
  }
  return dirs;
}

export function detectAntigravityAccount(dir: string): DetectedAccount {
  return {
    id: '.antigravity',
    name: 'Google Antigravity',
    short: 'G',
    color: '#4285F4',
    configDir: dir,
    provider: 'antigravity',
  };
}
