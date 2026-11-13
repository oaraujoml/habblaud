import { describe, expect, it } from 'vitest';
import { parseWorkspaceDir } from './db';

describe('antigravity db', () => {
  it('parseWorkspaceDir converte file URL codificada em caminho local', () => {
    expect(parseWorkspaceDir('["file:///c%3A/Users/ss1096844/dev/pp"]')).toMatch(/Users[\\/]ss1096844[\\/]dev[\\/]pp/);
    expect(parseWorkspaceDir('["file:///home/user/project"]')).toBe('/home/user/project');
    expect(parseWorkspaceDir('')).toBeUndefined();
    expect(parseWorkspaceDir('invalid json')).toBeUndefined();
  });
});
