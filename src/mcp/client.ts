import { spawn, ChildProcessWithoutNullStreams } from 'child_process';
import { ToolDefinition } from '../llm/tools';
import { log } from '../utils/logger';

/**
 * Minimal MCP (Model Context Protocol) stdio client — BETA/opt-in.
 * Connects to servers configured in `codeflare.mcpServers`, discovers their
 * tools, and exposes them to the agent as `mcp__<server>__<tool>`. Untested
 * against every server; failures are isolated and never crash activation.
 */

export interface McpServerConfig {
  command: string;
  args?: string[];
  env?: Record<string, string>;
}

interface RegisteredTool {
  server: string;
  originalName: string;
  definition: ToolDefinition;
}

class McpConnection {
  private proc?: ChildProcessWithoutNullStreams;
  private buffer = '';
  private nextId = 1;
  private pending = new Map<number, { resolve: (v: any) => void; reject: (e: any) => void }>();
  private dead = false;
  // Called once when the connection dies unexpectedly, so the module can drop it
  // from `connections` and remove its tools from the registry.
  private onClose?: () => void;

  constructor(public readonly name: string, private readonly config: McpServerConfig) {}

  get isDead(): boolean { return this.dead; }
  setOnClose(fn: () => void): void { this.onClose = fn; }

  async start(): Promise<void> {
    this.proc = spawn(this.config.command, this.config.args || [], {
      env: { ...process.env, ...(this.config.env || {}) },
      stdio: ['pipe', 'pipe', 'pipe'],
      shell: process.platform === 'win32',
    });

    this.proc.stdout.setEncoding('utf8');
    this.proc.stdout.on('data', (chunk: string) => this._onData(chunk));
    this.proc.stderr.setEncoding('utf8');
    this.proc.stderr.on('data', (d: string) => log(`[mcp:${this.name}] ${d.trim()}`));
    // A misspelled command (spawn ENOENT) or runtime crash arrives as an async
    // 'error' event, and a write to a dead server's pipe raises EPIPE on stdin —
    // both are uncaught (and would crash the extension host) without a listener.
    this.proc.on('error', (err: Error) => this._die(`process error: ${err.message}`));
    this.proc.stdin.on('error', () => { /* broken pipe — 'exit' handles teardown */ });
    this.proc.on('exit', code => this._die(`server exited (${code})`));

    // Handshake.
    await this._request('initialize', {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'CodeFlare', version: '1.0' },
    });
    this._notify('notifications/initialized');
  }

  private _onData(chunk: string): void {
    this.buffer += chunk;
    let idx: number;
    while ((idx = this.buffer.indexOf('\n')) !== -1) {
      const line = this.buffer.slice(0, idx).trim();
      this.buffer = this.buffer.slice(idx + 1);
      if (!line) { continue; }
      try {
        const msg = JSON.parse(line);
        if (typeof msg.id === 'number' && this.pending.has(msg.id)) {
          const { resolve, reject } = this.pending.get(msg.id)!;
          this.pending.delete(msg.id);
          if (msg.error) { reject(new Error(msg.error.message || 'MCP error')); }
          else { resolve(msg.result); }
        }
      } catch {
        // Ignore non-JSON lines (some servers log to stdout).
      }
    }
  }

  private _send(obj: any): void {
    // Fail fast instead of writing to a dead pipe and hanging until timeout.
    if (this.dead || !this.proc) { throw new Error(`MCP server "${this.name}" is not connected`); }
    this.proc.stdin.write(JSON.stringify(obj) + '\n');
  }

  private _notify(method: string, params?: any): void {
    try { this._send({ jsonrpc: '2.0', method, params }); } catch { /* dead — ignore */ }
  }

  /** Reject every pending request. */
  private _rejectPending(reason: string): void {
    for (const { reject } of this.pending.values()) { reject(new Error(reason)); }
    this.pending.clear();
  }

  /** Handle unexpected death: reject in-flight requests and deregister. Idempotent. */
  private _die(reason: string): void {
    if (this.dead) { return; }
    this.dead = true;
    log(`[mcp:${this.name}] ${reason}`);
    this._rejectPending(`MCP server "${this.name}" ${reason}`);
    try { this.onClose?.(); } catch { /* ignore */ }
  }

  private _request(method: string, params?: any, timeoutMs = 15000): Promise<any> {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`MCP ${method} timed out`));
      }, timeoutMs);
      this.pending.set(id, {
        resolve: v => { clearTimeout(timer); resolve(v); },
        reject: e => { clearTimeout(timer); reject(e); },
      });
      this._send({ jsonrpc: '2.0', id, method, params });
    });
  }

  async listTools(): Promise<{ name: string; description?: string; inputSchema?: any }[]> {
    const res = await this._request('tools/list');
    return res?.tools || [];
  }

  async callTool(name: string, args: any): Promise<string> {
    const res = await this._request('tools/call', { name, arguments: args }, 60000);
    const content = res?.content || [];
    const text = content
      .map((c: any) => (c.type === 'text' ? c.text : `[${c.type}]`))
      .join('\n');
    return text || '(no output)';
  }

  dispose(): void {
    const p = this.proc;
    this.dead = true;
    this._rejectPending(`MCP server "${this.name}" disposed`);
    if (!p) { return; }
    try {
      if (process.platform === 'win32' && p.pid) {
        // shell:true runs the real server as a grandchild of cmd.exe, so
        // p.kill() would only terminate the wrapper and orphan the server —
        // kill the whole tree by PID.
        spawn('taskkill', ['/pid', String(p.pid), '/T', '/F'], { stdio: 'ignore' })
          .on('error', () => { /* taskkill missing — best effort */ });
      } else {
        p.kill();
      }
    } catch { /* ignore */ }
    // Close our end of stdin so a surviving child at least gets EOF.
    try { p.stdin.end(); } catch { /* ignore */ }
  }
}

const connections: McpConnection[] = [];
const registry = new Map<string, RegisteredTool>(); // prefixed name -> tool

function sanitize(s: string): string {
  return s.replace(/[^a-zA-Z0-9_]/g, '_');
}

export async function initMcp(servers: Record<string, McpServerConfig> | undefined): Promise<void> {
  registry.clear();
  if (!servers || Object.keys(servers).length === 0) { return; }

  for (const [name, config] of Object.entries(servers)) {
    if (!config || !config.command) { continue; }
    const conn = new McpConnection(name, config);
    // Deregister on unexpected death: drop the connection and its tools so later
    // calls fail fast with "not connected" instead of hanging on a dead pipe.
    conn.setOnClose(() => {
      const i = connections.indexOf(conn);
      if (i >= 0) { connections.splice(i, 1); }
      for (const [k, v] of registry) { if (v.server === name) { registry.delete(k); } }
    });
    try {
      await conn.start();
      const tools = await conn.listTools();
      connections.push(conn);
      for (const t of tools) {
        const prefixed = `mcp__${sanitize(name)}__${sanitize(t.name)}`;
        registry.set(prefixed, {
          server: name,
          originalName: t.name,
          definition: {
            type: 'function',
            function: {
              name: prefixed,
              description: `[MCP:${name}] ${t.description || t.name}`,
              parameters: t.inputSchema || { type: 'object', properties: {} },
            },
          },
        });
      }
      log(`MCP server "${name}": ${tools.length} tool(s) registered`);
    } catch (err: any) {
      log(`MCP server "${name}" failed: ${err.message}`);
      conn.dispose();
    }
  }
}

export function getMcpToolDefinitions(): ToolDefinition[] {
  return [...registry.values()].map(r => r.definition);
}

export function isMcpTool(name: string): boolean {
  return registry.has(name);
}

export async function callMcpTool(name: string, rawArgs: string): Promise<string> {
  const entry = registry.get(name);
  if (!entry) { return `Unknown MCP tool: ${name}`; }
  let args: any = {};
  try { args = rawArgs ? JSON.parse(rawArgs) : {}; } catch { return `Invalid JSON arguments for ${name}`; }
  const conn = connections.find(c => c.name === entry.server);
  if (!conn || conn.isDead) { return `MCP server "${entry.server}" is not connected`; }
  try {
    return await conn.callTool(entry.originalName, args);
  } catch (err: any) {
    return `MCP tool ${name} failed: ${err.message}`;
  }
}

export function disposeMcp(): void {
  // Iterate a copy: dispose() may trigger deregistration that mutates `connections`.
  for (const c of [...connections]) { c.dispose(); }
  connections.length = 0;
  registry.clear();
}
