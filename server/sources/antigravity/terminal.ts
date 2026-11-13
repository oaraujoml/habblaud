import type { TerminalEntry, TerminalInputKind } from '../../../shared/types';
import { maskSecrets, truncate } from '../../../shared/activity';
import { INPUT_MAX, RESULT_MAX, RESULT_MAX_LINES, TEXT_MAX, THINKING_MAX, type TerminalParser } from '../terminal';

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

function formatResult(text: string): { text: string; truncated?: boolean } {
  let truncated = false;
  let out = text;
  const lines = out.split('\n');
  if (lines.length > RESULT_MAX_LINES) {
    out = lines.slice(0, RESULT_MAX_LINES).join('\n');
    truncated = true;
  }
  if (out.length > RESULT_MAX) {
    out = out.slice(0, RESULT_MAX);
    truncated = true;
  }
  return { text: maskSecrets(out), ...(truncated ? { truncated: true } : {}) };
}

export class AntigravityTerminalParser implements TerminalParser {
  private lastToolUseId?: string;
  private readonly seen = new Set<string>();

  push(line: string): TerminalEntry[] {
    if (!line.trim()) return [];
    let j: Rec;
    try {
      j = JSON.parse(line) as Rec;
    } catch {
      return [];
    }
    if (!j || typeof j !== 'object') return [];

    const stepIndex = num(j.step_index) ?? 0;
    const source = str(j.source) ?? 'UNKNOWN';
    const type = str(j.type) ?? 'GENERIC';
    const status = str(j.status) ?? 'DONE';
    const at = toMs(j.created_at);
    const out: TerminalEntry[] = [];

    // USER_INPUT
    if (type === 'USER_INPUT') {
      const rawContent = str(j.content) ?? '';
      const clean = rawContent.replace(/<USER_REQUEST>([\s\S]*?)<\/USER_REQUEST>/, '$1').trim();
      const id = `agy-${stepIndex}-user`;
      if (clean && !this.seen.has(id)) {
        this.seen.add(id);
        out.push({
          kind: 'user',
          id,
          at,
          text: truncate(maskSecrets(clean), TEXT_MAX),
        });
      }
    }

    // PLANNER_RESPONSE
    if (type === 'PLANNER_RESPONSE') {
      const thinking = str(j.thinking);
      const thinkId = `agy-${stepIndex}-thinking`;
      if (thinking && !this.seen.has(thinkId)) {
        this.seen.add(thinkId);
        out.push({
          kind: 'thinking',
          id: thinkId,
          at,
          text: truncate(maskSecrets(thinking), THINKING_MAX),
        });
      }

      const toolCalls = Array.isArray(j.tool_calls) ? j.tool_calls : [];
      for (let idx = 0; idx < toolCalls.length; idx++) {
        const tc = toolCalls[idx] as Rec;
        if (!tc || typeof tc !== 'object') continue;
        const name = str(tc.name) ?? 'tool';
        const toolUseId = `agy-${stepIndex}-tool-${idx}`;
        this.lastToolUseId = toolUseId;

        if (!this.seen.has(toolUseId)) {
          this.seen.add(toolUseId);
          let inputStr: string | undefined;
          let inputKind: TerminalInputKind | undefined;

          if (tc.args && typeof tc.args === 'object') {
            const args = tc.args as Rec;
            if (name === 'run_command' && args.CommandLine) {
              inputStr = str(args.CommandLine);
            } else if (name === 'read_file' || name === 'write_file' || name === 'edit_file') {
              inputStr = str(args.Path);
            } else if (name === 'search_web') {
              inputStr = str(args.query);
            } else {
              inputStr = JSON.stringify(args, null, 2);
              inputKind = 'json';
            }
          }

          out.push({
            kind: 'tool',
            id: toolUseId,
            at,
            tool: name,
            title: `${name}(${truncate(inputStr ?? '', 60)})`,
            input: inputStr ? truncate(maskSecrets(inputStr), INPUT_MAX) : undefined,
            ...(inputKind ? { inputKind } : {}),
          });
        }
      }

      const content = str(j.content);
      const asstId = `agy-${stepIndex}-asst`;
      if (content && !this.seen.has(asstId)) {
        this.seen.add(asstId);
        out.push({
          kind: 'assistant',
          id: asstId,
          at,
          text: truncate(maskSecrets(content), TEXT_MAX),
        });
      }
    }

    // GENERIC (tool result output)
    if (type === 'GENERIC') {
      const content = str(j.content);
      const resId = `agy-${stepIndex}-result`;
      if (content && !this.seen.has(resId)) {
        this.seen.add(resId);
        const { text, truncated: isTrunc } = formatResult(content);
        out.push({
          kind: 'result',
          id: resId,
          at,
          toolUseId: this.lastToolUseId ?? `agy-${Math.max(0, stepIndex - 1)}-tool-0`,
          text,
          error: status === 'ERROR',
          ...(isTrunc ? { truncated: true } : {}),
        });
      }
    }

    return out;
  }
}

export function createAntigravityTerminalParser(): TerminalParser {
  return new AntigravityTerminalParser();
}
