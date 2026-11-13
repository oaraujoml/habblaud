import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { defaultAntigravityDir, detectAntigravityAccount, isAntigravityDir } from './detect';

describe('detect antigravity', () => {
  it('defaultAntigravityDir com env customizado ou fallback ~/.gemini/antigravity', () => {
    expect(defaultAntigravityDir({ HABBLAUD_ANTIGRAVITY_DIR: resolve('/custom/agy') }, '/home/user')).toBe(resolve('/custom/agy'));
    expect(defaultAntigravityDir({}, '/home/user')).toMatch(/\.gemini[\\/]antigravity/);
  });

  it('detectAntigravityAccount devolve metadados da conta', () => {
    const acc = detectAntigravityAccount('/path/to/antigravity');
    expect(acc).toEqual({
      id: '.antigravity',
      name: 'Google Antigravity',
      short: 'G',
      color: '#4285F4',
      configDir: '/path/to/antigravity',
      provider: 'antigravity',
    });
  });
});
