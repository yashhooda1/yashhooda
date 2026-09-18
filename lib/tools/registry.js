// lib/tools/registry.js
// MCP-shaped tool registry for the site agent.
//   listTools()           → MCP tool descriptors { name, description, inputSchema, write }
//   callTool(name, args)  → MCP result { content: [{ type: 'text', text }], isError? }
//
// Two tool sources:
//   1. Local tools (lib/tools/*.js) — run in-process, no extra hosting.
//   2. Remote MCP servers (Streamable HTTP, JSON-RPC) listed in env MCP_SERVERS, e.g.
//        MCP_SERVERS='[{"name":"garmin","url":"https://…/mcp","token":"…","write":["schedule_workout"]}]'
//      This is how mcp-garmin / PaceForge plug in later without touching the loop.
// Tools flagged write:true are only exposed when the caller is admin AND passes confirm:true.

import { stravaTools } from './strava.js';

const LOCAL = [...stravaTools];

function remoteServers() {
  try { return JSON.parse(process.env.MCP_SERVERS || '[]'); } catch { return []; }
}

async function rpc(server, method, params, id = 1) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 12000);
  try {
    const r = await fetch(server.url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'application/json, text/event-stream',
        ...(server.token ? { Authorization: `Bearer ${server.token}` } : {}),
      },
      body: JSON.stringify({ jsonrpc: '2.0', id, method, params }),
      signal: ctrl.signal,
    });
    const text = await r.text();
    // Streamable HTTP may answer as SSE; take the last data: line.
    const line = text.trim().split('\n').filter(l => l.startsWith('data:')).pop();
    const j = JSON.parse(line ? line.slice(5) : text);
    if (j.error) throw new Error(j.error.message || 'mcp_error');
    return j.result;
  } finally { clearTimeout(t); }
}

export async function listTools({ includeWrite = false } = {}) {
  const tools = LOCAL.map(t => ({ name: t.name, description: t.description, inputSchema: t.inputSchema, write: !!t.write, source: 'local' }));
  await Promise.all(remoteServers().map(async s => {
    try {
      const res = await rpc(s, 'tools/list', {});
      for (const t of res.tools || []) {
        tools.push({
          name: `${s.name}__${t.name}`,
          description: `[${s.name}] ${t.description || ''}`,
          inputSchema: t.inputSchema || { type: 'object', properties: {} },
          write: (s.write || []).includes(t.name),
          source: s.name,
        });
      }
    } catch (e) {
      console.warn(`[MCP] ${s.name} unreachable: ${e.message}`); // graceful degradation: skip the server
    }
  }));
  return includeWrite ? tools : tools.filter(t => !t.write);
}

export async function callTool(name, args = {}) {
  try {
    const local = LOCAL.find(t => t.name === name);
    let data;
    if (local) {
      data = await local.handler(args || {});
    } else {
      const [srvName, ...rest] = name.split('__');
      const server = remoteServers().find(s => s.name === srvName);
      if (!server) throw new Error(`unknown tool ${name}`);
      const res = await rpc(server, 'tools/call', { name: rest.join('__'), arguments: args || {} });
      return res; // already MCP-shaped
    }
    return { content: [{ type: 'text', text: JSON.stringify(data) }] };
  } catch (e) {
    return { content: [{ type: 'text', text: `Tool error: ${e.message}` }], isError: true };
  }
}
