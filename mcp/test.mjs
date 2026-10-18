// Smoke test: talk to the MCP server over stdio like a client would.
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
const c = new Client({ name: 'test', version: '0' });
await c.connect(new StdioClientTransport({ command: 'npx', args: ['tsx', 'server.ts'] }));
const { tools } = await c.listTools();
console.log('tools:', tools.map(t => t.name).join(', '));
const r = await c.callTool({ name: 'flights_through_zone', arguments: { zone_id: 'fir:BIRD', callsign_prefix: 'LOY', limit: 10 } });
const rows = JSON.parse(r.content[0].text);
console.log('LOY flights through BIRD:', rows.map(x => `${x.callsigns} ${x.reg} ${x.from_code}->${x.to_code} ${x.evidence} ${x.zone_in_utc}`));
const o = await c.callTool({ name: 'zone_overview', arguments: { zone_id: 'sov:ISL', observed_only: true } });
console.log('Iceland sovereign overview totals:', JSON.parse(o.content[0].text).totals);
await c.close();
