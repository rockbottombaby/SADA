// SADA MCP server (stdio). Same tools as the browser app, same Parquet data URL.
// Run:  OAM_DATA_URL=http://127.0.0.1:8790 npx tsx server.ts
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { TOOLS as DATA_TOOLS } from '../web/src/lib/tools.ts';
import { SOURCE_TOOLS } from '../web/src/lib/sources.ts';
import { PLAYBOOKS } from '../web/src/lib/playbooks.ts';
const TOOLS = [...PLAYBOOKS, ...DATA_TOOLS, ...SOURCE_TOOLS];
const toolByName = (n: string) => TOOLS.find(t => t.name === n);
import { makeCtx } from './ctx.ts';

const ctxP = makeCtx();
const server = new Server({ name: 'sada', version: '0.1.0' }, { capabilities: { tools: {} } });

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: TOOLS.map(t => ({ name: t.name, description: t.description, inputSchema: t.input_schema })),
}));

server.setRequestHandler(CallToolRequestSchema, async req => {
  const t = toolByName(req.params.name);
  if (!t) return { isError: true, content: [{ type: 'text', text: `unknown tool ${req.params.name}` }] };
  try {
    const out = await t.run(await ctxP, req.params.arguments ?? {});
    return { content: [{ type: 'text', text: JSON.stringify(out, null, 1) }] };
  } catch (e) {
    return { isError: true, content: [{ type: 'text', text: String(e) }] };
  }
});

await server.connect(new StdioServerTransport());
