import * as vscode from 'vscode';
import { log } from '../utils/logger';
import { resolveInWorkspace } from '../llm/tools';

/**
 * Debug Adapter Protocol tools (BETA/spike). Lets the agent investigate a
 * runtime bug the way a person would in the debugger — set a breakpoint, run,
 * read the call stack and variables at the stop, step, evaluate — instead of
 * peppering the code with temporary logging. Built on the public vscode.debug
 * API + session.customRequest (raw DAP), with feature-detection so it degrades
 * gracefully on older VS Code and reports clearly when an adapter behaves
 * differently. It reuses the project's OWN launch configurations (launch.json)
 * rather than inventing a debug setup — same principle as stack detection.
 */

function folder(): vscode.WorkspaceFolder | undefined {
  return vscode.workspace.workspaceFolders?.[0];
}

// The debug session CodeFlare itself started. Tracking it means the debug tools
// keep acting on OUR session even when the user has another one focused, and we
// can tell "our program ended" from "there was never a session" — so the agent
// gets a definite result instead of silently retrying against the wrong session.
let owned: vscode.DebugSession | undefined;
let terminateHooked = false;
function hookTerminate(): void {
  if (terminateHooked) { return; }
  terminateHooked = true;
  vscode.debug.onDidTerminateDebugSession(s => { if (owned && s.id === owned.id) { owned = undefined; } });
}

/** The session the debug tools act on: the one we started if still live, else the focused one. */
function session(): vscode.DebugSession | undefined {
  return owned || vscode.debug.activeDebugSession;
}
function activeSession(): vscode.DebugSession | undefined {
  return vscode.debug.activeDebugSession;
}
// activeStackItem / onDidChangeActiveStackItem are newer (1.94+) — access via
// any so the build works against older @types/vscode, and feature-detect at runtime.
function currentStackItem(): any {
  return (vscode.debug as any).activeStackItem;
}

/** Wait for the debuggee to next STOP (breakpoint/step), terminate, or time out. */
function waitForStop(session: vscode.DebugSession, timeoutMs = 15000): Promise<'stopped' | 'terminated' | 'timeout'> {
  return new Promise(resolve => {
    let done = false;
    const disposables: vscode.Disposable[] = [];
    let timer: ReturnType<typeof setTimeout>;
    const finish = (r: 'stopped' | 'terminated' | 'timeout') => {
      if (done) { return; }
      done = true;
      disposables.forEach(d => { try { d.dispose(); } catch { /* */ } });
      clearTimeout(timer);
      resolve(r);
    };

    const onStack = (vscode.debug as any).onDidChangeActiveStackItem;
    if (typeof onStack === 'function') {
      disposables.push(onStack((item: any) => {
        if (item && item.session?.id === session.id) { finish('stopped'); }
      }));
      const cur = currentStackItem();
      if (cur && cur.session?.id === session.id) { finish('stopped'); }
    } else {
      // Fallback: poll stackTrace — succeeds only while stopped.
      const poll = setInterval(async () => {
        try {
          const th = await session.customRequest('threads');
          const threadId = th?.threads?.[0]?.id;
          if (threadId != null) {
            const st = await session.customRequest('stackTrace', { threadId, startFrame: 0, levels: 1 });
            if (st?.stackFrames?.length) { finish('stopped'); }
          }
        } catch { /* running / not stopped */ }
      }, 300);
      disposables.push({ dispose: () => clearInterval(poll) });
    }

    disposables.push(vscode.debug.onDidTerminateDebugSession(s => {
      if (s.id === session.id) { finish('terminated'); }
    }));
    timer = setTimeout(() => finish('timeout'), timeoutMs);
  });
}

async function currentThreadId(session: vscode.DebugSession): Promise<number | undefined> {
  const item = currentStackItem();
  if (item && item.session?.id === session.id && typeof item.threadId === 'number') { return item.threadId; }
  try {
    const th = await session.customRequest('threads');
    return th?.threads?.[0]?.id;
  } catch { return undefined; }
}

// ── tools ────────────────────────────────────────────────────────

export async function debugSetBreakpoint(relPath: string, line: number): Promise<string> {
  const uri = resolveInWorkspace(relPath);
  if ('error' in uri) { return uri.error; }
  const ln = Math.max(1, Math.floor(line) || 1);
  const bp = new vscode.SourceBreakpoint(
    new vscode.Location(uri, new vscode.Position(ln - 1, 0)), true);
  vscode.debug.addBreakpoints([bp]);
  log(`Debug: breakpoint at ${relPath}:${ln}`);
  return `Breakpoint set at ${relPath}:${ln}. Start debugging (debug_start) so it can be hit.`;
}

export async function debugClearBreakpoints(relPath?: string): Promise<string> {
  const all = vscode.debug.breakpoints;
  let target = all;
  if (relPath) {
    const uri = resolveInWorkspace(relPath);
    if ('error' in uri) { return uri.error; }
    const key = uri.toString();
    target = all.filter(b => b instanceof vscode.SourceBreakpoint && b.location.uri.toString() === key);
  }
  if (target.length === 0) { return relPath ? `No breakpoints in ${relPath}.` : 'No breakpoints set.'; }
  vscode.debug.removeBreakpoints(target);
  return `Cleared ${target.length} breakpoint(s)${relPath ? ` in ${relPath}` : ''}.`;
}

export async function debugStart(configName?: string): Promise<string> {
  const wf = folder();
  if (!wf) { return 'No workspace folder is open.'; }
  hookTerminate();

  // Don't stack sessions: if we already own a live one, point the agent at it
  // instead of launching another (which would make continue/step ambiguous).
  if (owned) {
    return `A debug session started by CodeFlare is already running. Use debug_continue / debug_step / ` +
      `debug_inspect on it, or debug_stop before starting a new one.`;
  }

  const launch = vscode.workspace.getConfiguration('launch', wf.uri);
  const configs = launch.get<any[]>('configurations') || [];
  let target: string | vscode.DebugConfiguration | undefined;
  if (configName) {
    const found = configs.find(c => c?.name === configName);
    target = found || configName;                    // fall back to the raw name
  } else if (configs.length > 0) {
    target = configs[0];
  } else {
    return 'No launch configuration found. Add a .vscode/launch.json (the debug setup the project ' +
      'itself uses), or pass a config name. CodeFlare does not invent a debug configuration.';
  }

  const ok = await vscode.debug.startDebugging(wf, target as any);
  if (!ok) {
    return `Failed to start debugging (${typeof target === 'string' ? target : target?.name || '?'}). ` +
      `Check the launch configuration.`;
  }
  const session = activeSession();
  if (!session) { return 'Debugging started but no active session was reported.'; }
  owned = session;                                   // track it for the other tools

  const outcome = await waitForStop(session, 20000);
  if (outcome === 'stopped') { return `Debugging started and stopped.\n${await debugInspect()}`; }
  if (outcome === 'terminated') {
    owned = undefined;
    return 'The program ran to completion without hitting a breakpoint (session ended). Either no breakpoint ' +
      'was set, or it could not bind (the line is not executable/reachable — e.g. a blank line, a comment, or ' +
      'code that never runs). Set a breakpoint on an executable statement that the run actually reaches, then debug_start again.';
  }
  return 'Debugging started; the program is still running (no breakpoint hit yet). If it is a server, trigger the code path, then call debug_inspect.';
}

export async function debugContinue(): Promise<string> {
  const s = session();
  if (!s) { return 'No active debug session. Use debug_start first.'; }
  const threadId = await currentThreadId(s);
  try { await s.customRequest('continue', { threadId }); }
  catch (e: any) { return `Continue failed: ${e.message}`; }
  const outcome = await waitForStop(s, 20000);
  if (outcome === 'stopped') { return await debugInspect(); }
  if (outcome === 'terminated') { return 'The program finished (debug session ended).'; }
  return 'Continued; still running (no further breakpoint hit yet).';
}

export async function debugStep(kind: string): Promise<string> {
  const s = session();
  if (!s) { return 'No active debug session. Use debug_start first.'; }
  const req = kind === 'into' ? 'stepIn' : kind === 'out' ? 'stepOut' : 'next';
  const threadId = await currentThreadId(s);
  try { await s.customRequest(req, { threadId }); }
  catch (e: any) { return `Step failed: ${e.message}`; }
  const outcome = await waitForStop(s, 15000);
  if (outcome === 'terminated') { return 'The program finished (debug session ended).'; }
  return await debugInspect();
}

export async function debugInspect(): Promise<string> {
  const s = session();
  if (!s) { return 'No active debug session.'; }
  const threadId = await currentThreadId(s);
  if (threadId == null) { return 'Not stopped (no current thread). Set a breakpoint and continue, or the program may still be running.'; }

  let frames: any[] = [];
  try {
    const st = await s.customRequest('stackTrace', { threadId, startFrame: 0, levels: 20 });
    frames = st?.stackFrames || [];
  } catch (e: any) {
    return `Could not read the call stack: ${e.message}. The program is probably running, not stopped.`;
  }
  if (frames.length === 0) { return 'No stack frames — the program is not stopped at a breakpoint.'; }

  const top = frames[0];
  const relOf = (p?: string) => p ? vscode.workspace.asRelativePath(p) : '?';
  const stackText = frames.map((f, i) =>
    `  #${i} ${f.name}${f.source?.path ? ` — ${relOf(f.source.path)}:${f.line}` : ''}`).join('\n');

  let varsText = '';
  try {
    const sc = await s.customRequest('scopes', { frameId: top.id });
    const lines: string[] = [];
    for (const scope of (sc?.scopes || []).slice(0, 3)) {
      if (scope.expensive) { continue; }
      const v = await s.customRequest('variables', { variablesReference: scope.variablesReference });
      const vars = (v?.variables || []).slice(0, 30)
        .map((x: any) => `    ${x.name} = ${String(x.value).replace(/\s+/g, ' ').slice(0, 140)}`);
      if (vars.length) { lines.push(`  [${scope.name}]\n${vars.join('\n')}`); }
    }
    varsText = lines.join('\n');
  } catch { /* variables optional */ }

  return `Stopped at ${relOf(top.source?.path)}:${top.line} (${top.name}).\n` +
    `Call stack:\n${stackText}` +
    (varsText ? `\nVariables (top frame):\n${varsText}` : '');
}

export async function debugEvaluate(expression: string): Promise<string> {
  const s = session();
  if (!s) { return 'No active debug session.'; }
  if (!expression.trim()) { return 'Empty expression.'; }
  const item = currentStackItem();
  const frameId = item && item.session?.id === s.id ? item.frameId : undefined;
  try {
    const r = await s.customRequest('evaluate', { expression, frameId, context: 'repl' });
    return `${expression} = ${String(r?.result ?? '(no result)').slice(0, 800)}`;
  } catch (e: any) {
    return `Evaluate failed: ${e.message}. The program must be stopped at a breakpoint to evaluate in a frame.`;
  }
}

export async function debugStop(): Promise<string> {
  const s = session();
  if (!s) { return 'No active debug session to stop.'; }
  try { await vscode.debug.stopDebugging(s); } catch (e: any) { return `Stop failed: ${e.message}`; }
  owned = undefined;
  return 'Debug session stopped.';
}
