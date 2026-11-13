import { describe, expect, it } from 'vitest';
import { AntigravityTerminalParser } from './terminal';

describe('AntigravityTerminalParser', () => {
  it('converte linhas do transcript em TerminalEntry', () => {
    const parser = new AntigravityTerminalParser();

    // 1. User Input
    const userLine = JSON.stringify({
      step_index: 0,
      source: 'USER_EXPLICIT',
      type: 'USER_INPUT',
      status: 'DONE',
      created_at: '2026-11-13T12:00:00Z',
      content: '<USER_REQUEST>\nOlá agente\n</USER_REQUEST>',
    });
    const userEntries = parser.push(userLine);
    expect(userEntries).toHaveLength(1);
    expect(userEntries[0]).toMatchObject({
      kind: 'user',
      text: 'Olá agente',
    });

    // 2. Planner Response (Thinking + Tool Call)
    const modelLine = JSON.stringify({
      step_index: 1,
      source: 'MODEL',
      type: 'PLANNER_RESPONSE',
      status: 'DONE',
      created_at: '2026-11-13T12:00:01Z',
      thinking: 'Vou listar os arquivos',
      tool_calls: [{ name: 'run_command', args: { CommandLine: 'dir' } }],
    });
    const modelEntries = parser.push(modelLine);
    expect(modelEntries).toHaveLength(2);
    expect(modelEntries[0]).toMatchObject({ kind: 'thinking', text: 'Vou listar os arquivos' });
    expect(modelEntries[1]).toMatchObject({ kind: 'tool', tool: 'run_command', input: 'dir' });

    // 3. Generic (Tool Result)
    const resultLine = JSON.stringify({
      step_index: 2,
      source: 'MODEL',
      type: 'GENERIC',
      status: 'DONE',
      created_at: '2026-11-13T12:00:02Z',
      content: 'Arquivo1.txt\nArquivo2.txt',
    });
    const resultEntries = parser.push(resultLine);
    expect(resultEntries).toHaveLength(1);
    expect(resultEntries[0]).toMatchObject({
      kind: 'result',
      toolUseId: 'agy-1-tool-0',
      text: 'Arquivo1.txt\nArquivo2.txt',
    });
  });
});
