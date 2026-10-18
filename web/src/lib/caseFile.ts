// Case file: the investigation's memory for one chat. The assistant records findings, hypotheses, leads, open questions and
// records to request as it works; the user sees them in the chat, and a short summary travels with every message.
import type { ToolDef } from './tools';

export type CaseKind = 'finding' | 'hypothesis' | 'lead' | 'question' | 'records_request';
export interface CaseItem {
  id: number; kind: CaseKind; text: string;
  confidence?: 'verified' | 'supported' | 'hypothesis' | 'speculation';
  status: 'open' | 'supported' | 'refuted' | 'done';
  refs?: string;            // leg ids, registrations, URLs, Census queries behind the entry
  at: string;
}
export interface CaseFile { items: CaseItem[] }

export const KIND_LABEL: Record<CaseKind, string> = {
  finding: 'Findings', hypothesis: 'Hypotheses', lead: 'Leads', question: 'Open questions', records_request: 'Records to request',
};

export function caseSummary(c: CaseFile | undefined) {
  const items = c?.items ?? [];
  if (!items.length) return 'empty';
  const open = (k: CaseKind) => items.filter(i => i.kind === k && i.status === 'open').length;
  return `${items.length} entries (${open('hypothesis')} open hypotheses, ${open('lead')} open leads, ${open('question')} open questions, ` +
    `${items.filter(i => i.kind === 'records_request').length} records requests); call case_file list for details`;
}

export function caseTool(get: () => CaseFile, save: () => void): ToolDef {
  return {
    name: 'case_file',
    description: `The investigation's memory for this chat (shown to the user). action "add": record a finding, hypothesis, lead, open question or records_request (a record to ask an agency for), with confidence (verified | supported | hypothesis | speculation) and refs (leg ids, registrations, URLs). action "update": change status (open | supported | refuted | done) or text of an entry by id. action "list": read all entries. Record as you go; keep entries short and specific.`,
    input_schema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['add', 'update', 'list'] },
        kind: { type: 'string', enum: ['finding', 'hypothesis', 'lead', 'question', 'records_request'] },
        text: { type: 'string' },
        confidence: { type: 'string', enum: ['verified', 'supported', 'hypothesis', 'speculation'] },
        status: { type: 'string', enum: ['open', 'supported', 'refuted', 'done'] },
        refs: { type: 'string' },
        id: { type: 'integer' },
      },
      required: ['action'],
    },
    async run(_ctx, a) {
      const c = get();
      if (a.action === 'list') return { items: c.items };
      if (a.action === 'add') {
        if (!a.kind || !a.text) throw new Error('add needs kind and text');
        const item: CaseItem = { id: (c.items.at(-1)?.id ?? 0) + 1, kind: a.kind, text: String(a.text).slice(0, 600),
          confidence: a.confidence, status: a.status ?? (a.kind === 'finding' ? 'done' : 'open'), refs: a.refs, at: new Date().toISOString() };
        c.items.push(item); save();
        return { added: item.id };
      }
      if (a.action === 'update') {
        const it = c.items.find(i => i.id === Number(a.id));
        if (!it) throw new Error(`no case entry ${a.id}`);
        if (a.status) it.status = a.status;
        if (a.text) it.text = String(a.text).slice(0, 600);
        if (a.confidence) it.confidence = a.confidence;
        if (a.refs) it.refs = a.refs;
        save();
        return { updated: it.id, status: it.status };
      }
      throw new Error('action must be add, update or list');
    },
  };
}
