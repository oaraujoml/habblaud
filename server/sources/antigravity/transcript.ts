import { basename, describeCommand, describeTool, maskSecrets, truncate, type ActivityDescription } from '../../../shared/activity';
import { tr } from '../../../shared/i18n';
import type { Activity, AgentStatus } from '../../../shared/types';

type Rec = Record<string, unknown>;

function str(v: unknown): string | undefined {
  return typeof v === 'string' && v.trim() ? v : undefined;
}

function num(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined;
}

function toMs(v: unknown): number {
  if (typeof v === 'string') {
    const t = Date.parse(v);
    if (!Number.isNaN(t)) return t;
  }
  return Date.now();
}

/** Descreve ferramentas e subagentes do Antigravity. */
export function describeAntigravityTool(rawName: string, input: Rec): { desc: ActivityDescription; tool: string } {
  switch (rawName) {
    case 'read_file': {
      const path = str(input.Path) || str(input.path);
      return { desc: describeTool('Read', { file_path: path }), tool: 'read_file' };
    }
    case 'edit_file': {
      const path = str(input.Path) || str(input.path);
      return { desc: describeTool('Edit', { file_path: path }), tool: 'edit_file' };
    }
    case 'write_file': {
      const path = str(input.Path) || str(input.path);
      return { desc: describeTool('Write', { file_path: path }), tool: 'write_file' };
    }
    case 'run_command': {
      const cmd = str(input.CommandLine) || str(input.command);
      const desc = str(input.toolSummary) || str(input.description);
      return { desc: describeCommand(cmd ?? '', desc), tool: 'run_command' };
    }
    case 'search_web': {
      const q = str(input.query);
      return { desc: describeTool('WebSearch', { query: q }), tool: 'search_web' };
    }
    case 'search_marketplace': {
      const queries = Array.isArray(input.queries) ? input.queries.join(', ') : str(input.queries);
      return { desc: { kind: 'search', icon: '🛒', text: tr('Buscando no Marketplace'), detail: queries }, tool: 'search_marketplace' };
    }
    case 'ask_question': {
      const questions = Array.isArray(input.questions) ? input.questions : [];
      return {
        desc: {
          kind: 'ask',
          icon: '❓',
          text: tr('Fazendo uma pergunta a você'),
          detail: questions[0] && typeof questions[0] === 'object' ? str((questions[0] as Rec).question) : undefined,
        },
        tool: 'ask_question',
      };
    }
    case 'invoke_subagent': {
      const role = str(input.Role);
      const prompt = str(input.Prompt);
      const type = str(input.TypeName);
      return {
        desc: describeTool('Agent', { description: role ? truncate(role, 40) : undefined, subagent_type: type, prompt }),
        tool: 'invoke_subagent',
      };
    }
    case 'send_message': {
      const msg = str(input.Message);
      const to = str(input.Recipient);
      return { desc: describeTool('SendMessage', { message: msg, to }), tool: 'send_message' };
    }
    case 'manage_task': {
      const act = str(input.Action);
      const id = str(input.TaskId);
      return { desc: { kind: 'run', icon: '⚙️', text: tr('Gerenciando tarefa: {0}', [act ?? 'status']), detail: id }, tool: 'manage_task' };
    }
    case 'schedule': {
      const prompt = str(input.Prompt);
      return { desc: { kind: 'plan', icon: '⏰', text: tr('Agendando tarefa'), detail: prompt ? truncate(prompt, 60) : undefined }, tool: 'schedule' };
    }
    default:
      return { desc: describeTool(rawName, input), tool: rawName };
  }
}

export interface AntigravityLineResult {
  stepIndex: number;
  source: string;
  type: string;
  status: string;
  at: number;
  activities: Activity[];
  statusHint?: AgentStatus;
  waitingFor?: string;
  tokens?: { in?: number; out?: number };
}

export function parseAntigravityLine(rawLine: string): AntigravityLineResult | undefined {
  if (!rawLine.trim()) return undefined;
  let j: Rec;
  try {
    j = JSON.parse(rawLine) as Rec;
  } catch {
    return undefined;
  }
  if (!j || typeof j !== 'object') return undefined;

  const stepIndex = num(j.step_index) ?? 0;
  const source = str(j.source) ?? 'UNKNOWN';
  const type = str(j.type) ?? 'GENERIC';
  const status = str(j.status) ?? 'DONE';
  const at = toMs(j.created_at);

  const activities: Activity[] = [];
  let statusHint: AgentStatus | undefined;
  let waitingFor: string | undefined;

  // USER_INPUT
  if (type === 'USER_INPUT') {
    const rawContent = str(j.content) ?? '';
    const cleanPrompt = rawContent.replace(/<USER_REQUEST>([\s\S]*?)<\/USER_REQUEST>/, '$1').trim();
    if (cleanPrompt) {
      activities.push({
        id: `step-${stepIndex}-prompt`,
        kind: 'prompt',
        icon: '💬',
        text: tr('Instrução recebida'),
        detail: truncate(maskSecrets(cleanPrompt), 300),
        at,
      });
      statusHint = 'working';
    }
  }

  // PLANNER_RESPONSE
  if (type === 'PLANNER_RESPONSE') {
    const thinking = str(j.thinking);
    if (thinking) {
      activities.push({
        id: `step-${stepIndex}-think`,
        kind: 'think',
        icon: '💭',
        text: tr('Pensando na resposta'),
        detail: truncate(maskSecrets(thinking), 300),
        at,
      });
      statusHint = 'working';
    }

    const toolCalls = Array.isArray(j.tool_calls) ? j.tool_calls : [];
    for (let idx = 0; idx < toolCalls.length; idx++) {
      const tc = toolCalls[idx] as Rec;
      if (!tc || typeof tc !== 'object') continue;
      const name = str(tc.name) ?? 'tool';
      const args = (tc.args && typeof tc.args === 'object' ? tc.args : {}) as Rec;
      const { desc, tool } = describeAntigravityTool(name, args);

      activities.push({
        id: `step-${stepIndex}-tool-${idx}`,
        kind: desc.kind,
        icon: desc.icon,
        text: desc.text,
        detail: desc.detail,
        tool,
        at,
      });

      if (name === 'ask_question') {
        statusHint = 'waiting';
        waitingFor = tr('responder uma pergunta');
      } else {
        statusHint = 'working';
      }
    }

    const content = str(j.content);
    if (content && !toolCalls.length && !thinking) {
      activities.push({
        id: `step-${stepIndex}-respond`,
        kind: 'respond',
        icon: '✍️',
        text: tr('Respondendo ao usuário'),
        detail: truncate(maskSecrets(content), 300),
        at,
      });
    }
  }

  const inTok = num(j.input_tokens);
  const outTok = num(j.output_tokens);
  const tokens = inTok !== undefined || outTok !== undefined ? { in: inTok, out: outTok } : undefined;

  return {
    stepIndex,
    source,
    type,
    status,
    at,
    activities,
    statusHint,
    waitingFor,
    tokens,
  };
}
