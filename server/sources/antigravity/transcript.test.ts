import { describe, expect, it } from 'vitest';
import { describeAntigravityTool, parseAntigravityLine } from './transcript';

describe('antigravity transcript', () => {
  it('describeAntigravityTool mapeia ferramentas do Antigravity', () => {
    expect(describeAntigravityTool('read_file', { Path: 'C:/app/src/index.ts' })).toMatchObject({
      tool: 'read_file',
      desc: { kind: 'read', text: 'Lendo index.ts' },
    });
    expect(describeAntigravityTool('edit_file', { Path: 'C:/app/src/index.ts' })).toMatchObject({
      tool: 'edit_file',
      desc: { kind: 'edit', text: 'Editando index.ts' },
    });
    expect(describeAntigravityTool('write_file', { Path: 'C:/app/README.md' })).toMatchObject({
      tool: 'write_file',
      desc: { kind: 'write', text: 'Escrevendo README.md' },
    });
    expect(describeAntigravityTool('search_web', { query: 'vitest mocks' })).toMatchObject({
      tool: 'search_web',
      desc: { kind: 'web', text: 'Pesquisando “vitest mocks”' },
    });
    expect(describeAntigravityTool('run_command', { CommandLine: 'npm test', toolSummary: 'Unit tests' })).toMatchObject({
      tool: 'run_command',
      desc: { kind: 'test', text: 'Rodando testes' },
    });
    expect(describeAntigravityTool('ask_question', { questions: [{ question: 'Qual banco usar?' }] })).toMatchObject({
      tool: 'ask_question',
      desc: { kind: 'ask', text: 'Fazendo uma pergunta a você' },
    });
    expect(describeAntigravityTool('invoke_subagent', { Role: 'Database Migration Assistant' })).toMatchObject({
      tool: 'invoke_subagent',
      desc: { kind: 'delegate', text: 'Delegando: Database Migration Assistant' },
    });
  });

  it('parseAntigravityLine processa USER_INPUT', () => {
    const raw = JSON.stringify({
      step_index: 0,
      source: 'USER_EXPLICIT',
      type: 'USER_INPUT',
      status: 'DONE',
      created_at: '2026-11-13T12:00:00Z',
      content: '<USER_REQUEST>\nCriar um novo recurso\n</USER_REQUEST>',
    });
    const parsed = parseAntigravityLine(raw);
    expect(parsed).toBeDefined();
    expect(parsed?.activities[0]).toMatchObject({
      kind: 'prompt',
      text: 'Instrução recebida',
      detail: 'Criar um novo recurso',
    });
    expect(parsed?.statusHint).toBe('working');
  });

  it('parseAntigravityLine processa PLANNER_RESPONSE com tool_calls e thinking', () => {
    const raw = JSON.stringify({
      step_index: 1,
      source: 'MODEL',
      type: 'PLANNER_RESPONSE',
      status: 'DONE',
      created_at: '2026-11-13T12:00:01Z',
      thinking: 'Analisando o código fonte antes de editar.',
      tool_calls: [{ name: 'read_file', args: { Path: 'src/main.ts' } }],
    });
    const parsed = parseAntigravityLine(raw);
    expect(parsed).toBeDefined();
    expect(parsed?.activities).toHaveLength(2);
    expect(parsed?.activities[0].kind).toBe('think');
    expect(parsed?.activities[1].kind).toBe('read');
    expect(parsed?.activities[1].text).toBe('Lendo main.ts');
  });

  it('parseAntigravityLine sinaliza waiting ao chamar ask_question', () => {
    const raw = JSON.stringify({
      step_index: 2,
      source: 'MODEL',
      type: 'PLANNER_RESPONSE',
      status: 'DONE',
      created_at: '2026-11-13T12:00:02Z',
      tool_calls: [{ name: 'ask_question', args: { questions: [{ question: 'Confirmar deploy?' }] } }],
    });
    const parsed = parseAntigravityLine(raw);
    expect(parsed?.statusHint).toBe('waiting');
    expect(parsed?.waitingFor).toBe('responder uma pergunta');
  });

  it('parseAntigravityLine processa invoke_subagent com Subagents em lote e extrai subagentes criados', () => {
    const rawCall = JSON.stringify({
      step_index: 3,
      source: 'MODEL',
      type: 'PLANNER_RESPONSE',
      status: 'DONE',
      created_at: '2026-11-13T12:00:03Z',
      tool_calls: [
        {
          name: 'invoke_subagent',
          args: {
            Subagents: JSON.stringify([
              { Role: 'Explorer 1', TypeName: 'researcher', Prompt: 'Pesquisar logs' },
              { Role: 'Explorer 2', TypeName: 'tester', Prompt: 'Executar testes' },
            ]),
          },
        },
      ],
    });
    const parsedCall = parseAntigravityLine(rawCall);
    expect(parsedCall?.activities[0]).toMatchObject({
      kind: 'delegate',
      text: 'Delegando: Explorer 1, Explorer 2',
    });

    const rawResponse = JSON.stringify({
      step_index: 4,
      source: 'MODEL',
      type: 'GENERIC',
      status: 'DONE',
      created_at: '2026-11-13T12:00:04Z',
      content:
        'Created the following subagents:\n{\n  "conversationId": "11111111-2222-3333-4444-555555555555"\n}\n{\n  "conversationId": "66666666-7777-8888-9999-000000000000"\n}',
    });
    const parsedResp = parseAntigravityLine(rawResponse);
    expect(parsedResp?.createdSubagents).toEqual([
      '11111111-2222-3333-4444-555555555555',
      '66666666-7777-8888-9999-000000000000',
    ]);
  });
});
