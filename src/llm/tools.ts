import * as vscode from 'vscode';
import * as path from 'path';
import * as os from 'os';
import { exec, execFile } from 'child_process';
import { log } from '../utils/logger';
import { getConfig } from '../utils/config';
import { applyEdits, getPreviewProvider } from '../editor/editApplier';
import { findSymbol, documentSymbols, findReferences, findDefinition, renameSymbol } from '../editor/lsp';
import { parseUnifiedDiff, applyFilePatch } from '../editor/patch';
import { resolveActiveEditor } from '../editor/contextGatherer';
import { collectDiagnostics } from '../editor/diagnostics';
import { webFetch, webSearch, extractFromHtml, crawlSite, BROWSER_UA } from '../utils/web';
import { screenshotUrl, renderPageHtml } from '../utils/webshot';
import { getMcpToolDefinitions } from '../mcp/client';
import { ApiAuth, SaveError, SaveResult, discoverSpec, performApiRequest, renderDiscovery, resolveUrl } from '../utils/apiClient';
import { OpenApiDoc, describeOperation, findOperationPath, listEndpoints, renderEndpointList, specBaseUrl } from '../utils/apiSpec';
import { allServiceSecrets, describeApiServices, getApiService, hostAllowed, listApiServices, normalizeServiceName, pinHost, upsertApiService } from '../utils/apiServices';
import { addProbe, listProbes, readProbes, removeProbes } from '../editor/probes';
import { findRelated, invalidateRepoMap } from '../editor/repoMap';
import { recordPreMutation } from '../editor/checkpoint';
import { canPrompt, gateCommand, gateMutation, previewMutation } from '../engine/policyGate';
import { MISSION_TOOLS } from '../engine/missionTools';
import { policyMessage } from '../engine/policy';
import { labBenchmarkTool, labDiffTestTool, labProfileTool, labRunTool, labScalingTool } from '../engine/lab';
import { getStacks, stacksToolReport, invalidateStacks } from '../stacks/stacks';
import { rememberFact, forgetFact } from '../utils/projectMemory';
import { findExecutable, registerExecutable, trustedExecutables } from '../utils/executables';
import {
  debugSetBreakpoint, debugClearBreakpoints, debugStart, debugContinue,
  debugStep, debugInspect, debugEvaluate, debugStop,
} from '../editor/debug';

/**
 * Agentic file tools — let the model explore the current workspace folder
 * the way Claude does: list directories, read files, and search text.
 * Paths are sandboxed to the allowed roots: every workspace folder plus the
 * folder of the file the user currently has open (so a file opened from outside
 * the workspace stays reachable). See allowedRoots().
 */

export interface ToolDefinition {
  type: 'function';
  function: {
    name: string;
    description: string;
    parameters: object;
  };
}

// Skip these when listing/searching — noise and huge dirs.
const IGNORED = new Set([
  'node_modules', '.git', 'dist', 'out', 'build', '.vscode-test',
  '.next', '.cache', 'coverage', '__pycache__', '.venv', 'venv',
  '.codeflare-trash', '.codeflare',
]);

const MAX_READ_CHARS = 60000;
const MAX_LIST_ENTRIES = 200;
const MAX_SEARCH_FILES = 400;
const MAX_SEARCH_HITS = 60;

// Read-only exploration tools (always available in agent mode).
const READ_TOOLS: ToolDefinition[] = [
  {
    type: 'function',
    function: {
      name: 'list_files',
      description:
        'List files and subfolders inside a folder of the current workspace. ' +
        'Use "." for the workspace root. Directories are marked with a trailing "/".',
      parameters: {
        type: 'object',
        properties: {
          path: {
            type: 'string',
            description: 'Workspace-relative folder path (defaults to "."), or an ' +
              'absolute path inside the currently open file\'s folder.',
          },
        },
        required: [],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'read_file',
      description:
        'Read the contents of a file. Returns the text with 1-based line numbers ' +
        'so you can reference specific lines. Works on workspace files, on a file the ' +
        'user has open outside the workspace, and on program OUTPUT that lands in the OS ' +
        'temp dir or a configured artifact root (e.g. a game/app user-data dir) — pass an ' +
        'absolute path for those.',
      parameters: {
        type: 'object',
        properties: {
          path: {
            type: 'string',
            description: 'Workspace-relative path, or the absolute path of a file ' +
              'open outside the workspace.',
          },
          start_line: {
            type: 'number',
            description: 'Optional 1-based first line to read — use with end_line to read a ' +
              'RANGE of a large file instead of the (truncated) whole.',
          },
          end_line: {
            type: 'number',
            description: 'Optional 1-based last line to read (inclusive).',
          },
        },
        required: ['path'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'find_files',
      description:
        'Find files by NAME or glob pattern across the whole workspace (e.g. "**/*.gd", ' +
        '"player" or "config.json"). A bare name matches files containing it anywhere in ' +
        'the tree. Returns matching workspace-relative paths. Use this to LOCATE a file; ' +
        'use search_text to search file CONTENTS.',
      parameters: {
        type: 'object',
        properties: {
          pattern: {
            type: 'string',
            description: 'A glob ("**/*.ts", "src/**/*.css") or a (partial) file name ("player", "index.html").',
          },
        },
        required: ['pattern'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_diagnostics',
      description:
        'Read the CURRENT problems (errors/warnings) the language servers report — for one ' +
        'file, or workspace-wide when no path is given. Use it to check a file after editing ' +
        'it, or to see what is broken before you start.',
      parameters: {
        type: 'object',
        properties: {
          path: {
            type: 'string',
            description: 'Optional workspace-relative file path. Omit for a workspace-wide summary.',
          },
        },
        required: [],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'search_text',
      description:
        'Search the text of files across the workspace for a substring or ' +
        'regular expression. Returns matching files with line numbers and the ' +
        'matched line. Use this to locate where something is defined or used.',
      parameters: {
        type: 'object',
        properties: {
          query: {
            type: 'string',
            description: 'Substring or regular expression to search for.',
          },
          glob: {
            type: 'string',
            description:
              'Optional file glob to limit the search (e.g. "**/*.ts"). ' +
              'Defaults to all files.',
          },
        },
        required: ['query'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'project_stacks',
      description:
        'List the project stacks CodeFlare detected in this workspace (per ' +
        'directory/module) and the build/typecheck/lint/test/run commands each one ' +
        'uses — sourced from the project\'s OWN config (package.json scripts, a ' +
        'gradle/maven wrapper, pyproject, etc.), not invented. A repo can contain ' +
        'several stacks. Use this to find the RIGHT way to build, test or verify a ' +
        'given part before running commands, instead of guessing or installing tools.',
      parameters: { type: 'object', properties: {}, required: [] },
    },
  },
  {
    type: 'function',
    function: {
      name: 'find_related',
      description:
        'Find the code most relevant to a task or concept, RANKED by relevance ' +
        '(filename, symbol names, and content), returning each top file with its ' +
        'definitions and the best-matching snippet. Use this at the START of a change ' +
        'to see how this codebase already does something — an existing helper to reuse, ' +
        'the conventions to match — before writing new code. Prefer it over search_text ' +
        'when you want the most relevant files rather than every raw line hit.',
      parameters: {
        type: 'object',
        properties: {
          query: {
            type: 'string',
            description: 'What you are looking for, in words or symbol names ' +
              '(e.g. "how are HTTP requests retried", "user authentication", "parseConfig").',
          },
        },
        required: ['query'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'remember',
      description:
        'Save a DURABLE, PROVEN fact about this project to the persistent project ' +
        'memory in private workspace storage outside the repository (kept across conversations, never shared globally). Use it ONLY for ' +
        'lasting, high-confidence knowledge you had to discover: how the project is built ' +
        'or tested (exact command), its engine/framework/language version, a key ' +
        'architectural decision, or an explicit project rule. Do NOT save guesses, ' +
        'transient state, task progress, or anything already obvious from the files. ' +
        'Duplicates are ignored.',
      parameters: {
        type: 'object',
        properties: {
          fact: { type: 'string', description: 'The fact, stated concisely (one sentence).' },
          category: { type: 'string', description: 'Optional short tag, e.g. "build", "test", "framework", "architecture", "rule".' },
        },
        required: ['fact'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'forget',
      description:
        'Remove a fact from the persistent project memory when it has become wrong or ' +
        'outdated. Give a substring of the fact to remove.',
      parameters: {
        type: 'object',
        properties: {
          match: { type: 'string', description: 'A substring identifying the fact(s) to remove.' },
        },
        required: ['match'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'find_executable',
      description:
        'Locate an interpreter or build tool (e.g. "python", "java", "php", "godot", "blender", "dotnet") ' +
        'when it is NOT plainly on PATH — it may be a versioned local binary in the project or a ' +
        'parent folder. Searches PATH first, then the workspace root, then up the parent chain, ' +
        'and matches versioned names ("godot" finds "Godot_v4.7.1-stable_win64.exe"). On success it ' +
        'TRUSTS that binary (runs without a prompt) and REMEMBERS its path, so you can invoke it by ' +
        'full path and need not search again next time.',
      parameters: {
        type: 'object',
        properties: {
          name: { type: 'string', description: 'The tool/executable name to locate (without version or extension).' },
        },
        required: ['name'],
      },
    },
  },
];

// Semantic navigation via language servers (read-only, always available).
const LSP_TOOLS: ToolDefinition[] = [
  {
    type: 'function',
    function: {
      name: 'find_symbol',
      description:
        'Find where a symbol (function, class, variable, type) is defined across ' +
        'the workspace using the language server. Prefer this over search_text for ' +
        'locating definitions by name.',
      parameters: {
        type: 'object',
        properties: { query: { type: 'string', description: 'Symbol name to look up.' } },
        required: ['query'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'document_symbols',
      description: 'List the symbols (functions, classes, methods…) declared in a file, as an outline.',
      parameters: {
        type: 'object',
        properties: { path: { type: 'string', description: 'Workspace-relative file path.' } },
        required: ['path'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'find_references',
      description: 'Find all references to a symbol, given the file it appears in and its name.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'File where the symbol appears.' },
          symbol: { type: 'string', description: 'The symbol name.' },
        },
        required: ['path', 'symbol'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'find_definition',
      description: 'Jump to the definition of a symbol used in a file (given the file and symbol name).',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'File where the symbol is used.' },
          symbol: { type: 'string', description: 'The symbol name.' },
        },
        required: ['path', 'symbol'],
      },
    },
  },
];

// Web access (read-only; gated by codeflare.webAccess).
const WEB_TOOLS: ToolDefinition[] = [
  {
    type: 'function',
    function: {
      name: 'web_fetch',
      description: 'Fetch a URL and return its readable text content (HTML is stripped to text).',
      parameters: {
        type: 'object',
        properties: { url: { type: 'string', description: 'Absolute http(s) URL.' } },
        required: ['url'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'web_search',
      description: 'Search the web and return the top results (title, link, snippet). Use web_fetch to read a result.',
      parameters: {
        type: 'object',
        properties: { query: { type: 'string', description: 'Search query.' } },
        required: ['query'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'web_extract',
      description:
        'Crawl/harvest one page: return its links (URL + anchor text), images, emails and title. ' +
        'By default it does a fast fetch with a real browser User-Agent. Set render:true to load the ' +
        'page in a REAL headless browser (runs JavaScript) — use that for news/weather/SPA pages whose ' +
        'content is loaded by JS, or when a fetch is bot-blocked or the links look incomplete. Loop over ' +
        'the returned links to crawl further; use web_fetch to read a page as text.',
      parameters: {
        type: 'object',
        properties: {
          url: { type: 'string', description: 'Absolute http(s) URL of the page to harvest.' },
          render: { type: 'boolean', description: 'Run the page in a real browser (JS-rendered). Default false (fast fetch).' },
        },
        required: ['url'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'crawl_site',
      description:
        'Crawl a SITE from a starting URL: follow links breadth-first, skipping pages already visited ' +
        '(loop detection), and return the pages visited plus all discovered links and emails. Stays on ' +
        'the same domain by default and stops at max_pages (default 8) — raise max_pages when the user ' +
        'asks to go deeper/wider. Set render:true for JS-heavy sites (slower: a real browser per page). ' +
        'For a SINGLE page use web_extract; to read one page as text use web_fetch.',
      parameters: {
        type: 'object',
        properties: {
          url: { type: 'string', description: 'Absolute http(s) URL to start from.' },
          max_pages: { type: 'number', description: 'Max pages to fetch (default 8, hard cap 40).' },
          same_domain: { type: 'boolean', description: 'Only follow links on the start URL\'s domain. Default true.' },
          render: { type: 'boolean', description: 'Render each page in a real browser (JS). Default false (fast fetch).' },
        },
        required: ['url'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'screenshot_url',
      description:
        'Capture a PNG screenshot of an EXTERNAL web page by URL, using a real headless browser ' +
        '(Edge/Chrome/Chromium) with a NORMAL browser User-Agent — so bot-protected sites are far less ' +
        'likely to serve a "denied"/challenge page than a plain Playwright/HeadlessChrome capture. Saves ' +
        'to a workspace path (default "screenshot.png"). Use this for "make an image of website X", then ' +
        'verify_visual it. For a LOCAL page you are serving yourself, "npx playwright screenshot" also works.',
      parameters: {
        type: 'object',
        properties: {
          url: { type: 'string', description: 'Absolute http(s) URL of the page to capture.' },
          path: { type: 'string', description: 'Workspace path for the .png (default "screenshot.png").' },
        },
        required: ['url'],
      },
    },
  },
];

// External web APIs by service name — the key is stored encrypted (utils/apiServices)
// and injected by api_request; the model only ever handles the service NAME.
const API_TOOLS: ToolDefinition[] = [
  {
    type: 'function',
    function: {
      name: 'api_services',
      description: 'List the external API services that have a stored key (name, base URL, auth scheme, whether the spec was discovered). Keys are never shown.',
      parameters: { type: 'object', properties: {} },
    },
  },
  {
    type: 'function',
    function: {
      name: 'api_store_key',
      description:
        'Store an API key the user gave you for an EXTERNAL web service, encrypted, under a short service ' +
        'name (e.g. "pixellab"). Do this ONCE when the user hands you a key; afterwards call the service by ' +
        'name with api_request — never paste the key into files, commands or replies. Pass base_url (the API ' +
        'root, e.g. https://api.example.com/v2) if the user told you; api_discover fills it in otherwise.',
      parameters: {
        type: 'object',
        properties: {
          service: { type: 'string', description: 'Short service name: letters, digits, "-", "_" (e.g. "pixellab").' },
          key: { type: 'string', description: 'The API key / token exactly as the user gave it.' },
          base_url: { type: 'string', description: 'Absolute API base URL if known (optional).' },
          auth: { type: 'string', enum: ['bearer', 'header', 'query', 'basic'], description: 'How the key is sent. Default bearer (Authorization: Bearer <key>); api_discover corrects it from the spec.' },
          auth_name: { type: 'string', description: 'Header or query-parameter name for auth "header"/"query" (e.g. "X-API-Key").' },
          note: { type: 'string', description: 'Optional short note (plan, limits, purpose).' },
        },
        required: ['service', 'key'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'api_discover',
      description:
        'Find and read the OpenAPI/Swagger spec of a web API and return a compact endpoint index. Probes the ' +
        'usual spec locations (…/openapi.json, /v1, /v2, api.<domain>, links in llms.txt / the docs page) ' +
        'starting from the service\'s known base URL or from url (its website, docs page, API base, or the ' +
        'spec itself); caches the spec; records base URL + auth scheme on the service. Pass filter:"keyword" ' +
        'to narrow a large index (repeat calls on a discovered service are instant). If nothing is found, ' +
        'web_search "<service> API documentation" and pass the URL you find.',
      parameters: {
        type: 'object',
        properties: {
          service: { type: 'string', description: 'Service name (from api_store_key). Optional for a public API.' },
          url: { type: 'string', description: 'Website / docs page / API base / spec URL to start from (optional when the service already has one).' },
          filter: { type: 'string', description: 'Keyword(s) to narrow the endpoint index, e.g. "animation".' },
          refresh: { type: 'boolean', description: 'Re-download the spec even if cached.' },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'api_describe',
      description:
        'The exact contract of ONE operation from a discovered spec: description, path/query parameters, ' +
        'request-body fields (type, REQUIRED, enum values, defaults) and the response shape. Always call ' +
        'this before the first api_request to an operation — never guess field names or enum values.',
      parameters: {
        type: 'object',
        properties: {
          service: { type: 'string', description: 'Service name whose spec was discovered.' },
          spec_url: { type: 'string', description: 'Alternative to service: the spec URL api_discover reported.' },
          method: { type: 'string', description: 'HTTP method (GET, POST, …).' },
          path: { type: 'string', description: 'Operation path as listed by api_discover, e.g. "/animate-with-text".' },
        },
        required: ['method', 'path'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'api_request',
      description:
        'Call a web API. With service:"name" the stored key is injected (only for that service\'s own host) and ' +
        'url may be a path relative to its base URL (e.g. "/balance"). Without service it is a plain ' +
        'unauthenticated request. body is sent as JSON; inside it {"$file":"path.png"} becomes the base64 of ' +
        'that workspace file and {"$dataUrl":"path.png"} a data: URI. Binary responses (image/zip/…) are ' +
        'written to save_to; base64 images inside a JSON response are written to save_images_dir (one file per ' +
        'image, format auto-detected) and replaced by their path in the returned JSON. For asynchronous jobs, ' +
        'GET the status endpoint with poll:{status_field, done_values, interval_ms, max_wait_ms} to wait in ' +
        'ONE call. Long strings in responses are summarized; the JSON is truncated at max_chars.',
      parameters: {
        type: 'object',
        properties: {
          service: { type: 'string', description: 'Service name whose key to use (optional).' },
          method: { type: 'string', description: 'GET, POST, PUT, PATCH, DELETE. Default: POST when body is given, else GET.' },
          url: { type: 'string', description: 'Absolute https URL, or a path relative to the service base URL.' },
          query: { type: 'object', description: 'Query-string parameters.' },
          headers: { type: 'object', description: 'Extra request headers (Authorization is managed for you).' },
          body: { description: 'JSON body (object/array), or a raw string.' },
          save_to: { type: 'string', description: 'Workspace path for a binary response or for the single image in a JSON response (extension added automatically).' },
          save_images_dir: { type: 'string', description: 'Workspace folder to write every base64 image found in the JSON response.' },
          save_images_prefix: { type: 'string', description: 'File-name stem for saved images (default: derived from the JSON field).' },
          poll: {
            type: 'object',
            description: 'GET only: repeat until the status field reaches a terminal value.',
            properties: {
              status_field: { type: 'string', description: 'JSON path of the status (default "status").' },
              done_values: { type: 'array', items: { type: 'string' }, description: 'Terminal values (default completed/done/succeeded/failed/error/…).' },
              interval_ms: { type: 'number', description: 'Wait between polls (default 3000).' },
              max_wait_ms: { type: 'number', description: 'Give up after this long (default 120000, max 600000).' },
            },
          },
          timeout_ms: { type: 'number', description: 'Per-request timeout (default 60000, max 300000).' },
          max_chars: { type: 'number', description: 'Cap on returned JSON text (default 8000).' },
        },
        required: ['url'],
      },
    },
  },
];

// Delegation (gated; handled by the provider, which runs a nested agent loop).
const SUBAGENT_TOOLS: ToolDefinition[] = [
  {
    type: 'function',
    function: {
      name: 'run_subagent',
      description:
        'Delegate ONE self-contained sub-task to a fresh agent with coordinated file tools, search, ' +
        'web research, and its own scratch context. Run shell commands and tests yourself after integration. It returns a STRUCTURED ' +
        'result (status success/partial/failed, summary, changed files, tests, open issues). Use ' +
        'for a large, separable chunk of work to keep your own context focused.',
      parameters: {
        type: 'object',
        properties: { task: { type: 'string', description: 'A clear, self-contained task description.' } },
        required: ['task'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'run_subagents',
      description:
        'Delegate SEVERAL INDEPENDENT sub-tasks to a shared pool (settings cap 1–32 active), each in its own fresh ' +
        'agent. Returns a structured result per task (status, summary, changed files, tests, open ' +
        'issues). Use only for tasks that do NOT depend on each other and do NOT touch the same ' +
        'files — parallel edits to one file will conflict. For dependent steps, use run_subagent ' +
        'sequentially instead. Workers have coordinated file tools and web research. Run shell commands and tests yourself after integration. Excess tasks wait in the queue.',
      parameters: {
        type: 'object',
        properties: {
          tasks: {
            type: 'array',
            items: { type: 'string' },
            maxItems: 128,
            description: 'Independent, self-contained task descriptions (up to 128 queued; settings cap simultaneous agents).',
          },
        },
        required: ['tasks'],
      },
    },
  },
];

// Write tools (only offered when codeflare.agentEdit is enabled).
const WRITE_TOOLS: ToolDefinition[] = [
  {
    type: 'function',
    function: {
      name: 'create_file',
      description:
        'Create a NEW file in the workspace with the given contents. Parent folders ' +
        'are created automatically. This cannot overwrite an existing file of any ' +
        'size — to change an existing file, use edit_file with targeted changes.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Workspace-relative file path to create.' },
          content: { type: 'string', description: 'Full contents of the new file.' },
        },
        required: ['path', 'content'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'edit_file',
      description:
        'Edit an existing file by replacing an exact snippet with new text. ' +
        '"search" must match text currently in the file (whitespace-tolerant) and ' +
        'may span AT MOST 60 lines — search only the few lines that actually change; ' +
        'never paste the whole file. Use several edit_file calls for several changes. ' +
        'To append: search the last ~10 lines, replace with themselves + new content.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Workspace-relative path, or the absolute ' +
            'path of a file open outside the workspace.' },
          search: { type: 'string', description: 'Exact snippet to find in the file.' },
          replace: { type: 'string', description: 'Text to replace the snippet with.' },
        },
        required: ['path', 'search', 'replace'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'move_file',
      description:
        'Move or rename a file or folder within the workspace. Works for both ' +
        'files and directories. Parent folders of the destination are created ' +
        'automatically. Fails if the destination already exists.',
      parameters: {
        type: 'object',
        properties: {
          source: { type: 'string', description: 'Workspace-relative path to move (file or folder).' },
          destination: { type: 'string', description: 'New workspace-relative path.' },
        },
        required: ['source', 'destination'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'delete_file',
      description:
        'Delete a file or folder from the workspace. This is a SOFT delete — the ' +
        'target is moved into .codeflare-trash (recoverable) and captured in the ' +
        'turn checkpoint, so it can be restored. Use it to remove a file you created ' +
        'by mistake or that is no longer needed; do NOT use it to "clear" a file you ' +
        'meant to edit (use edit_file for that).',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Workspace-relative path of the file or folder to delete.' },
        },
        required: ['path'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'apply_patch',
      description:
        'Apply a unified diff (git-style) to one or more files — often more reliable ' +
        'than edit_file for multi-hunk or multi-file changes. Each hunk is located by ' +
        'its CONTEXT lines (whitespace-tolerant), so it applies even when line numbers ' +
        'are slightly off. Format: "--- a/path" and "+++ b/path" headers, then @@ hunks ' +
        'with context lines (leading space), removed lines (-) and added lines (+). Use ' +
        '"--- /dev/null" to create a new file and "+++ /dev/null" to delete one. Read ' +
        'the file first so your context matches. If a hunk cannot be located, that ' +
        'file is left untouched and you are told which hunk failed — re-read and retry.',
      parameters: {
        type: 'object',
        properties: {
          patch: { type: 'string', description: 'The unified diff text (may cover several files).' },
        },
        required: ['patch'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'rename_symbol',
      description:
        'Rename a symbol (function, class, variable, type) EVERYWHERE it is used, via ' +
        'the language server — the correct way to rename across files, unlike ' +
        'search/replace which also hits unrelated text and comments. Give a file where ' +
        'the symbol appears, its current name, and the new name. Undoable via the turn ' +
        'revert. If the language has no rename provider it tells you to use edit_file or ' +
        'apply_patch instead.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'A workspace file where the symbol appears.' },
          symbol: { type: 'string', description: 'The current symbol name.' },
          new_name: { type: 'string', description: 'The new name (a valid identifier).' },
        },
        required: ['path', 'symbol', 'new_name'],
      },
    },
  },
];

// Command-execution tool (only offered when codeflare.agentRunCommands is enabled).
const RUN_TOOLS: ToolDefinition[] = [
  {
    type: 'function',
    function: {
      name: 'run_command',
      description:
        'Run a shell command in the workspace root and get back its stdout, ' +
        'stderr and exit code. Use this to run tests, builds, linters or git — ' +
        'then read the output and fix problems. The user confirms before it runs. ' +
        'Commands are non-interactive; do not start long-running servers or watchers.',
      parameters: {
        type: 'object',
        properties: {
          command: { type: 'string', description: 'The shell command to run.' },
        },
        required: ['command'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'read_terminal_output',
      description:
        'Read the recent output of the persistent CodeFlare terminal — the one ' +
        'where servers/watchers you started keep running. Use this to check ' +
        'server logs, startup errors, or request traces after starting a server.',
      parameters: {
        type: 'object',
        properties: {
          lines: { type: 'number', description: 'How many recent lines to return (default 60, max 200).' },
        },
      },
    },
  },
];

// Runtime-measurement tools (offered when codeflare.agentProbes is enabled).
// A probe is a temporary one-line measurement written INTO the code; it reports
// to stdout and to .codeflare/probes.jsonl, and is stripped again afterwards.
const PROBE_TOOLS: ToolDefinition[] = [
  {
    type: 'function',
    function: {
      name: 'add_probe',
      description:
        'Insert a TEMPORARY one-line measurement (a "probe") next to a line of code, to find ' +
        'out something you cannot know by reading: what a value actually holds at runtime, ' +
        'how often a branch really runs, how long a loop takes between iterations. The probe ' +
        'prints to stdout AND appends to .codeflare/probes.jsonl, so it also reports from a ' +
        'server or game whose output you never see. Then RUN the code and call read_probes. ' +
        'Probes are debugging scaffolding, not a fix: remove_probes once you have the answer.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Workspace-relative path of the file to instrument.' },
          anchor: {
            type: 'string',
            description: 'ONE exact line from that file to attach the probe to. It must occur ' +
              'exactly once — pick a unique nearby line if it does not.',
          },
          position: {
            type: 'string',
            enum: ['before', 'after'],
            description: 'Put the probe before or after the anchor line (default "after").',
          },
          label: { type: 'string', description: 'Short name for what is being measured, e.g. "queue length after push".' },
          kind: {
            type: 'string',
            enum: ['value', 'hit', 'custom'],
            description: '"value": log an expression (needs "expression"). "hit": only count how ' +
              'often the line runs. "custom": you supply the snippet in "code" — use this for a ' +
              'language without a built-in emitter, or for a measurement the other kinds cannot express.',
          },
          expression: {
            type: 'string',
            description: 'For kind "value": the expression to evaluate, in the language of the file ' +
              'and valid in the scope of the anchor line (e.g. "len(queue)", "user.id", "time.time()-t0").',
          },
          code: {
            type: 'string',
            description: 'For kind "custom": the complete one-line snippet to insert. Print with the ' +
              'prefix [[CF-PROBE:<id>]] so read_probes picks it up from stdout.',
          },
        },
        required: ['path', 'anchor'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'read_probes',
      description:
        'Read back what the probes measured, aggregated per probe: hit count, timing between ' +
        'hits, and min/max/average or the distinct values seen. Call this AFTER running the ' +
        'instrumented code. A probe that was never hit is reported too — that means the line ' +
        'never executed, which is itself an answer.',
      parameters: {
        type: 'object',
        properties: {
          clear: {
            type: 'boolean',
            description: 'Empty the measurement file after reading, so the next run starts clean. ' +
              'Use this between two runs you want to compare.',
          },
        },
        required: [],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'list_probes',
      description: 'List the probes currently sitting in the code: id, file:line, and what each measures.',
      parameters: { type: 'object', properties: {}, required: [] },
    },
  },
  {
    type: 'function',
    function: {
      name: 'remove_probes',
      description:
        'Remove probes from the code again. Give "ids" for specific ones, "path" for every probe ' +
        'in one file, or nothing to remove them all. Always do this once you have your answer — ' +
        'never leave instrumentation behind in the user\'s code.',
      parameters: {
        type: 'object',
        properties: {
          ids: { type: 'array', items: { type: 'string' }, description: 'Probe ids to remove, e.g. ["p1","p3"].' },
          path: { type: 'string', description: 'Remove every probe in this file.' },
        },
        required: [],
      },
    },
  },
];

// Planning tool — always available in agent mode. Executed by the provider
// (it updates the UI), not by executeTool.
const PLAN_TOOLS: ToolDefinition[] = [
  {
    type: 'function',
    function: {
      name: 'update_todos',
      description:
        'Maintain a hierarchical checklist for a multi-step task. Call it first to lay ' +
        'out the plan (break big steps into "subtasks"), then call it again to update ' +
        'statuses as you progress. Work depth-first: mark a subtask in_progress, finish ' +
        'it, mark it completed, then the next; a parent is completed once its subtasks ' +
        'are. Keep one leaf in_progress at a time. Send the COMPLETE tree every time. ' +
        'Use this for non-trivial tasks; skip it for simple one-step requests.',
      parameters: {
        type: 'object',
        properties: {
          todos: {
            type: 'array',
            description: 'The full task tree (send it complete every time).',
            items: {
              type: 'object',
              properties: {
                content: { type: 'string', description: 'Short description of the step.' },
                status: { type: 'string', enum: ['pending', 'in_progress', 'completed'] },
                subtasks: {
                  type: 'array',
                  description: 'Optional child steps.',
                  items: {
                    type: 'object',
                    properties: {
                      content: { type: 'string' },
                      status: { type: 'string', enum: ['pending', 'in_progress', 'completed'] },
                      subtasks: {
                        type: 'array',
                        items: {
                          type: 'object',
                          properties: {
                            content: { type: 'string' },
                            status: { type: 'string', enum: ['pending', 'in_progress', 'completed'] },
                          },
                          required: ['content', 'status'],
                        },
                      },
                    },
                    required: ['content', 'status'],
                  },
                },
              },
              required: ['content', 'status'],
            },
          },
        },
        required: ['todos'],
      },
    },
  },
];

// Debugger tools (BETA; gated by codeflare.agentDebug, and follow the
// run-commands permission since debugging executes the program). Investigate a
// runtime bug in the real debugger instead of adding temporary logging.
const DEBUG_TOOLS: ToolDefinition[] = [
  {
    type: 'function',
    function: {
      name: 'debug_set_breakpoint',
      description: 'Set a breakpoint at a file line, so a debug run stops there to be inspected.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Workspace-relative file path.' },
          line: { type: 'number', description: '1-based line number.' },
        },
        required: ['path', 'line'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'debug_clear_breakpoints',
      description: 'Remove breakpoints — all of them, or only those in one file.',
      parameters: {
        type: 'object',
        properties: { path: { type: 'string', description: 'Optional file to clear (omit for all).' } },
        required: [],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'debug_start',
      description:
        'Start debugging using the project\'s OWN launch configuration (.vscode/launch.json). ' +
        'Set breakpoints first. Returns where it stopped (or that it ran to completion / is still ' +
        'running). CodeFlare does not invent a debug config — add one to the project if none exists.',
      parameters: {
        type: 'object',
        properties: { config: { type: 'string', description: 'Optional launch-config name (defaults to the first).' } },
        required: [],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'debug_inspect',
      description: 'At the current stop, show the call stack (file:line per frame) and the variables in the top frame. Use this to see what the program actually holds at a breakpoint.',
      parameters: { type: 'object', properties: {}, required: [] },
    },
  },
  {
    type: 'function',
    function: {
      name: 'debug_continue',
      description: 'Resume execution until the next breakpoint (or the program ends). Returns the new stop.',
      parameters: { type: 'object', properties: {}, required: [] },
    },
  },
  {
    type: 'function',
    function: {
      name: 'debug_step',
      description: 'Step one line: "over" (default), "into" a call, or "out" of the current function. Returns the new stop.',
      parameters: {
        type: 'object',
        properties: { kind: { type: 'string', enum: ['over', 'into', 'out'], description: 'Step kind (default "over").' } },
        required: [],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'debug_evaluate',
      description: 'Evaluate an expression in the current stopped frame (read a value, call a getter). The program must be stopped at a breakpoint.',
      parameters: {
        type: 'object',
        properties: { expression: { type: 'string', description: 'Expression in the debuggee\'s language.' } },
        required: ['expression'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'debug_stop',
      description: 'Stop the debug session.',
      parameters: { type: 'object', properties: {}, required: [] },
    },
  },
];

// Visual verification (gated by codeflare.visualVerify; needs a vision-capable
// endpoint). Handled by the provider (it makes the model call with the image).
const VISION_TOOLS: ToolDefinition[] = [
  {
    type: 'function',
    function: {
      name: 'verify_visual',
      description:
        'Check that a screenshot matches what was asked for — actually SEE the result ' +
        'instead of assuming. FIRST produce the image (a web page via Playwright, a plot ' +
        'via savefig, a game/app via its own screenshot-to-PNG), THEN call this with the ' +
        'image path and a description of the INTENDED result. Returns a verdict (OK, or ' +
        'MISMATCH with concrete visual differences) so you can fix it and re-check.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Workspace-relative (or open-file-absolute) path to the image/screenshot.' },
          expectation: { type: 'string', description: 'What the image should show (the intended result to check against).' },
        },
        required: ['path', 'expectation'],
      },
    },
  },
];

// ── Lab tools ────────────────────────────────────────────────────
// The isolated experiment workspace (.codeflare/lab/): scratch scripts,
// benchmarks, and old-vs-new differential tests. See src/engine/lab.ts.
const LAB_TOOLS: ToolDefinition[] = [
  {
    type: 'function',
    function: {
      name: 'lab_run',
      description:
        'Run a SCRATCH script in the isolated lab (.codeflare/lab/) instead of littering the ' +
        'project with temporary debugging files. The script runs with the WORKSPACE as working ' +
        'directory, so it can import/require the project\'s real modules. Use it to reproduce a ' +
        'bug, probe an idea, build a tiny dataset, or test a function in isolation. Output is ' +
        'returned; the script is auto-cleaned after a week.',
      parameters: {
        type: 'object',
        properties: {
          language: { type: 'string', enum: ['javascript', 'python', 'powershell'], description: 'Runtime (default javascript/node).' },
          code: { type: 'string', description: 'The complete script to run.' },
          name: { type: 'string', description: 'Short slug for the lab folder (e.g. "repro-parking-bug").' },
          timeout_ms: { type: 'number', description: 'Hard timeout, max 120000 (default 30000).' },
        },
        required: ['code'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'lab_benchmark',
      description:
        'MEASURE instead of guessing: benchmark a statement over many iterations in the lab and ' +
        'get mean/p50/p95/p99/max wall-clock timings. "setup" runs once (imports, test data — it ' +
        'can require() the project\'s real modules); "code" runs per iteration. To prove an ' +
        'optimization: benchmark the CURRENT code first (baseline), make the change, benchmark ' +
        'again, and compare. Never claim a speedup you did not measure.',
      parameters: {
        type: 'object',
        properties: {
          language: { type: 'string', enum: ['javascript', 'python', 'powershell'], description: 'Runtime (default javascript/node).' },
          setup: { type: 'string', description: 'Runs once before timing: imports, data, function definitions.' },
          code: { type: 'string', description: 'The statement to measure each iteration (may use names from setup).' },
          label: { type: 'string', description: 'Name shown in the report, e.g. "findNearestParkingSpace/before".' },
          iterations: { type: 'number', description: 'Timed iterations (default 1000).' },
          warmup: { type: 'number', description: 'Untimed warmup iterations (default iterations/10).' },
          timeout_ms: { type: 'number', description: 'Hard timeout, max 120000 (default 60000).' },
        },
        required: ['code'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'lab_diff_test',
      description:
        'Differential test: run an OLD and a NEW implementation of the same function against the ' +
        'same generated inputs and compare their outputs structurally. THE way to make a ' +
        'refactor or optimization safe: identical outputs on many varied inputs support ' +
        'equivalence; any mismatch is returned with its smallest failing input. old_code must ' +
        'define oldImpl (JS) / old_impl (Python), new_code newImpl/new_impl, and generator must ' +
        'define gen(i) returning the input for case i — make gen cover edge cases (empty, ' +
        'negative, huge, duplicates, unicode, …).',
      parameters: {
        type: 'object',
        properties: {
          language: { type: 'string', enum: ['javascript', 'python'], description: 'Runtime (default javascript/node).' },
          old_code: { type: 'string', description: 'Defines function oldImpl(input) — usually the CURRENT implementation (can require project modules).' },
          new_code: { type: 'string', description: 'Defines function newImpl(input) — the candidate implementation.' },
          generator: { type: 'string', description: 'Defines function gen(i) → input for case i. Vary size and shape with i; include edge cases.' },
          cases: { type: 'number', description: 'Number of cases (default 1000).' },
          timeout_ms: { type: 'number', description: 'Hard timeout, max 120000 (default 60000).' },
        },
        required: ['old_code', 'new_code', 'generator'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'lab_profile',
      description:
        'Find what ACTUALLY deserves optimization: run a representative workload under a real ' +
        'profiler (node --cpu-prof / Python cProfile) and get a ranked self-time report of the ' +
        'hottest functions. Optimize the top of that list — never code that merely looks slow. ' +
        'The workload script can require/import the project\'s real modules; make it run for at ' +
        'least ~1 second (loop the operation) or there will be no samples.',
      parameters: {
        type: 'object',
        properties: {
          language: { type: 'string', enum: ['javascript', 'python'], description: 'Runtime (default javascript/node).' },
          code: { type: 'string', description: 'Script exercising a representative workload (imports project modules, loops the operation).' },
          top: { type: 'number', description: 'How many hot paths to report (default 12).' },
          timeout_ms: { type: 'number', description: 'Hard timeout, max 120000 (default 60000).' },
        },
        required: ['code'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'lab_scaling',
      description:
        'Empirically test how execution time grows with input size: runs "code" (which must use ' +
        'the variable n) at several sizes and fits the OBSERVED scaling curve (constant / log n / ' +
        'n / n log n / n^2 / n^3). Reports a fit over measured points — evidence of scaling ' +
        'behaviour on this range, NOT proven Big-O. Use it to check "is this the quadratic loop ' +
        'the profiler pointed at?".',
      parameters: {
        type: 'object',
        properties: {
          language: { type: 'string', enum: ['javascript', 'python'], description: 'Runtime (default javascript/node).' },
          setup: { type: 'string', description: 'Runs once: imports, helpers, a make_input(n) builder.' },
          code: { type: 'string', description: 'Statement using n, e.g. "solve(make_input(n))".' },
          sizes: { type: 'array', items: { type: 'number' }, description: 'Input sizes (default [100,200,400,800,1600]).' },
          reps: { type: 'number', description: 'Repetitions per size, median taken (default 5).' },
          timeout_ms: { type: 'number', description: 'Hard timeout, max 120000 (default 90000).' },
        },
        required: ['code'],
      },
    },
  },
];

export interface ToolOptions {
  write: boolean;
  run: boolean;
  web: boolean;
  subagent: boolean;
  plan?: boolean;
  probes?: boolean;
  debug?: boolean;
  vision?: boolean;
}

// ── Tool registry ────────────────────────────────────────────────
// One neutral source of truth per tool: its schema (the literal above), the
// permission group it belongs to, how it runs, and how it's labelled. Every
// consumer derives from this — getToolDefinitions emits the OpenAI-function
// schema (the local/OpenAI adapter), client.ts converts those to Anthropic's
// tool schema (the Anthropic adapter), executeTool dispatches by handler, and
// the UI labels via describe. Adding a tool = add its schema literal to the
// right group array + one handler + one describe entry here; no switch to edit.

export type ToolGroup = 'read' | 'lsp' | 'plan' | 'write' | 'probe' | 'run' | 'web' | 'api' | 'subagent' | 'debug' | 'vision' | 'lab';

export interface ToolSpec {
  def: ToolDefinition;
  group: ToolGroup;
  // How the tool runs. Undefined = dispatched by the chat provider because it
  // needs loop/UI state (update_todos, run_subagent); those never reach executeTool.
  handler?: (args: any) => Promise<string> | string;
  describe: (args: any) => string;
  copyable?: (args: any) => string | undefined;
}

/** Harvest links/images/emails/title from a page (fast fetch, or JS-rendered browser). */
async function webExtractTool(url: string, render?: boolean): Promise<string> {
  const target = String(url || '').trim();
  if (!/^https?:\/\//i.test(target)) { return 'Provide an absolute http(s) URL to harvest.'; }

  let html = '';
  let finalUrl = target;
  if (render) {
    const r = await renderPageHtml(target);
    if (!r.ok) { return `Could not render ${target}: ${r.error}`; }
    html = r.html || '';
  } else {
    try {
      const resp = await fetch(target, { headers: { 'User-Agent': BROWSER_UA }, signal: AbortSignal.timeout(20000) });
      if (!resp.ok) {
        return `HTTP ${resp.status} fetching ${target}. If the page needs JavaScript or blocks bots, retry with render:true.`;
      }
      finalUrl = resp.url || target;
      html = await resp.text();
    } catch (err: any) { return `Could not fetch ${target}: ${err.message}. Try render:true.`; }
  }

  const { title, links, images, emails } = extractFromHtml(html, finalUrl);
  const MAX_LINKS = 80, MAX_IMAGES = 40;
  const out: string[] = [`URL: ${finalUrl}`];
  if (title) { out.push(`Title: ${title}`); }
  out.push('');
  out.push(`Links (${links.length}${links.length > MAX_LINKS ? `, first ${MAX_LINKS}` : ''}):`);
  for (const l of links.slice(0, MAX_LINKS)) { out.push(`- ${l.text || '(no text)'} — ${l.url}`); }
  if (images.length) {
    out.push('');
    out.push(`Images (${images.length}${images.length > MAX_IMAGES ? `, first ${MAX_IMAGES}` : ''}):`);
    for (const im of images.slice(0, MAX_IMAGES)) { out.push(`- ${im}`); }
  }
  if (emails.length) { out.push('', `Emails: ${emails.slice(0, 40).join(', ')}`); }
  if (!render && links.length === 0 && images.length === 0) {
    out.push('', '(No links/images found in the fetched HTML — the page is probably JS-rendered. Retry with render:true.)');
  } else if (!render) {
    out.push('', '(Fetched without running JavaScript. If data looks incomplete, retry with render:true.)');
  }
  return out.join('\n');
}

/** Fetch or JS-render one page and return its HTML — the crawl's per-page loader. */
function makePageLoader(render: boolean): (u: string) => Promise<{ html: string; finalUrl: string }> {
  return render
    ? async (u: string) => {
        const r = await renderPageHtml(u);
        if (!r.ok) { throw new Error(r.error || 'render failed'); }
        return { html: r.html || '', finalUrl: u };
      }
    : async (u: string) => {
        const resp = await fetch(u, { headers: { 'User-Agent': BROWSER_UA }, signal: AbortSignal.timeout(20000) });
        if (!resp.ok) { throw new Error(`HTTP ${resp.status}`); }
        return { html: await resp.text(), finalUrl: resp.url || u };
      };
}

/** Breadth-first crawl a site: loop-detected, page-capped, links/emails harvested. */
async function crawlSiteTool(url: string, maxPages?: number, sameDomain?: boolean, render?: boolean): Promise<string> {
  const start = String(url || '').trim();
  if (!/^https?:\/\//i.test(start)) { return 'Provide an absolute http(s) URL to crawl.'; }
  const limit = Number.isFinite(maxPages) ? Math.max(1, Math.min(Number(maxPages), 40)) : 8;
  const onDomain = sameDomain !== false;
  const res = await crawlSite(start, makePageLoader(!!render), { maxPages: limit, sameDomain: onDomain });

  const out: string[] = [
    `Crawled ${res.pages.length} page(s) from ${start} (limit ${limit}, ` +
      `${onDomain ? 'same-domain' : 'any-domain'}, ${render ? 'rendered' : 'fetch'}):`,
    '',
    'Pages visited:',
  ];
  res.pages.forEach((p, i) => {
    out.push(`  ${i + 1}. ${p.url}${p.ok ? (p.title ? ` — ${p.title}` : '') : ` — [skipped: ${p.note}]`}`);
  });

  const MAX_LINKS = 150;
  out.push('', `Links found (deduped, ${res.links.length}${res.links.length > MAX_LINKS ? `; first ${MAX_LINKS}` : ''}):`);
  for (const l of res.links.slice(0, MAX_LINKS)) { out.push(`  - ${l}`); }
  if (res.emails.length) { out.push('', `Emails (${res.emails.length}): ${res.emails.slice(0, 50).join(', ')}`); }

  out.push('', res.stoppedReason === 'limit'
    ? `Stopped at the page limit (${limit}). Raise max_pages to crawl deeper.`
    : res.stoppedReason === 'time'
    ? 'Stopped after the time budget — the crawl was getting long; narrow the start URL or lower max_pages.'
    : 'Followed every reachable link within scope (no more new pages).');
  return out.join('\n');
}

/** Capture an external URL to a workspace PNG via a real headless browser. */
async function screenshotUrlTool(url: string, relPath?: string): Promise<string> {
  const target = String(url || '').trim();
  if (!/^https?:\/\//i.test(target)) { return 'Provide an absolute http(s) URL to screenshot.'; }
  const rel = ((relPath && String(relPath).trim()) || 'screenshot.png').replace(/\\/g, '/');
  if (!/\.png$/i.test(rel)) { return 'The screenshot path must end in .png.'; }
  const uri = resolveInWorkspace(rel);
  if ('error' in uri) { return uri.error; }
  // A screenshot overwrite is a workspace mutation like any other write —
  // checkpoint it so the turn revert can restore a clobbered file.
  await recordPreMutation(rel);
  const res = await screenshotUrl(target, uri.fsPath);
  if (!res.ok) { return `Could not screenshot ${target}: ${res.error}`; }
  const via = res.browser ? path.basename(res.browser) : 'browser';
  return `Saved screenshot to "${rel}" (${res.bytes} bytes, via ${via}). If it shows an "access ` +
    `denied"/challenge page, the site blocked automated access. Call verify_visual("${rel}", ` +
    `"<what the page should show>") to check it.`;
}


// ── External API tools (utils/apiClient + utils/apiServices) ────────
// Specs are cached in memory and under .codeflare/api-specs/ so api_describe
// still works after a window reload without re-downloading a 400 KB document.
const specCache = new Map<string, { specUrl: string; spec: OpenApiDoc }>();

function specCacheUri(name: string): vscode.Uri | undefined {
  const root = workspaceRoot();
  if (!root) { return undefined; }
  const safe = name.replace(/[^A-Za-z0-9._-]+/g, '_').slice(0, 80);
  return vscode.Uri.joinPath(root, '.codeflare', 'api-specs', `${safe}.json`);
}

async function loadCachedSpec(name: string): Promise<{ specUrl: string; spec: OpenApiDoc } | undefined> {
  const hit = specCache.get(name);
  if (hit) { return hit; }
  const uri = specCacheUri(name);
  if (!uri) { return undefined; }
  try {
    const raw = JSON.parse(new TextDecoder().decode(await vscode.workspace.fs.readFile(uri)));
    if (raw && typeof raw.specUrl === 'string' && raw.spec && raw.spec.paths) {
      const entry = { specUrl: raw.specUrl, spec: raw.spec as OpenApiDoc };
      specCache.set(name, entry);
      return entry;
    }
  } catch { /* no cache */ }
  return undefined;
}

async function storeCachedSpec(name: string, entry: { specUrl: string; spec: OpenApiDoc }): Promise<void> {
  specCache.set(name, entry);
  const uri = specCacheUri(name);
  if (!uri) { return; }
  try {
    const dir = vscode.Uri.joinPath(uri, '..');
    await vscode.workspace.fs.createDirectory(dir);
    const ignore = vscode.Uri.joinPath(dir, '..', '.gitignore');
    try { await vscode.workspace.fs.stat(ignore); } catch { await vscode.workspace.fs.writeFile(ignore, Buffer.from('*\n')); }
    await vscode.workspace.fs.writeFile(uri, Buffer.from(JSON.stringify(entry)));
  } catch (err: any) { log(`api spec cache write failed: ${err.message}`); }
}

// A verification-only turn (Prove It / Break My Solution) write-locks the
// workspace; api_request may still READ APIs but must not save files then.
let toolWriteLocked = false;
export function setToolWriteLock(locked: boolean): void { toolWriteLocked = locked; }

/** Write bytes a tool received to the workspace: same policy gate + checkpoint as create_file. */
async function saveWorkspaceBytes(relPath: string, bytes: Uint8Array): Promise<SaveResult | SaveError> {
  if (toolWriteLocked) { return { ok: false, error: "This is a verification-only turn (write-locked) — the response was not saved." }; }
  if (!getConfig().agentEdit) { return { ok: false, error: 'File editing is disabled (codeflare.agentEdit is off) — cannot save the response.' }; }
  const rel = relPath.replace(/\\/g, '/').replace(/^\.\//, '');
  const uri = resolveInWorkspace(rel);
  if ('error' in uri) { return { ok: false, error: uri.error }; }
  let isNew = true;
  try { await vscode.workspace.fs.stat(uri); isNew = false; } catch { /* new file */ }
  const verdict = gateMutation(rel, { isNew, addedLines: 0 });
  if (!verdict.allowed) { return { ok: false, error: policyMessage(verdict) }; }
  await recordPreMutation(rel);
  try {
    await vscode.workspace.fs.createDirectory(vscode.Uri.joinPath(uri, '..'));
    await vscode.workspace.fs.writeFile(uri, bytes);
  } catch (err: any) { return { ok: false, error: `Could not write "${rel}": ${err.message}` }; }
  return { ok: true, rel, bytes: bytes.length };
}

async function readWorkspaceBytes(relPath: string): Promise<Uint8Array | { error: string }> {
  const uri = resolveForRead(relPath);
  if ('error' in uri) { return uri; }
  try { return await vscode.workspace.fs.readFile(uri); } catch (err: any) { return { error: err.message }; }
}

function apiServicesTool(): string {
  const d = describeApiServices();
  return d
    ? `Configured external API services:\n${d}\n(Keys are stored encrypted and injected automatically by api_request.)`
    : 'No external API services configured. When the user gives you an API key, store it with api_store_key(service, key).';
}

async function apiStoreKeyTool(a: any): Promise<string> {
  const name = normalizeServiceName(String(a.service ?? ''));
  const key = String(a.key ?? '').trim();
  if (!name) { return 'Provide a short service name, e.g. "pixellab".'; }
  if (!key) { return 'Provide the key value.'; }
  const auth = ['bearer', 'header', 'query', 'basic'].includes(a.auth) ? a.auth : undefined;
  const r = await upsertApiService({
    name,
    baseUrl: a.base_url ? String(a.base_url).trim() : undefined,
    auth,
    authName: a.auth_name ? String(a.auth_name) : undefined,
    note: a.note ? String(a.note) : undefined,
  }, key);
  if ('error' in r) { return r.error; }
  return `Stored the key for "${r.name}" (${r.auth}${r.authName ? ' ' + r.authName : ''}) in encrypted storage` +
    `${r.baseUrl ? `, base URL ${r.baseUrl}` : ''}. From now on call it with api_request(service:"${r.name}", …) — ` +
    `do NOT repeat the key anywhere. Next: api_discover(service:"${r.name}"` +
    `${r.baseUrl ? '' : ', url:"<API base, docs page or website URL>"'}) to load its endpoints.`;
}

async function apiDiscoverTool(a: any): Promise<string> {
  if (!getConfig().webAccess) { return 'Web access is disabled (codeflare.webAccess).'; }
  const name = a.service ? normalizeServiceName(String(a.service)) : '';
  const url = a.url ? String(a.url).trim() : '';
  const filter = a.filter ? String(a.filter) : undefined;
  const svc = name ? getApiService(name) : undefined;
  if (name && !svc && !url) {
    return `Unknown service "${name}". Store its key first with api_store_key, or pass url for a public API.`;
  }
  const cacheKey = name || `url:${url}`;
  if (!a.refresh && !url) {
    const c = await loadCachedSpec(cacheKey);
    if (c) {
      return `${c.spec.info?.title || 'API'} — spec ${c.specUrl} (cached)\nBase URL: ${svc?.meta.baseUrl || specBaseUrl(c.spec, c.specUrl)}\n\n` +
        renderEndpointList(c.spec, { filter }) +
        '\n\nNext: api_describe(service, method, path) for the exact parameters of the operation you need.';
    }
  }
  const seed = url || svc?.meta.specUrl || svc?.meta.baseUrl;
  if (!seed) {
    return `No URL known for "${name}" yet. web_search "${name} API documentation" (or ask the user), then call ` +
      `api_discover(service:"${name}", url:"<API base, docs page or openapi.json URL>").`;
  }
  const d = await discoverSpec(seed, { onProgress: m => log(`api_discover: ${m}`) });
  if (!('spec' in d)) {
    return `Tried ${d.tried.length} location(s) starting from ${seed} — nothing parsed as an OpenAPI/Swagger document.\n` +
      d.hints.join('\n') + `\nTried (first 12): ${d.tried.slice(0, 12).join(', ')}`;
  }
  await storeCachedSpec(cacheKey, { specUrl: d.specUrl, spec: d.spec });
  if (name) {
    const firstTime = !svc?.meta.specUrl;
    await upsertApiService({
      name,
      baseUrl: d.baseUrl,
      specUrl: d.specUrl,
      ...(firstTime && d.auth.scheme !== 'none' ? { auth: d.auth.scheme, authName: d.auth.name } : {}),
    });
  }
  return renderDiscovery(d, renderEndpointList(d.spec, { filter }));
}

async function apiDescribeTool(a: any): Promise<string> {
  const name = a.service ? normalizeServiceName(String(a.service)) : '';
  const specUrl = a.spec_url ? String(a.spec_url).trim() : '';
  const method = String(a.method ?? 'GET');
  const p = String(a.path ?? a.url ?? '').trim();
  if (!p) { return 'Provide method and path (e.g. POST /animate-with-text).'; }
  const cacheKey = name || (specUrl ? `url:${specUrl}` : '');
  if (!cacheKey) { return 'Provide service (or spec_url).'; }
  let c = await loadCachedSpec(cacheKey);
  if (!c) {
    const svc = name ? getApiService(name) : undefined;
    const seed = specUrl || svc?.meta.specUrl || svc?.meta.baseUrl;
    if (!seed) { return `No spec loaded for "${cacheKey}". Call api_discover first.`; }
    const d = await discoverSpec(seed);
    if (!('spec' in d)) { return `No spec found starting from ${seed}. Call api_discover with the right URL.`; }
    c = { specUrl: d.specUrl, spec: d.spec };
    await storeCachedSpec(cacheKey, c);
  }
  const real = findOperationPath(c.spec, p);
  const text = real ? describeOperation(c.spec, method, real) : null;
  if (text) { return text; }
  const stem = p.replace(/^\/+/, '').split('/')[0] || '#';
  const near = listEndpoints(c.spec).filter(e => e.path.includes(stem)).slice(0, 8);
  return `No ${method.toUpperCase()} ${p} in the spec.` +
    (near.length ? ` Similar: ${near.map(e => e.method + ' ' + e.path).join(', ')}` : ' Use api_discover with a filter to find the right path.');
}

async function apiRequestTool(a: any): Promise<string> {
  if (!getConfig().webAccess) { return 'Web access is disabled (codeflare.webAccess).'; }
  const url = String(a.url ?? a.path ?? '').trim();
  if (!url) { return 'Provide "url" (absolute https URL, or a path relative to the service base URL).'; }
  let auth: ApiAuth | undefined;
  let baseUrl: string | undefined;
  if (a.service) {
    const svc = getApiService(String(a.service));
    if (!svc) {
      const names = listApiServices().map(m => m.name).join(', ');
      return `Unknown service "${a.service}". Configured: ${names || '(none)'}. Store its key first with api_store_key.`;
    }
    if (!svc.key) { return `Service "${svc.meta.name}" has no key stored. Ask the user for it and call api_store_key.`; }
    baseUrl = svc.meta.baseUrl;
    const resolved = resolveUrl(url, baseUrl);
    if (typeof resolved !== 'string') { return resolved.error; }
    const allowed = hostAllowed(svc.meta, resolved);
    if (!allowed.ok) { return allowed.reason; }
    if (svc.meta.hosts.length === 0) { await pinHost(svc.meta.name, resolved); }
    auth = { scheme: svc.meta.auth, name: svc.meta.authName, prefix: svc.meta.authPrefix, value: svc.key };
  }
  return performApiRequest({
    method: a.method, url, query: a.query, headers: a.headers, body: a.body,
    timeout_ms: a.timeout_ms, save_to: a.save_to, save_images_dir: a.save_images_dir,
    save_images_prefix: a.save_images_prefix, poll: a.poll, max_chars: a.max_chars,
  }, auth, baseUrl, {
    saveFile: saveWorkspaceBytes,
    readFile: readWorkspaceBytes,
    redact: allServiceSecrets(),
    onProgress: m => log(`api_request: ${m}`),
  });
}

// name → executor. Schema lives in the group arrays above; this binds behaviour.
const HANDLERS: Record<string, (a: any) => Promise<string> | string> = {
  list_files: a => listFiles(a.path ?? '.'),
  read_file: a => readFile(a.path ?? '', a.start_line, a.end_line),
  find_files: a => findFilesTool(a.pattern ?? ''),
  get_diagnostics: a => getDiagnosticsTool(a.path),
  search_text: a => searchText(a.query ?? '', a.glob),
  project_stacks: async () => stacksToolReport(await getStacks()),
  find_related: a => findRelated(a.query ?? ''),
  remember: a => rememberFact(a.fact ?? '', a.category),
  forget: a => forgetFact(a.match ?? ''),
  find_executable: async a => {
    const name = String(a.name ?? '').trim();
    if (!name) { return 'Provide an executable name (e.g. "python", "java", "godot").'; }
    const found = await findExecutable(name);
    if (!found) {
      return `Could not find "${name}" on PATH, in the workspace root, or up to 3 levels up. ` +
        `Install it, or tell me its exact path.`;
    }
    // A discovered binary can upgrade stack tasks (e.g. the Godot verify
    // command bakes in the exe path) — rebuild the stack cache.
    if (registerExecutable(found.path, name)) { invalidateStacks(); }
    await rememberFact(`${name} = ${found.path}`, 'exe');
    return `Found ${name}: ${found.path} (via ${found.source}). It is now trusted (runs without a ` +
      `prompt) and remembered. Invoke it by that full path.`;
  },
  debug_set_breakpoint: a => debugSetBreakpoint(a.path ?? '', a.line ?? 1),
  debug_clear_breakpoints: a => debugClearBreakpoints(a.path),
  debug_start: a => debugStart(a.config),
  debug_inspect: () => debugInspect(),
  debug_continue: () => debugContinue(),
  debug_step: a => debugStep(a.kind ?? 'over'),
  debug_evaluate: a => debugEvaluate(a.expression ?? ''),
  debug_stop: () => debugStop(),
  find_symbol: a => findSymbol(a.query ?? ''),
  document_symbols: a => documentSymbols(a.path ?? ''),
  find_references: a => findReferences(a.path ?? '', a.symbol ?? ''),
  find_definition: a => findDefinition(a.path ?? '', a.symbol ?? ''),
  web_fetch: a => webFetch(a.url ?? ''),
  web_search: a => webSearch(a.query ?? ''),
  web_extract: a => webExtractTool(a.url ?? '', a.render === true),
  crawl_site: a => crawlSiteTool(a.url ?? '', a.max_pages, a.same_domain, a.render === true),
  screenshot_url: a => screenshotUrlTool(a.url ?? '', a.path),
  api_services: () => apiServicesTool(),
  api_store_key: a => apiStoreKeyTool(a),
  api_discover: a => apiDiscoverTool(a),
  api_describe: a => apiDescribeTool(a),
  api_request: a => apiRequestTool(a),
  create_file: a => createFile(a.path ?? '', a.content ?? ''),
  edit_file: a => editFile(a.path ?? '', a.search ?? '', a.replace ?? ''),
  move_file: a => moveFile(a.source ?? '', a.destination ?? ''),
  delete_file: a => deleteFile(a.path ?? ''),
  apply_patch: a => applyPatch(a.patch ?? ''),
  rename_symbol: a => renameSymbol(a.path ?? '', a.symbol ?? '', a.new_name ?? ''),
  run_command: a => runCommand(a.command ?? ''),
  read_terminal_output: a => readTerminalOutput(a.lines ?? 60),
  add_probe: a => addProbe(a),
  read_probes: a => readProbes(a),
  list_probes: () => listProbes(),
  remove_probes: a => removeProbes(a),
  lab_run: a => labRunTool(a),
  lab_benchmark: a => labBenchmarkTool(a),
  lab_diff_test: a => labDiffTestTool(a),
  lab_profile: a => labProfileTool(a),
  lab_scaling: a => labScalingTool(a),
  // update_todos and run_subagent are handled by the provider (no handler here).
};

// name → short UI label.
const DESCRIBERS: Record<string, (a: any) => string> = {
  list_files: a => `list_files(${a.path ?? '.'})`,
  read_file: a => `read_file(${a.path ?? '?'}${a.start_line || a.end_line ? `:${a.start_line ?? 1}-${a.end_line ?? ''}` : ''})`,
  find_files: a => `find_files(${a.pattern ?? '?'})`,
  get_diagnostics: a => `get_diagnostics(${a.path ?? 'workspace'})`,
  search_text: a => `search_text("${a.query ?? '?'}"${a.glob ? `, ${a.glob}` : ''})`,
  find_related: a => `find_related("${a.query ?? '?'}")`,
  project_stacks: () => 'project_stacks()',
  remember: a => `remember(${a.category ? `[${a.category}] ` : ''}${String(a.fact ?? '?').slice(0, 50)})`,
  forget: a => `forget(${String(a.match ?? '?').slice(0, 40)})`,
  find_executable: a => `find_executable(${a.name ?? '?'})`,
  debug_set_breakpoint: a => `debug_set_breakpoint(${a.path ?? '?'}:${a.line ?? '?'})`,
  debug_clear_breakpoints: a => `debug_clear_breakpoints(${a.path ?? 'all'})`,
  debug_start: a => `debug_start(${a.config ?? ''})`,
  debug_inspect: () => 'debug_inspect()',
  debug_continue: () => 'debug_continue()',
  debug_step: a => `debug_step(${a.kind ?? 'over'})`,
  debug_evaluate: a => `debug_evaluate(${String(a.expression ?? '?').slice(0, 40)})`,
  debug_stop: () => 'debug_stop()',
  find_symbol: a => `find_symbol("${a.query ?? '?'}")`,
  document_symbols: a => `document_symbols(${a.path ?? '?'})`,
  find_references: a => `find_references(${a.symbol ?? '?'})`,
  find_definition: a => `find_definition(${a.symbol ?? '?'})`,
  web_fetch: a => `web_fetch(${a.url ?? '?'})`,
  web_search: a => `web_search("${a.query ?? '?'}")`,
  web_extract: a => `web_extract(${a.url ?? '?'}${a.render ? ', render' : ''})`,
  crawl_site: a => `crawl_site(${a.url ?? '?'}, ≤${a.max_pages ?? 8}${a.render ? ', render' : ''})`,
  screenshot_url: a => `screenshot_url(${a.url ?? '?'})`,
  api_services: () => 'api_services()',
  api_store_key: a => `api_store_key(${a.service ?? '?'})`,
  api_discover: a => `api_discover(${a.service ?? a.url ?? '?'}${a.filter ? `, "${a.filter}"` : ''})`,
  api_describe: a => `api_describe(${a.service ? a.service + ' ' : ''}${String(a.method ?? 'GET').toUpperCase()} ${a.path ?? '?'})`,
  api_request: a => `api_request(${a.service ? a.service + ' ' : ''}${String(a.method ?? (a.body !== undefined ? 'POST' : 'GET')).toUpperCase()} ${a.url ?? '?'}${a.poll ? ', poll' : ''}${a.save_to || a.save_images_dir ? ' → ' + (a.save_to || a.save_images_dir) : ''})`,
  run_subagent: a => `subagent: ${String(a.task ?? '?').slice(0, 60)}`,
  run_subagents: a => `subagents ×${Array.isArray(a.tasks) ? a.tasks.length : 0} (parallel)`,
  verify_visual: a => `verify_visual(${a.path ?? '?'})`,
  lab_run: a => `lab_run(${a.name ?? a.language ?? 'script'})`,
  lab_benchmark: a => `lab_benchmark(${a.label ?? '?'}, ${a.iterations ?? 1000} iters)`,
  lab_diff_test: a => `lab_diff_test(${a.cases ?? 1000} cases)`,
  lab_profile: a => `lab_profile(${a.language ?? 'javascript'}, top ${a.top ?? 12})`,
  lab_scaling: a => `lab_scaling(${Array.isArray(a.sizes) ? a.sizes.join(',') : 'default sizes'})`,
  create_file: a => `create_file(${a.path ?? '?'})`,
  edit_file: a => `edit_file(${a.path ?? '?'})`,
  move_file: a => `move_file(${a.source ?? '?'} → ${a.destination ?? '?'})`,
  delete_file: a => `delete_file(${a.path ?? '?'})`,
  apply_patch: a => {
    const m = String(a.patch ?? '').match(/^\+\+\+ (?:b\/)?(\S+)/m);
    return `apply_patch(${m ? m[1] : '…'})`;
  },
  rename_symbol: a => `rename_symbol(${a.symbol ?? '?'} → ${a.new_name ?? '?'})`,
  run_command: a => `run_command: ${a.command ?? '?'}`,
  read_terminal_output: () => 'read_terminal_output()',
  add_probe: a => `probe: ${a.label || a.expression || a.kind || '?'} @ ${a.path ?? '?'}`,
  read_probes: a => `read_probes()${a.clear ? ' + clear' : ''}`,
  list_probes: () => 'list_probes()',
  remove_probes: a => `remove_probes(${Array.isArray(a.ids) ? a.ids.join(',') : a.path ?? 'all'})`,
  update_todos: a => `plan: ${Array.isArray(a.todos) ? a.todos.length : 0} step(s)`,
};

const GROUPED: [ToolDefinition[], ToolGroup][] = [
  [READ_TOOLS, 'read'], [LSP_TOOLS, 'lsp'], [PLAN_TOOLS, 'plan'],
  [WRITE_TOOLS, 'write'], [PROBE_TOOLS, 'probe'], [RUN_TOOLS, 'run'],
  [DEBUG_TOOLS, 'debug'], [VISION_TOOLS, 'vision'], [WEB_TOOLS, 'web'], [API_TOOLS, 'api'], [SUBAGENT_TOOLS, 'subagent'],
  [LAB_TOOLS, 'lab'],
];

/** The single registry every consumer derives from. */
export const REGISTRY: ToolSpec[] = GROUPED.flatMap(([arr, group]) =>
  arr.map(def => ({
    def,
    group,
    handler: HANDLERS[def.function.name],
    describe: DESCRIBERS[def.function.name] ?? ((a: any) => `${def.function.name}(${JSON.stringify(a)})`),
    copyable: def.function.name === 'run_command' ? (a: any) => a.command || undefined : undefined,
  }))
);

function groupEnabled(group: ToolGroup, opts: ToolOptions): boolean {
  switch (group) {
    case 'read': case 'lsp': return true;
    case 'plan': return opts.plan !== false;
    case 'write': return !!opts.write;
    // Probes edit files, so they follow the write permission as well.
    case 'probe': return !!opts.write && !!opts.probes;
    case 'run': return !!opts.run;
    // Debugging executes the program, so it also needs the run permission.
    case 'debug': return !!opts.run && !!opts.debug;
    case 'vision': return !!opts.vision;
    case 'web': return !!opts.web;
    // External APIs are web access too (files are written only through the write gate).
    case 'api': return !!opts.web;
    case 'subagent': return !!opts.subagent;
    // Lab experiments execute code, so they follow the run permission.
    case 'lab': return !!opts.run;
  }
}

/** OpenAI-function tool schemas for the current agent configuration (+ MCP). */
export function getToolDefinitions(opts: ToolOptions): ToolDefinition[] {
  return [
    ...REGISTRY.filter(s => groupEnabled(s.group, opts)).map(s => s.def),
    ...(opts.plan !== false ? MISSION_TOOLS : []),
    ...getMcpToolDefinitions(),
  ];
}

function workspaceRoot(): vscode.Uri | undefined {
  return vscode.workspace.workspaceFolders?.[0]?.uri;
}

/** True if `target` is `root` itself or nested under it (pure path check, no I/O). */
function isInsideRoot(target: vscode.Uri, root: vscode.Uri): boolean {
  const t = target.path.replace(/\/+$/, '');
  const r = root.path.replace(/\/+$/, '');
  return t === r || t.startsWith(r + '/');
}

/**
 * Folders the file tools may touch: every workspace folder, PLUS the directory
 * of the file the user currently has open. The latter lets the agent read and
 * edit a file opened from OUTSIDE the workspace — e.g. a script opened by
 * another extension — instead of being locked to workspaceFolders[0].
 */
function allowedRoots(): vscode.Uri[] {
  const roots: vscode.Uri[] = (vscode.workspace.workspaceFolders ?? []).map(f => f.uri);
  const active = resolveActiveEditor();
  if (active && active.document.uri.scheme === 'file') {
    const dir = vscode.Uri.joinPath(active.document.uri, '..');
    if (!roots.some(r => isInsideRoot(dir, r))) { roots.push(dir); }
  }
  return roots;
}

/**
 * Resolve a path a tool was given to an absolute Uri, refusing anything that
 * escapes the allowed roots (the workspace folders + the open file's folder).
 * An ABSOLUTE path is accepted when it falls inside an allowed root — the model
 * sees the active file by its absolute path, so this is how it edits files
 * outside the workspace. A RELATIVE path resolves against the primary root (the
 * first workspace folder, or the open file's folder when no workspace is open).
 */
export function resolveInWorkspace(relPath: string): vscode.Uri | { error: string } {
  const roots = allowedRoots();
  if (roots.length === 0) {
    return { error: 'No workspace folder is open.' };
  }

  const clean = (relPath || '.').replace(/\\/g, '/').trim();
  const isAbsolute = clean.startsWith('/') || /^[a-zA-Z]:/.test(clean);

  if (isAbsolute) {
    // vscode.Uri.file does NOT collapse `..`, so a path like /c:/ws/../secret
    // would string-prefix-match the root while resolving outside it. Reject any
    // path that still contains a `..` segment after normalization.
    if (clean.split('/').includes('..')) {
      return { error: `Path may not contain ".." segments: "${relPath}".` };
    }
    const target = vscode.Uri.file(clean);
    if (roots.some(r => isInsideRoot(target, r))) { return target; }
    return {
      error: `Path is outside the workspace and the open file's folder: "${relPath}". ` +
        `Add its folder to the workspace to work on files there.`,
    };
  }

  const primary = roots[0];
  const target = vscode.Uri.joinPath(primary, clean);
  if (isInsideRoot(target, primary)) { return target; }
  return { error: 'Path escapes the workspace folder.' };
}

/** Expand %VAR%, ${VAR} and a leading ~ in a configured path. */
function expandPath(p: string): string {
  let s = (p || '').trim();
  s = s.replace(/%([^%]+)%/g, (_m, n) => process.env[n] ?? '');
  s = s.replace(/\$\{([^}]+)\}/g, (_m, n) => process.env[n] ?? '');
  s = s.replace(/^~(?=[\\/]|$)/, () => os.homedir());
  return s;
}

/**
 * Read-only roots OUTSIDE the workspace where produced output may land — the OS
 * temp dir plus the user's codeflare.artifactRoots (appdata-style locations).
 * Used only by read tools; mutating tools never consult these.
 */
function readOnlyRoots(): vscode.Uri[] {
  const roots: vscode.Uri[] = [];
  try { roots.push(vscode.Uri.file(os.tmpdir())); } catch { /* ignore */ }
  for (const r of getConfig().artifactRoots) {
    const e = expandPath(r);
    if (e) { try { roots.push(vscode.Uri.file(e)); } catch { /* bad path */ } }
  }
  return roots;
}

/**
 * Resolve a path for a READ-ONLY tool: the workspace first, then (for absolute
 * paths) any configured artifact root, so the agent can read program output
 * that lands in appdata/temp. Never grants write access.
 */
export function resolveForRead(relPath: string): vscode.Uri | { error: string } {
  const inWs = resolveInWorkspace(relPath);
  if (!('error' in inWs)) { return inWs; }

  const clean = (relPath || '').replace(/\\/g, '/').trim();
  const isAbsolute = clean.startsWith('/') || /^[a-zA-Z]:/.test(clean);
  if (isAbsolute) {
    const target = vscode.Uri.file(clean);
    if (readOnlyRoots().some(r => isInsideRoot(target, r))) { return target; }
  }
  return {
    error: `Path is outside the workspace and any read-only artifact root: "${relPath}". ` +
      `To read program output there, add its folder to codeflare.artifactRoots.`,
  };
}

async function listFiles(relPath: string): Promise<string> {
  const uri = resolveForRead(relPath || '.');
  if ('error' in uri) { return uri.error; }

  let entries: [string, vscode.FileType][];
  try {
    entries = await vscode.workspace.fs.readDirectory(uri);
  } catch (err: any) {
    return `Cannot list "${relPath}": ${err.message}`;
  }

  const lines = entries
    .filter(([name]) => !IGNORED.has(name))
    .sort((a, b) => {
      // Directories first, then alphabetical.
      const aDir = a[1] === vscode.FileType.Directory;
      const bDir = b[1] === vscode.FileType.Directory;
      if (aDir !== bDir) { return aDir ? -1 : 1; }
      return a[0].localeCompare(b[0]);
    })
    .slice(0, MAX_LIST_ENTRIES)
    .map(([name, type]) =>
      type === vscode.FileType.Directory ? `${name}/` : name
    );

  if (lines.length === 0) { return `(empty folder: ${relPath || '.'})`; }
  const header = `Contents of ${relPath || '.'}:`;
  const truncated = entries.length > MAX_LIST_ENTRIES
    ? `\n… (${entries.length - MAX_LIST_ENTRIES} more entries omitted)`
    : '';
  return `${header}\n${lines.join('\n')}${truncated}`;
}

async function readFile(relPath: string, startLine?: number, endLine?: number): Promise<string> {
  const uri = resolveForRead(relPath);
  if ('error' in uri) { return uri.error; }

  let bytes: Uint8Array;
  try {
    bytes = await vscode.workspace.fs.readFile(uri);
  } catch (err: any) {
    return `Cannot read "${relPath}": ${err.message}`;
  }

  const full = new TextDecoder().decode(bytes);
  const allLines = full.split('\n');

  // Optional line range (1-based, inclusive) — how a large file is read in
  // parts after the whole-file read reports truncation.
  let first = 1;
  let lines = allLines;
  let rangeNote = '';
  if (startLine || endLine) {
    first = Math.max(1, Math.floor(startLine || 1));
    const last = Math.min(allLines.length, Math.floor(endLine || allLines.length));
    if (first > allLines.length) {
      return `${relPath} has only ${allLines.length} lines — start_line ${first} is past the end.`;
    }
    lines = allLines.slice(first - 1, last);
    rangeNote = ` (lines ${first}-${last} of ${allLines.length})`;
  }

  let text = lines.map((line, i) => `${String(first + i).padStart(4)} | ${line}`).join('\n');
  let truncatedNote = '';
  if (text.length > MAX_READ_CHARS) {
    text = text.slice(0, MAX_READ_CHARS);
    truncatedNote = `\n… (truncated at ${MAX_READ_CHARS} characters — the file has ` +
      `${allLines.length} lines; read the rest with start_line/end_line)`;
  }

  return `${relPath}${rangeNote}:\n${text}${truncatedNote}`;
}

async function findFilesTool(pattern: string): Promise<string> {
  const p = (pattern || '').replace(/\\/g, '/').trim();
  if (!p) { return 'Provide a glob pattern or (partial) file name.'; }
  if (!workspaceRoot()) { return 'No workspace folder is open.'; }

  // A bare name (no glob chars, no slash) matches anywhere in the tree, as a
  // substring of the file name — "player" finds src/entities/player_ship.gd.
  let glob = p;
  if (!/[*?{}[\]]/.test(p)) {
    glob = p.includes('/') ? `**/${p}*` : `**/*${p}*`;
  } else if (!p.includes('/')) {
    glob = `**/${p}`;
  }

  const exclude = `{${Array.from(IGNORED).map(d => `**/${d}/**`).join(',')}}`;
  let files: vscode.Uri[];
  try {
    files = await vscode.workspace.findFiles(glob, exclude, MAX_LIST_ENTRIES + 1);
  } catch (err: any) {
    return `Invalid pattern "${pattern}": ${err.message}`;
  }
  if (files.length === 0) { return `No files match "${pattern}" (searched as ${glob}).`; }

  const rels = files
    .slice(0, MAX_LIST_ENTRIES)
    .map(f => vscode.workspace.asRelativePath(f))
    .sort((a, b) => a.length - b.length || a.localeCompare(b));
  const more = files.length > MAX_LIST_ENTRIES ? `\n… (more matches exist — narrow the pattern)` : '';
  return `${rels.length} file(s) matching "${pattern}":\n${rels.join('\n')}${more}`;
}

async function getDiagnosticsTool(relPath?: string): Promise<string> {
  if (relPath) {
    const rep = await collectDiagnostics([relPath]);
    if (!rep.text) { return `No problems reported for ${relPath}.`; }
    return `${rep.errorCount} error(s), ${rep.warningCount} warning(s) in ${relPath}:\n${rep.text}`;
  }

  // Workspace-wide: everything the language servers currently know, capped.
  let errors = 0;
  let warnings = 0;
  const lines: string[] = [];
  for (const [uri, diags] of vscode.languages.getDiagnostics()) {
    for (const d of diags) {
      if (d.severity > vscode.DiagnosticSeverity.Warning) { continue; }
      if (d.severity === vscode.DiagnosticSeverity.Error) { errors++; } else { warnings++; }
      if (lines.length >= 40) { continue; }
      const rel = vscode.workspace.asRelativePath(uri);
      const sev = d.severity === vscode.DiagnosticSeverity.Error ? 'error' : 'warning';
      lines.push(`${rel}:${d.range.start.line + 1}:${d.range.start.character + 1} [${sev}] ` +
        `${d.message}${d.source ? ` (${d.source})` : ''}`);
    }
  }
  if (errors + warnings === 0) { return 'No problems reported anywhere in the workspace.'; }
  const capped = errors + warnings > 40 ? `\n… (${errors + warnings - 40} more not shown)` : '';
  return `Workspace problems: ${errors} error(s), ${warnings} warning(s).\n${lines.join('\n')}${capped}`;
}

async function searchText(query: string, glob?: string): Promise<string> {
  if (!query) { return 'Empty search query.'; }
  const root = workspaceRoot();
  if (!root) { return 'No workspace folder is open.'; }

  let regex: RegExp;
  try {
    regex = new RegExp(query, 'i');
  } catch {
    // Fall back to a literal substring search if it isn't valid regex.
    regex = new RegExp(query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
  }

  const exclude = `{${Array.from(IGNORED).map(d => `**/${d}/**`).join(',')}}`;
  const files = await vscode.workspace.findFiles(glob || '**/*', exclude, MAX_SEARCH_FILES);

  const hits: string[] = [];
  for (const file of files) {
    if (hits.length >= MAX_SEARCH_HITS) { break; }
    let bytes: Uint8Array;
    try {
      bytes = await vscode.workspace.fs.readFile(file);
    } catch {
      continue;
    }
    // Skip likely-binary files.
    if (bytes.includes(0)) { continue; }
    const text = new TextDecoder().decode(bytes);
    const rel = vscode.workspace.asRelativePath(file);
    const lines = text.split('\n');
    for (let i = 0; i < lines.length && hits.length < MAX_SEARCH_HITS; i++) {
      if (regex.test(lines[i])) {
        hits.push(`${rel}:${i + 1}: ${lines[i].trim().slice(0, 200)}`);
      }
    }
  }

  if (hits.length === 0) {
    return `No matches for "${query}"${glob ? ` in ${glob}` : ''}.`;
  }
  const note = hits.length >= MAX_SEARCH_HITS ? `\n… (results capped at ${MAX_SEARCH_HITS})` : '';
  return `Matches for "${query}":\n${hits.join('\n')}${note}`;
}

let previewCounter = 0;

/** Show a diff of the proposed content and ask the user to accept it. */
async function confirmWithDiff(uri: vscode.Uri, newContent: string, title: string): Promise<boolean> {
  const provider = getPreviewProvider();
  const previewUri = vscode.Uri.parse(
    `codeflare-preview:${uri.path}?agent-${previewCounter++}`
  );
  provider.setContent(previewUri, newContent);

  // Diff the current file (empty for new files) against the proposed content.
  let leftUri = uri;
  try {
    await vscode.workspace.fs.stat(uri);
  } catch {
    const emptyUri = vscode.Uri.parse(`codeflare-preview:${uri.path}?empty-${previewCounter++}`);
    provider.setContent(emptyUri, '');
    leftUri = emptyUri;
  }

  await vscode.commands.executeCommand('vscode.diff', leftUri, previewUri, title);

  const choice = await vscode.window.showInformationMessage(
    title, { modal: true }, 'Apply', 'Reject'
  );
  await vscode.commands.executeCommand('workbench.action.closeActiveEditor');
  return choice === 'Apply';
}

// Enforce targeted edits: models love to regenerate whole files, which is slow
// and error-prone. edit_file's search may span at most editSearchMaxLines, and
// create_file refuses to overwrite an existing file beyond overwriteMaxLines
// (both configurable under codeflare.* settings).

async function createFile(relPath: string, content: string): Promise<string> {
  const config = getConfig();
  if (!config.agentEdit) { return 'File editing is disabled (codeflare.agentEdit is off).'; }

  const uri = resolveInWorkspace(relPath);
  if ('error' in uri) { return uri.error; }

  // Block whole-file regeneration of an existing file — that's what edit_file
  // is for. (Overwriting tiny files is fine.)
  let existingLines = 0;
  let isNew = true;
  try {
    const existing = new TextDecoder().decode(await vscode.workspace.fs.readFile(uri));
    const lines = existing.split('\n').length;
    existingLines = lines;
    isNew = false;
    if (lines > config.overwriteMaxLines) {
      return `${relPath} already exists (${lines} lines). Do NOT regenerate the whole file — ` +
        `use edit_file with SMALL targeted search/replace changes (search only the lines that ` +
        `actually change). If the file is corrupted and truly needs a full rewrite: FIRST move it ` +
        `aside with move_file (e.g. to ${relPath}.broken) or delete it (run_command: Remove-Item ` +
        `${relPath}), THEN create it fresh — in small parts (~120 lines + edit_file appends).`;
    }
  } catch { /* file doesn't exist — normal create */ }

  // Deterministic policy: path rules + change budget (enforced, not prompted).
  const verdict = gateMutation(relPath, {
    isNew,
    addedLines: content.split('\n').length,
    deletedLines: existingLines,
  });
  if (!verdict.allowed) { return policyMessage(verdict); }

  const base = path.basename(relPath);
  if (config.confirmEdits) {
    const ok = await confirmWithDiff(uri, content, `Create ${base}?`);
    if (!ok) { return `User rejected creating ${relPath}.`; }
  }

  // Record pre-state (null = didn't exist) so the turn can be reverted.
  await recordPreMutation(relPath);
  try {
    const dir = vscode.Uri.joinPath(uri, '..');
    await vscode.workspace.fs.createDirectory(dir);
    await vscode.workspace.fs.writeFile(uri, new TextEncoder().encode(content));
  } catch (err: any) {
    return `Failed to write "${relPath}": ${err.message}`;
  }
  invalidateRepoMap();
  invalidateStacks();
  log(`Agent created file: ${relPath}`);
  return `Created ${relPath} (${content.split('\n').length} lines).`;
}

async function editFile(relPath: string, search: string, replace: string): Promise<string> {
  const config = getConfig();
  if (!config.agentEdit) { return 'File editing is disabled (codeflare.agentEdit is off).'; }

  // Enforce targeted edits: a search block spanning half the file means the
  // model is regenerating instead of editing. (The REPLACE side may be large —
  // that's how appending works.)
  const searchLines = search.split('\n').length;
  if (searchLines > config.editSearchMaxLines) {
    return `Search block too large (${searchLines} lines, max ${config.editSearchMaxLines}). ` +
      `Make a TARGETED edit: search ONLY the few lines that actually change and replace just those. ` +
      `Split multiple changes into multiple edit_file calls. To append, search the last ~10 lines ` +
      `and replace them with themselves plus the new content.`;
  }

  const uri = resolveInWorkspace(relPath);
  if ('error' in uri) { return uri.error; }

  let original: string;
  try {
    original = new TextDecoder().decode(await vscode.workspace.fs.readFile(uri));
  } catch (err: any) {
    return `Cannot read "${relPath}" to edit it: ${err.message}. Use create_file to make a new file.`;
  }

  // Idempotency guard: local models sometimes repeat an edit call that already
  // succeeded. For an INSERTION (replace contains the search lines plus new
  // ones) the search still matches after applying, so a repeat would duplicate
  // the inserted lines and corrupt the file. If the full replacement text is
  // already in the file, the edit was made — refuse the repeat.
  if (replace !== search && replace.includes(search) && original.includes(replace)) {
    return `Not applied: ${relPath} already contains exactly this replacement text — ` +
      `this edit was already made earlier. Do NOT repeat an edit_file call that succeeded. ` +
      `Re-read the file if you are unsure of its current state, then continue with the NEXT step.`;
  }

  const result = applyEdits(original, [{ search, replace }]);
  if (result.applied === 0) {
    return `Could not find the search snippet in ${relPath}. ${result.errors.join('; ')} ` +
      `Re-read the file and copy the exact text you want to change.`;
  }

  // Deterministic policy: path rules + change budget (enforced, not prompted).
  const lineDelta = replace.split('\n').length - search.split('\n').length;
  const verdict = gateMutation(relPath, {
    addedLines: Math.max(0, lineDelta),
    deletedLines: Math.max(0, -lineDelta),
  });
  if (!verdict.allowed) { return policyMessage(verdict); }

  const base = path.basename(relPath);
  if (config.confirmEdits) {
    const ok = await confirmWithDiff(uri, result.newContent, `Apply edit to ${base}?`);
    if (!ok) { return `User rejected the edit to ${relPath}.`; }
  }

  await recordPreMutation(relPath);
  try {
    await vscode.workspace.fs.writeFile(uri, new TextEncoder().encode(result.newContent));
  } catch (err: any) {
    return `Failed to write "${relPath}": ${err.message}`;
  }
  invalidateRepoMap();
  invalidateStacks();
  log(`Agent edited file: ${relPath}`);
  return `Edited ${relPath}.`;
}

async function moveFile(srcPath: string, destPath: string): Promise<string> {
  const config = getConfig();
  if (!config.agentEdit) { return 'File editing is disabled (codeflare.agentEdit is off).'; }

  const src = resolveInWorkspace(srcPath);
  if ('error' in src) { return src.error; }
  const dest = resolveInWorkspace(destPath);
  if ('error' in dest) { return dest.error; }

  try {
    await vscode.workspace.fs.stat(src);
  } catch {
    return `Source "${srcPath}" does not exist.`;
  }
  try {
    await vscode.workspace.fs.stat(dest);
    return `Destination "${destPath}" already exists. Choose a different name or delete it first.`;
  } catch {
    // Destination free — good.
  }

  // Deterministic policy: both ends of a move are mutations.
  const srcVerdict = gateMutation(srcPath);
  if (!srcVerdict.allowed) { return policyMessage(srcVerdict); }
  const destVerdict = gateMutation(destPath, { isNew: true });
  if (!destVerdict.allowed) { return policyMessage(destVerdict); }

  if (config.confirmEdits) {
    const ok = await vscode.window.showWarningMessage(
      `Move "${srcPath}" → "${destPath}"?`, { modal: true }, 'Move'
    );
    if (ok !== 'Move') { return `User rejected moving ${srcPath}.`; }
  }

  // Capture both ends: source (its content, so revert restores it there) and
  // destination (null → revert removes the moved-in file).
  await recordPreMutation(srcPath);
  await recordPreMutation(destPath);
  try {
    // Ensure the destination's parent folder exists.
    await vscode.workspace.fs.createDirectory(vscode.Uri.joinPath(dest, '..'));
    await vscode.workspace.fs.rename(src, dest, { overwrite: false });
  } catch (err: any) {
    return `Failed to move "${srcPath}" to "${destPath}": ${err.message}`;
  }
  invalidateRepoMap();
  invalidateStacks();
  log(`Agent moved: ${srcPath} -> ${destPath}`);
  return `Moved ${srcPath} to ${destPath}.`;
}

/**
 * Delete a file or folder — SOFT: the target is moved into
 * .codeflare-trash/<timestamp>/ (recoverable) rather than destroyed, and its
 * pre-state is recorded in the turn checkpoint so a revert restores it in place.
 * Routes through the same workspace-boundary + checkpoint layer as the other
 * mutating tools, so "delete" is a first-class, undoable operation.
 */
async function deleteFile(relPath: string): Promise<string> {
  const config = getConfig();
  if (!config.agentEdit) { return 'File editing is disabled (codeflare.agentEdit is off).'; }

  const uri = resolveInWorkspace(relPath);
  if ('error' in uri) { return uri.error; }

  let stat: vscode.FileStat;
  try {
    stat = await vscode.workspace.fs.stat(uri);
  } catch {
    return `"${relPath}" does not exist.`;
  }

  // Deterministic policy: a delete is a mutation of its path.
  const verdict = gateMutation(relPath);
  if (!verdict.allowed) { return policyMessage(verdict); }

  // Never let a delete target the trash itself.
  const root = workspaceRoot();
  if (root && isInsideRoot(uri, vscode.Uri.joinPath(root, '.codeflare-trash'))) {
    return `Refusing to delete inside .codeflare-trash.`;
  }

  const isDir = stat.type === vscode.FileType.Directory;
  if (config.confirmEdits) {
    const ok = await vscode.window.showWarningMessage(
      `Delete ${isDir ? 'folder' : 'file'} "${relPath}"? (moved to .codeflare-trash, recoverable)`,
      { modal: true }, 'Delete'
    );
    if (ok !== 'Delete') { return `User rejected deleting ${relPath}.`; }
  }

  // Record pre-state before removing: for a file this captures its content so a
  // turn revert can restore it. (Directories aren't captured content-wise; the
  // trash copy is the recovery path for those.)
  if (!isDir) { await recordPreMutation(relPath); }

  const stamp = String(Date.now());
  const base = path.basename(relPath.replace(/[\\/]+$/, '')) || 'item';
  const trashDir = root
    ? vscode.Uri.joinPath(root, '.codeflare-trash', `deleted-${stamp}`)
    : vscode.Uri.joinPath(uri, '..', '.codeflare-trash', `deleted-${stamp}`);
  try {
    await vscode.workspace.fs.createDirectory(trashDir);
    await vscode.workspace.fs.rename(uri, vscode.Uri.joinPath(trashDir, base), { overwrite: true });
  } catch (err: any) {
    return `Failed to delete "${relPath}": ${err.message}`;
  }
  invalidateRepoMap();
  invalidateStacks();
  log(`Agent deleted (soft): ${relPath} -> .codeflare-trash/deleted-${stamp}/${base}`);
  // Only files are captured in the turn checkpoint (see recordPreMutation above);
  // a folder's sole recovery path is the trash copy, so don't promise a revert.
  return isDir
    ? `Deleted folder ${relPath} (moved to .codeflare-trash — recover it from there; a turn revert will NOT restore a folder).`
    : `Deleted ${relPath} (moved to .codeflare-trash — recoverable; a turn revert restores it in place).`;
}

/**
 * Apply a unified diff to one or more files. Each file's hunks are located by
 * context (whitespace-tolerant) and applied; a file whose hunks don't match is
 * left untouched and reported. New-file (--- /dev/null) and delete (+++ /dev/null)
 * sections are handled. Every write goes through the checkpoint like the other
 * mutating tools.
 */
async function applyPatch(patchText: string): Promise<string> {
  const config = getConfig();
  if (!config.agentEdit) { return 'File editing is disabled (codeflare.agentEdit is off).'; }
  if (!patchText || !patchText.trim()) { return 'Empty patch.'; }

  const files = parseUnifiedDiff(patchText);
  if (files.length === 0) {
    return 'No file sections found. Provide a unified diff with "--- a/path" / "+++ b/path" headers and @@ hunks.';
  }

  // Two-phase apply so a multi-file patch is ATOMIC: first VALIDATE every file
  // section (resolve, read, apply hunks in memory) without writing anything; if
  // ANY section fails — a hunk whose context no longer matches, overlapping
  // hunks, a path error — abort with all failures and touch NOTHING. Only when
  // every section is clean do we commit. This removes the half-applied,
  // unclear state the old file-by-file loop could leave on a mid-patch failure.
  type Planned =
    | { kind: 'write'; uri: vscode.Uri; target: string; content: string; existed: boolean; applied: number }
    | { kind: 'delete'; target: string };
  const plan: Planned[] = [];
  const errors: string[] = [];
  const noops: string[] = [];

  for (const fp of files) {
    if (fp.isDelete && fp.oldPath !== '/dev/null') {
      const uri = resolveInWorkspace(fp.oldPath);
      if ('error' in uri) { errors.push(`${fp.oldPath}: ${uri.error}`); continue; }
      try { await vscode.workspace.fs.stat(uri); }
      catch { errors.push(`${fp.oldPath}: cannot delete — it does not exist.`); continue; }
      const dv = previewMutation(fp.oldPath);
      if (!dv.allowed) { errors.push(`${fp.oldPath}: ${policyMessage(dv)}`); continue; }
      plan.push({ kind: 'delete', target: fp.oldPath });
      continue;
    }

    const target = fp.newPath !== '/dev/null' ? fp.newPath : fp.oldPath;
    const uri = resolveInWorkspace(target);
    if ('error' in uri) { errors.push(`${target}: ${uri.error}`); continue; }

    let original = '';
    let existed = true;
    try {
      original = new TextDecoder().decode(await vscode.workspace.fs.readFile(uri));
    } catch { existed = false; }

    if (fp.isNew && existed) {
      errors.push(`${target}: patch marks this as a NEW file but it already exists.`);
      continue;
    }
    if (!fp.isNew && !existed) {
      errors.push(`${target}: does not exist. Patch an existing file, or use "--- /dev/null" to create a new one.`);
      continue;
    }

    const res = applyFilePatch(original, fp);
    if (!res.ok) { errors.push(`${target}: ${res.error}`); continue; }
    if (existed && res.content === original) { noops.push(`${target}: patch made no change.`); continue; }

    // Deterministic policy in the validation phase, so a rejection aborts the
    // whole patch before anything is written (atomicity preserved).
    const lineDelta = res.content.split('\n').length - original.split('\n').length;
    const pv = previewMutation(target, {
      isNew: !existed,
      addedLines: Math.max(0, lineDelta),
      deletedLines: Math.max(0, -lineDelta),
    });
    if (!pv.allowed) { errors.push(`${target}: ${policyMessage(pv)}`); continue; }

    plan.push({ kind: 'write', uri, target, content: res.content, existed, applied: res.applied });
  }

  // Any failure → apply nothing. The model re-reads and regenerates the patch.
  if (errors.length > 0) {
    const wouldApply = plan.map(p => p.kind === 'write' ? `${p.target} (${p.applied} hunk(s))` : `delete ${p.target}`);
    return `Patch NOT applied — no files were changed (atomic apply). Fix these and resend the whole patch:\n` +
      errors.map(e => `  - ${e}`).join('\n') +
      (wouldApply.length ? `\n\nThese sections were fine and would have applied: ${wouldApply.join(', ')}.` : '');
  }
  if (plan.length === 0) {
    return noops.length ? noops.join('\n') : 'Patch made no changes.';
  }

  // Confirm-before-commit (opt-in): gather all decisions first; if the user
  // rejects any, cancel the WHOLE patch so we never half-apply.
  if (config.confirmEdits) {
    for (const p of plan) {
      if (p.kind !== 'write') { continue; }
      const okc = await confirmWithDiff(p.uri, p.content, `Apply patch to ${path.basename(p.target)}?`);
      if (!okc) { return `Patch cancelled by user — no files were changed.`; }
    }
  }

  // Commit: every section already validated, so this is just writes/deletes.
  const results: string[] = [];
  for (const p of plan) {
    if (p.kind === 'delete') {
      results.push(await deleteFile(p.target));
      continue;
    }
    gateMutation(p.target, { isNew: !p.existed });   // record into the budget totals (previewed above)
    await recordPreMutation(p.target);
    try {
      await vscode.workspace.fs.createDirectory(vscode.Uri.joinPath(p.uri, '..'));
      await vscode.workspace.fs.writeFile(p.uri, new TextEncoder().encode(p.content));
    } catch (err: any) { results.push(`${p.target}: failed to write — ${err.message}`); continue; }
    results.push(`${p.existed ? 'Patched' : 'Created'} ${p.target} (${p.applied} hunk(s)).`);
  }

  invalidateRepoMap();
  invalidateStacks();
  return [...results, ...noops].join('\n');
}

const MAX_OUTPUT_CHARS = 20000;

// Soft-delete shim: overrides Remove-Item (and its aliases rm/del/rmdir/…) so
// the agent's deletes MOVE items into .codeflare-trash/<timestamp>/ instead of
// destroying them. Prepended to every PowerShell run_command, so "delete" is
// always recoverable — which is why Remove-Item can run without a prompt.
const REMOVE_SHIM =
  "function global:Remove-Item{[CmdletBinding()]param(" +
  "[Parameter(ValueFromPipeline=$true,ValueFromPipelineByPropertyName=$true,Position=0)][Alias('FullName','PSPath')][string[]]$Path," +
  "[Alias('LP')][string[]]$LiteralPath,[switch]$Recurse,[switch]$Force,[switch]$WhatIf,[switch]$Confirm," +
  "[string[]]$Include,[string[]]$Exclude,[string]$Filter,[Parameter(ValueFromRemainingArguments=$true)]$Rest) " +
  "begin{$__t=Join-Path (Join-Path (Get-Location).Path '.codeflare-trash') (Get-Date -Format 'yyyyMMdd-HHmmss')} " +
  "process{$__all=@();if($Path){$__all+=$Path};if($LiteralPath){$__all+=$LiteralPath};" +
  "foreach($__p in $__all){if(-not $__p){continue};" +
  "$__items=Get-Item -LiteralPath $__p -Force -ErrorAction SilentlyContinue;" +
  "if(-not $__items){$__items=Get-Item -Path $__p -Force -ErrorAction SilentlyContinue};" +
  "foreach($__it in $__items){if($__it.FullName -like (Join-Path (Get-Location).Path '.codeflare-trash*')){continue};" +
  "if(-not (Test-Path -LiteralPath $__t)){New-Item -ItemType Directory -Force -Path $__t | Out-Null};" +
  "$__d=Join-Path $__t $__it.Name;$__k=1;while(Test-Path -LiteralPath $__d){$__d=Join-Path $__t ($__it.Name+'_'+$__k);$__k++};" +
  "Move-Item -LiteralPath $__it.FullName -Destination $__d -Force -ErrorAction SilentlyContinue;" +
  "Write-Output ('archived (not deleted): '+$__it.FullName)}}}}";

/** Split a command line into segments on top-level &&, ||, &, ;, | — respecting quotes. */
function splitCommandLine(cmd: string): string[] {
  const parts: string[] = [];
  let cur = '';
  let quote: string | null = null;
  let braces = 0;
  for (let i = 0; i < cmd.length; i++) {
    const ch = cmd[i];
    if (quote) {
      cur += ch;
      if (ch === quote) { quote = null; }
      continue;
    }
    if (ch === '"' || ch === "'" || ch === '`') { quote = ch; cur += ch; continue; }
    // A { } script block (ForEach-Object { a; b }) is ONE argument — the
    // separators inside it belong to the block, not to the outer pipeline.
    if (ch === '{') { braces++; cur += ch; continue; }
    if (ch === '}') { braces = Math.max(0, braces - 1); cur += ch; continue; }
    if (braces > 0) { cur += ch; continue; }
    // A newline is a hard statement terminator (PowerShell runs each line), so
    // every line must be trust-checked on its own — otherwise a trusted first
    // line would whitelist arbitrary commands on the lines after it.
    if (ch === '\n' || ch === '\r') { parts.push(cur); cur = ''; continue; }
    if ((ch === '&' && cmd[i + 1] === '&') || (ch === '|' && cmd[i + 1] === '|')) {
      parts.push(cur); cur = ''; i++; continue;
    }
    // Single & = cmd-style unconditional chaining; treat like ;. But NOT when
    // it's part of a redirection like 2>&1 (& directly after >).
    if (ch === ';' || ch === '|' || (ch === '&' && cmd[i - 1] !== '>')) {
      parts.push(cur); cur = ''; continue;
    }
    cur += ch;
  }
  parts.push(cur);
  return parts.map(p => p.trim()).filter(Boolean);
}

/**
 * Windows PowerShell 5.1 doesn't support && / || / bare & (only PS7 adds the
 * first two; & is a parse error mid-line). Translate cmd-style chaining so the
 * model's commands work: A && B → A; if ($?) { B }, A || B → A; if (-not $?)
 * { B }, A & B → A; B. Quote-aware; leaves ; and | alone.
 */
function translateChaining(cmd: string): string {
  const parts: { op: string; seg: string }[] = [];
  let cur = '';
  let quote: string | null = null;
  let curOp = '';
  for (let i = 0; i < cmd.length; i++) {
    const ch = cmd[i];
    if (quote) { cur += ch; if (ch === quote) { quote = null; } continue; }
    if (ch === '"' || ch === "'" || ch === '`') { quote = ch; cur += ch; continue; }
    if (ch === '&' && cmd[i + 1] === '&') { parts.push({ op: curOp, seg: cur }); cur = ''; curOp = '&&'; i++; continue; }
    if (ch === '|' && cmd[i + 1] === '|') { parts.push({ op: curOp, seg: cur }); cur = ''; curOp = '||'; i++; continue; }
    // Redirections like 2>&1 keep their & (it follows >).
    if (ch === '&' && cmd[i - 1] !== '>') { parts.push({ op: curOp, seg: cur }); cur = ''; curOp = '&'; continue; }
    if (ch === ';' || ch === '\n' || ch === '\r') { parts.push({ op: curOp, seg: cur }); cur = ''; curOp = ';'; continue; }
    cur += ch;
  }
  parts.push({ op: curOp, seg: cur });

  // A trailing bash-style background '&' (op '&' with nothing after it) has no
  // PowerShell 5.1 equivalent — the shell rejects it outright. Server/persistent
  // commands already run detached in their own terminal, so backgrounding is
  // implicit: drop the operator instead of emitting a parse error.
  const trailingBg =
    parts.length > 1 &&
    parts[parts.length - 1].op === '&' &&
    parts[parts.length - 1].seg.trim() === '';

  const segs = parts.map(p => ({ op: p.op, seg: p.seg.trim() })).filter(p => p.seg.length);
  if (segs.length <= 1 || !segs.some(p => p.op === '&&' || p.op === '||' || p.op === '&')) {
    return trailingBg ? segs.map(p => p.seg).join('; ') : cmd;
  }

  let out = segs[0].seg;
  let braces = 0;
  for (let i = 1; i < segs.length; i++) {
    const { op, seg } = segs[i];
    if (op === '&&') { out += `; if ($?) { ${seg}`; braces++; }
    else if (op === '||') { out += `; if (-not $?) { ${seg}`; braces++; }
    else { out += `; ${seg}`; }
  }
  return out + ' }'.repeat(braces);
}

/**
 * PowerShell 5.1 has no Unix text utilities, but the model habitually pipes
 * through them. Translate the common ones to PowerShell equivalents:
 * | head [-n] N → | Select-Object -First N, | tail → -Last, | wc -l →
 * | Measure-Object -Line, | grep X → | Select-String X.
 */
function translateUnixPipes(cmd: string): string {
  return cmd
    // Piped forms: … | head -20
    .replace(/\|\s*head\s+(?:-n\s+)?-?(\d+)\b/gi, (_m, n) => `| Select-Object -First ${n}`)
    .replace(/\|\s*head\b(?!\S)/gi, '| Select-Object -First 10')
    .replace(/\|\s*tail\s+(?:-n\s+)?-?(\d+)\b/gi, (_m, n) => `| Select-Object -Last ${n}`)
    .replace(/\|\s*tail\b(?!\S)/gi, '| Select-Object -Last 10')
    .replace(/\|\s*wc\s+-l\b/gi, '| Measure-Object -Line')
    .replace(/\|\s*grep\s+(?:-i\s+)?/gi, '| Select-String ')
    // Standalone forms: wc -l file, head -20 file, grep pattern file
    .replace(/(^|[;&(]\s*)wc\s+-l\s+("[^"]+"|\S+)/gi,
      (_m, pre, f) => `${pre}Get-Content ${f} | Measure-Object -Line`)
    .replace(/(^|[;&(]\s*)head\s+(?:-n\s+)?-?(\d+)\s+("[^"]+"|\S+)/gi,
      (_m, pre, n, f) => `${pre}Get-Content ${f} -TotalCount ${n}`)
    .replace(/(^|[;&(]\s*)tail\s+(?:-n\s+)?-?(\d+)\s+("[^"]+"|\S+)/gi,
      (_m, pre, n, f) => `${pre}Get-Content ${f} -Tail ${n}`)
    .replace(/(^|[;&(]\s*)grep\s+(?:-i\s+)?/gi, '$1Select-String ')
    // cmd-style idioms: `timeout /t N [/nobreak]` is timeout.exe, which needs a
    // console and fails under exec ("input redirection is not supported") —
    // sleep instead. `>nul` / `2>nul` in PowerShell writes a FILE named "nul".
    .replace(/\btimeout\s+\/t\s+(\d+)(?:\s+\/nobreak)?/gi, 'Start-Sleep -Seconds $1')
    .replace(/\s2>\s*nul\b/gi, ' 2>$null')
    .replace(/\s>\s*nul\b/gi, ' | Out-Null')
    // cmd-style `mkdir a b c` creates ONE dir and errors in PowerShell — turn
    // the space-separated list into a comma array. Also strip the -p flag.
    .replace(/\bmkdir\s+-p\s+/gi, 'mkdir ')
    .replace(/(^|[;&(]\s*)mkdir\s+((?:[\w.:/\\-]+\s+)+[\w.:/\\-]+)(?!\S)/gi,
      (_m, pre, args) => `${pre}mkdir ${args.trim().split(/\s+/).join(',')}`);
}

/**
 * Trailing output redirections (2>&1, 2>$null, *>$null, >nul) don't change what
 * a command does — strip them so the command itself is judged. Without this,
 * `powershell -Command "…" 2>&1` never matches the wrapper pattern.
 */
function stripTrailingRedirects(seg: string): string {
  let s = seg.trim();
  for (;;) {
    const next = s.replace(/\s*[12*]?>>?\s*(?:&\d|\$null|nul)\s*$/i, '');
    if (next === s) { return s; }
    s = next;
  }
}

function stripWrappingQuotes(s: string): string {
  const t = s.trim();
  if (t.length >= 2 && (t[0] === '"' || t[0] === "'") && t[t.length - 1] === t[0]) {
    return t.slice(1, -1);
  }
  return t;
}

// PowerShell launcher with harmless flags (-NoProfile, -ExecutionPolicy X, …)
// before -Command — they don't change what runs. Captures the inner command.
const PS_WRAPPER_RE =
  /^(?:powershell|pwsh)(?:\.exe)?\s+(?:-(?:noprofile|nologo|noninteractive|noexit|mta|sta)\s+|-executionpolicy\s+\w+\s+|-windowstyle\s+\w+\s+)*(?:-c|-command)\s+([\s\S]+)$/i;

/** If the segment is a shell wrapper (cmd /c "…", powershell -c "…", bash -c "…"), return the inner command. */
function unwrapShell(segment: string): string | null {
  let m = segment.match(/^cmd(?:\.exe)?\s+(?:\/[dsq]\s+)*\/c\s+([\s\S]+)$/i);
  if (m) { return stripWrappingQuotes(m[1]); }
  m = segment.match(PS_WRAPPER_RE);
  if (m) { return stripWrappingQuotes(m[1]); }
  m = segment.match(/^(?:bash|sh)\s+-c\s+([\s\S]+)$/i);
  if (m) { return stripWrappingQuotes(m[1]); }
  // `start /b <cmd>` / `start <cmd>` — trust it based on what it launches.
  m = segment.match(/^start\s+\/b\s+([\s\S]+)$/i);
  if (m) { return m[1]; }
  m = segment.match(/^start\s+([\s\S]+)$/i);
  if (m) { return m[1]; }
  return null;
}

function segmentTrusted(segment: string, trusted: string[]): boolean {
  // A quoted executable PATH followed by args — `"C:\Program Files\Git\cmd\
  // curl.exe" -s …`, including the form reached via the `&` call operator
  // (splitCommandLine drops the leading &, leaving the quoted path). Judge it by
  // the executable's BASENAME so a full-path invocation inherits the trust of
  // the bare command (curl.exe). Without this, the generic stripWrappingQuotes
  // below peels the leading path-quote together with the trailing arg-quote and
  // mangles the whole segment. Only paths (containing a slash) qualify, so a
  // plain quoted string argument isn't mistaken for a command.
  const q = segment.trim().match(/^(["'])([^"']+)\1\s*([\s\S]*)$/);
  if (q && /[\\/]/.test(q[2])) {
    const base = q[2].split(/[\\/]/).pop() || q[2];
    return segmentTrusted(`${base} ${q[3]}`.trim(), trusted);
  }
  // cmd-style quoted segments ("mkdir a b") run the quoted command — judge it.
  let seg = stripWrappingQuotes(segment).toLowerCase();
  // A leading ( only groups a pipeline — judge what runs inside it.
  seg = seg.replace(/^[(\s]+/, '');
  // A variable assignment ($x = RHS, $env:FOO = RHS) EXECUTES its right-hand
  // side, so it must be judged by the RHS — not blanket-trusted just because it
  // starts with '$'. Strip the assignment prefix and let the rest of the
  // function judge the RHS (a command like "$x = Invoke-X" / "$o = ./evil.exe"
  // then flows through the path/trusted checks; a literal like "$x = 5" / '$x =
  // "s"' still hits the value-expression fast-path below and stays trusted).
  const assign = seg.match(/^\$\{?[\w:.]+\}?\s*=\s*(.+)$/);
  if (assign) { seg = assign[1].trim(); }
  // A leading .\ or ./ just runs an executable from the current dir — judge it
  // by the executable itself (so ".\Godot_v4.7.exe …" matches a trusted "godot_v*").
  seg = seg.replace(/^\.[\\/]/, '');
  // An explicit PATH to an executable (C:\tools\python.exe …, sub/dir/tool) is
  // judged by its basename, so a discovered/versioned binary invoked by full
  // path inherits the trust of its bare name. (Quoted paths are handled above.)
  const firstTok = seg.match(/^(\S+)/);
  if (firstTok && /[\\/]/.test(firstTok[1])) {
    const base = firstTok[1].split(/[\\/]/).pop() || firstTok[1];
    seg = (base + seg.slice(firstTok[1].length)).trim();
  }
  // Changing directory is harmless on its own.
  if (/^cd\s+\S/.test(seg) || seg === 'cd') { return true; }
  // Pure PowerShell expressions (string literals, $_ property access, numbers,
  // hashtables/[PSCustomObject]) are values, not command invocations — safe as
  // pipeline/loop-body pieces, PROVIDED nothing inside executes:
  // - static calls are allowed for constructors ([T]::new()) and read-only
  //   member/getter access ([T]::SHA1, [Dns]::GetHostAddresses()); only a static
  //   call to a destructive verb ([IO.File]::Delete(), [Process]::Start(),
  //   [ScriptBlock]::Create(), [Assembly]::Load()) is blocked — SAME verb list
  //   as the instance methods below, via the (?:\.|::) prefix;
  // - destructive/executing methods (.Delete(), .Invoke(), .Start(), …) are
  //   blocked; benign resource/timer-lifecycle calls (.Close(), .Open(),
  //   .Stop(), .Connect()) are allowed so cert/socket/stopwatch probes run
  //   unprompted;
  // - an embedded (Command …) group DOES execute — its leading word must
  //   itself be a trusted command or a language keyword.
  if (/^['"$\d@[]/.test(seg) &&
      !/(?:\.|::)(delete|kill|invoke|dispose|start|load\w*|create\w*|write\w*|move\w*|copy\w*|remove\w*|set\w*|add\w*)\s*\(/i.test(seg)) {
    const embedded = seg.match(/\(\s*[a-z][\w-]*/gi) || [];
    const embeddedOk = embedded.every(e => {
      const word = e.replace(/^\(\s*/, '').toLowerCase();
      if (/^(if|elseif|else|foreach|for|while|where|not|and|or)$/.test(word)) { return true; }
      return trusted.some(p => p.trim().toLowerCase() === word);
    });
    if (embeddedOk) { return true; }
  }
  return trusted.some(prefix => {
    const p = prefix.trim().toLowerCase();
    if (p.length === 0) { return false; }
    // A '*' makes the entry a glob — matches version-embedded executables that
    // have no clean word boundary, e.g. "godot_v*" → "godot_v4.7.1-stable….exe".
    if (p.includes('*')) {
      const re = new RegExp('^' + p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\\\*/g, '.*'));
      return re.test(seg);
    }
    if (seg === p || seg.startsWith(p + ' ')) { return true; }
    // Allow a non-word char right after the prefix, so a grouped pipeline like
    // "(... | measure-object).count" still matches "measure-object".
    return seg.startsWith(p) && /[^\w-]/.test(seg.charAt(p.length));
  });
}

/**
 * If the segment is a PowerShell conditional/loop (if/foreach/while …), return
 * the command(s) inside its { } block(s) so we can check those instead.
 */
function extractBlockBodies(segment: string): string[] | null {
  if (!/^\s*(if|elseif|else|foreach|for|while|where)\b/i.test(segment)) { return null; }
  // Balanced extraction of TOP-LEVEL { } bodies (quote-aware) — bodies often
  // contain nested braces (hashtables, inner if/else) that a flat regex chops.
  const bodies: string[] = [];
  let depth = 0;
  let start = -1;
  let quote: string | null = null;
  for (let i = 0; i < segment.length; i++) {
    const ch = segment[i];
    if (quote) { if (ch === quote) { quote = null; } continue; }
    if (ch === '"' || ch === "'") { quote = ch; continue; }
    if (ch === '{') {
      if (depth === 0) { start = i + 1; }
      depth++;
    } else if (ch === '}') {
      depth = Math.max(0, depth - 1);
      if (depth === 0 && start >= 0) {
        const body = segment.slice(start, i).trim();
        if (body) { bodies.push(body); }
        start = -1;
      }
    }
  }
  return bodies.length ? bodies : null;
}

/**
 * PowerShell expands $(…) subexpressions even inside double-quoted strings — an
 * innocent-looking `echo "$(anything)"` would execute `anything`. Instead of
 * blanket-blocking, judge what each subexpression actually runs: plain
 * variable/property interpolation ($_.Name, $file.FullName) is safe, anything
 * else must itself be a trusted command. Subexpressions inside single quotes
 * are ignored (PS does not expand there); an unbalanced $( refuses (safe side).
 */
function subexpressionsTrusted(cmd: string, trusted: string[], depth: number): boolean {
  let inSingle = false;
  for (let i = 0; i < cmd.length; i++) {
    const ch = cmd[i];
    if (ch === "'") { inSingle = !inSingle; continue; }
    if (inSingle || ch !== '$' || cmd[i + 1] !== '(') { continue; }
    // Balanced, quote-aware extraction of the body — they nest: $((Get-X).Count).
    let parens = 1;
    let quote: string | null = null;
    let j = i + 2;
    for (; j < cmd.length && parens > 0; j++) {
      const c = cmd[j];
      if (quote) { if (c === quote) { quote = null; } continue; }
      if (c === '"' || c === "'") { quote = c; continue; }
      if (c === '(') { parens++; }
      else if (c === ')') { parens--; }
    }
    if (parens > 0) { return false; }
    const inner = cmd.slice(i + 2, j - 1).trim();
    const isPropertyPath = /^\$\w+(\.\w+)*$/.test(inner);
    if (!isPropertyPath && !isTrustedCommand(inner, trusted, depth + 1)) { return false; }
    i = j - 1;
  }
  return true;
}

// Destructive operations that bypass the Remove-Item archive shim: interpreter
// one-liners and low-level APIs delete for real, so they always require the
// user's confirmation regardless of the trusted list.
const DESTRUCTIVE_RE = new RegExp(
  [
    'shutil\\s*\\.\\s*rmtree',
    'os\\s*\\.\\s*(remove|unlink|rmdir)',
    // Node fs deletion in any spelling (fs.rmSync, require("fs").rmSync, promises)
    '\\b(rmSync|rmdirSync|unlinkSync)\\b',
    'fs\\s*\\.\\s*(rm|unlink|rmdir)\\b',
    'promises\\s*\\.\\s*rm\\b',
    '\\brimraf\\b',
    '\\bmkfs',
    '\\bformat\\s+[a-z]:',
    '\\[System\\.IO\\.(File|Directory)\\]::Delete',
    '\\bClear-Content\\b',
    '\\bgit\\s+clean\\b',
    '\\bdiskpart\\b',
  ].join('|'),
  'i'
);

/**
 * A command is trusted only if EVERY chained segment is trusted (quote-aware).
 * Shell wrappers (cmd /c "…") and conditionals (if (…) { … }) are unwrapped and
 * their inner command is checked, so they're only as trusted as what they run.
 */
export function isTrustedCommand(command: string, trusted: string[], depth = 0): boolean {
  if (depth > 4) { return false; }
  // $() runs code even inside double-quoted strings — every subexpression must
  // itself be trusted (or be plain variable interpolation). Checked at every
  // depth so nested subexpressions can't smuggle execution.
  if (!subexpressionsTrusted(command, trusted, depth)) { return false; }
  if (depth === 0) {
    // Real deletions (not covered by the archive shim) always ask.
    if (DESTRUCTIVE_RE.test(command)) { return false; }
  }
  const segments = splitCommandLine(command.trim());
  if (segments.length === 0) { return false; }
  return segments.every(rawSeg => {
    const seg = stripTrailingRedirects(rawSeg);
    const inner = unwrapShell(seg);
    if (inner !== null) { return isTrustedCommand(inner, trusted, depth + 1); }
    const bodies = extractBlockBodies(seg);
    if (bodies !== null) { return bodies.every(b => isTrustedCommand(b, trusted, depth + 1)); }
    return segmentTrusted(seg, trusted);
  });
}

// Long-running / server / watch commands that must NOT be run through exec
// (which waits for exit) — they run in a persistent terminal instead.
const SERVER_RE = /(https?\.server|http\.server|-m\s+http\.server|http-server|live-?server|\bserver\.(py|js|mjs|cjs)\b|--port\b|npm\s+(start|run\s+(dev|serve|watch|start))|\byarn\s+(dev|start|serve)\b|pnpm\s+(dev|start|serve)|\bvite\b|next\s+dev|nuxt\s+dev|uvicorn\b|gunicorn\b|flask\s+run|nodemon\b|--watch\b|Start-Process|start\s+\/b)/i;

// ── Dev-server lifecycle ─────────────────────────────────────────
// Servers the agent starts keep running invisibly and pile up: stray python/
// node processes holding ports and directories. Track them per port and kill
// them when replaced, when their max lifetime expires, and on demand.
const runningServers = new Map<number, { command: string; startedAt: number; timer?: ReturnType<typeof setTimeout> }>();

function killPort(port: number, reason: string): void {
  const entry = runningServers.get(port);
  if (entry?.timer) { clearTimeout(entry.timer); }
  runningServers.delete(port);
  if (process.platform === 'win32') {
    const ps = `Get-NetTCPConnection -LocalPort ${port} -State Listen -ErrorAction SilentlyContinue | ` +
      `Select-Object -ExpandProperty OwningProcess -Unique | ` +
      `ForEach-Object { Stop-Process -Id $_ -Force -ErrorAction SilentlyContinue }`;
    execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ps], { windowsHide: true },
      () => log(`Stopped server on port ${port} (${reason})`));
  } else {
    exec(`lsof -ti tcp:${port} | xargs -r kill -9`,
      () => log(`Stopped server on port ${port} (${reason})`));
  }
}

/**
 * Shell one-liner that kills whatever is listening on `port` and then waits
 * (up to ~2s) for the OS to release it. Sent to the CodeFlare terminal right
 * before a server launches so the kill is strictly ordered before the bind —
 * unlike the async killPort(), which spawns an external process that can still
 * be running when the new server tries to bind (→ WinError 10013). A fast
 * no-op when the port is already free.
 */
function freePortCmd(port: number): string {
  if (process.platform === 'win32') {
    return `$__p=${port}; ` +
      `Get-NetTCPConnection -LocalPort $__p -State Listen -ErrorAction SilentlyContinue | ` +
      `Select-Object -ExpandProperty OwningProcess -Unique | ` +
      `ForEach-Object { Stop-Process -Id $_ -Force -ErrorAction SilentlyContinue }; ` +
      `for ($__i=0; $__i -lt 20 -and ` +
      `(Get-NetTCPConnection -LocalPort $__p -State Listen -ErrorAction SilentlyContinue); ` +
      `$__i++) { Start-Sleep -Milliseconds 100 }`;
  }
  return `for __i in $(seq 1 20); do ` +
    `__pids=$(lsof -ti tcp:${port} 2>/dev/null); ` +
    `[ -z "$__pids" ] && break; ` +
    `echo "$__pids" | xargs -r kill -9 2>/dev/null; sleep 0.1; done`;
}

/** Kill every dev server the agent started. Returns how many were tracked. */
export function stopAllServers(reason = 'stopped by user'): number {
  const ports = [...runningServers.keys()];
  for (const p of ports) { killPort(p, reason); }
  return ports.length;
}

// ── Terminal output capture ──────────────────────────────────────
// Ring buffer of recent CodeFlare-terminal output so the model can read
// server logs (read_terminal_output). Fed by VSCode's shell-integration
// events (1.93+); on older builds capture is simply unavailable.
const terminalLog: string[] = [];
const TERMINAL_LOG_MAX = 400;
let terminalCaptureActive = false;

function appendTerminalLog(text: string): void {
  // Strip ANSI escapes (colors, cursor moves) and OSC title sequences.
  const clean = text
    .replace(/\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)/g, '')
    .replace(/\u001b\[[0-9;?]*[A-Za-z]/g, '')
    .replace(/\r/g, '');
  for (const line of clean.split('\n')) {
    if (line.trim()) { terminalLog.push(line); }
  }
  if (terminalLog.length > TERMINAL_LOG_MAX) {
    terminalLog.splice(0, terminalLog.length - TERMINAL_LOG_MAX);
  }
}

/** Start capturing output of CodeFlare terminals. Called once on activation. */
export function initTerminalCapture(context: vscode.ExtensionContext): void {
  const onStart = (vscode.window as any).onDidStartTerminalShellExecution;
  if (typeof onStart !== 'function') {
    log('Terminal capture unavailable (VSCode < 1.93)');
    return;
  }
  context.subscriptions.push(onStart(async (e: any) => {
    if (!e.terminal?.name?.startsWith('CodeFlare')) { return; }
    terminalCaptureActive = true;
    try {
      appendTerminalLog(`$ ${e.execution?.commandLine?.value ?? ''}`);
      for await (const chunk of e.execution.read()) {
        appendTerminalLog(String(chunk));
      }
    } catch { /* terminal closed mid-read — fine */ }
  }));
}

/** Raw captured terminal lines — probes scan these for stdout-only reports. */
export function getTerminalLogLines(): string[] {
  return terminalLog;
}

function readTerminalOutput(lines: number): string {
  const n = Math.max(1, Math.min(200, Math.floor(lines) || 60));
  if (terminalLog.length === 0) {
    return terminalCaptureActive
      ? 'The CodeFlare terminal has produced no output yet.'
      : 'No terminal output captured. Either nothing ran in the CodeFlare terminal yet, ' +
        'or shell integration is not active in it (output capture then does not work).';
  }
  const slice = terminalLog.slice(-n);
  return `Last ${slice.length} line(s) of the CodeFlare terminal:\n${slice.join('\n')}`;
}

/** Run a persistent/server command in a VSCode terminal and return immediately. */
function runInTerminal(command: string, cwd: string): string {
  // Strip cmd-style launchers; the terminal runs the process directly.
  let clean = command.replace(/^\s*start\s+\/b\s+/i, '').replace(/^\s*start\s+/i, '').trim();

  // `python -m http.server` can bind IPv6-only ("Serving HTTP on ::"), making
  // an IPv4 health check (curl 127.0.0.1) fail even though the server runs.
  // Pin it to IPv4 so the server and its checks always agree. This must run
  // BEFORE the chaining translation below: that wraps segments in `if ($?) { … }`,
  // and injecting after it would drop the flag outside the closing brace
  // (`… 8080 } --bind …` — a parse error). Also stop at `}` for safety.
  if (/python\S*\s+-m\s+http\.server\b/i.test(clean) && !/--bind\b/i.test(clean)) {
    clean = clean.replace(/(-m\s+http\.server\b[^;|&(){}]*)/i, '$1 --bind 127.0.0.1');
  }

  // The terminal on Windows is PowerShell, and 5.1 rejects && / || / bare & —
  // apply the same chaining + Unix-pipe translations the exec path uses.
  if (process.platform === 'win32') { clean = translateChaining(translateUnixPipes(clean)); }

  // Port detection: explicit flags/markers first (--port=3000, -l 8080, :5173),
  // then a bare positional port (python -m http.server 8200, npx serve 8080).
  // The positional fallback only accepts a STANDALONE numeric token whose
  // preceding token is not an option flag — so a numeric flag VALUE like
  // `--max-old-space-size=4096` (one token, not pure digits) or `-p 9229` for a
  // non-port flag is never mistaken for a port and its process wrongly killed.
  let port: number | undefined;
  const explicit = clean.match(/(?:--port|\b-p|\b-l|:)\s*=?\s*(\d{2,5})\b/i);
  if (explicit) {
    port = Number(explicit[1]);
  } else {
    const toks = clean.split(/\s+/);
    for (let i = 0; i < toks.length; i++) {
      if (/^\d{4,5}$/.test(toks[i]) && !(toks[i - 1] || '').startsWith('-')) {
        port = Number(toks[i]);
        break;
      }
    }
  }
  const lifeMin = getConfig().serverMaxLifetime;
  if (port !== undefined) {
    // A previous server may still hold this port. Clear any tracked entry's
    // lifetime timer so it can't later kill the replacement; the port itself is
    // freed IN THE TERMINAL just before launch (below). Freeing there — rather
    // than via an async external Stop-Process here — keeps the kill strictly
    // ordered before the bind. The old code raced them: term.sendText launched
    // the new server while killPort's powershell.exe was still spawning, so the
    // bind hit a port still held by the old socket → WinError 10013 (WSAEACCES,
    // Windows' "access denied" for a port in use). The in-terminal free also
    // catches untracked leftovers (e.g. a server left over from before a window
    // reload) that runningServers never knew about.
    const prev = runningServers.get(port);
    if (prev?.timer) { clearTimeout(prev.timer); }
    const entry: { command: string; startedAt: number; timer?: ReturnType<typeof setTimeout> } =
      { command: clean, startedAt: Date.now() };
    if (lifeMin > 0) {
      entry.timer = setTimeout(
        () => killPort(port, `max lifetime of ${lifeMin} min reached (codeflare.serverMaxLifetime)`),
        lifeMin * 60_000
      );
    }
    runningServers.set(port, entry);
  }

  let term = vscode.window.terminals.find(t => t.name === 'CodeFlare');
  if (!term) { term = vscode.window.createTerminal({ name: 'CodeFlare', cwd }); }
  term.show(true);
  // The terminal persists across runs and commands cd around in it — its cwd
  // is unpredictable on reuse. Reset to the workspace root first so relative
  // paths in this command resolve where the model expects them to.
  if (process.platform === 'win32') {
    term.sendText(`Set-Location -LiteralPath '${cwd.replace(/'/g, "''")}'`);
  } else {
    term.sendText(`cd '${cwd.replace(/'/g, "'\\''")}'`);
  }
  // Free the port (and wait for release) in-shell, immediately before the
  // server starts, so the bind can never race a still-closing predecessor.
  // No-op when the port is already free.
  if (port !== undefined) { term.sendText(freePortCmd(port)); }
  term.sendText(clean);
  log(`Agent started (terminal): ${clean}${port !== undefined ? ` [port ${port}${lifeMin > 0 ? `, auto-stop after ${lifeMin} min` : ''}]` : ''}`);
  return `Started in the CodeFlare terminal (persistent — it keeps running): ${clean}\n` +
    (port !== undefined ? `Open http://localhost:${port} in a browser to view it. ` : '') +
    (port !== undefined && lifeMin > 0 ? `It is stopped automatically after ${lifeMin} minutes. ` : '') +
    `Do not wait for it to finish; it runs in the background.`;
}

async function runCommand(command: string): Promise<string> {
  const config = getConfig();
  if (!config.agentRunCommands) { return 'Running commands is disabled (codeflare.agentRunCommands is off).'; }
  if (!command.trim()) { return 'Empty command.'; }

  // On Windows the command already runs inside PowerShell — a nested
  // `powershell -Command "…"` makes the OUTER shell expand $_ / $vars inside
  // the double quotes before the inner shell ever sees them, mangling pipeline
  // variables ("$($_.Name)" arrives as "(.Name)"). Unwrap a single wrapper and
  // run the inner command directly. (Only when the wrapper is the whole
  // command — chained segments keep their own semantics.)
  if (process.platform === 'win32') {
    const segs = splitCommandLine(command.trim());
    const m = segs.length === 1 ? stripTrailingRedirects(command).match(PS_WRAPPER_RE) : null;
    if (m) {
      // Models write cmd-style \" escapes inside the wrapped string; PowerShell
      // itself escapes with backticks, so after unwrapping they'd be stray
      // backslashes — restore plain quotes.
      command = stripWrappingQuotes(m[1]).replace(/\\"/g, '"');
      log(`Unwrapped nested powershell -Command: ${command.slice(0, 200)}`);
    }
  }

  const root = workspaceRoot();
  if (!root) { return 'No workspace folder is open.'; }

  // Deterministic policy: autonomous profiles refuse publish/deploy/push/
  // history-rewrite/dependency-install commands outright — the trust list and
  // the prompt below are interactive concepts.
  const cmdVerdict = gateCommand(command);
  if (!cmdVerdict.allowed) {
    log(`Policy blocked command: ${command.slice(0, 200)} (${cmdVerdict.code})`);
    return policyMessage(cmdVerdict);
  }

  // Trusted (safe) commands skip the confirmation prompt. Discovered executables
  // (via find_executable / remembered) are trusted too.
  if (config.confirmCommands &&
      !isTrustedCommand(command, [...config.trustedCommands, ...trustedExecutables()])) {
    // In an autonomous profile nobody is watching a modal — an untrusted
    // command is refused, never silently waited on.
    if (!canPrompt()) {
      log(`Policy refused untrusted command in autonomous mode: ${command.slice(0, 200)}`);
      return `POLICY COMMAND_BLOCKED: "${command.slice(0, 120)}" is not on the trusted list and ` +
        `autonomous mode cannot ask for confirmation. Use a trusted command or report why it is needed.`;
    }
    // A modal easily goes unnoticed — leave a trail so a copy-log taken while
    // "frozen" shows the agent is simply waiting on the user's confirmation.
    log(`Awaiting user confirmation (modal dialog) for command: ${command.slice(0, 200)}`);
    const ok = await vscode.window.showWarningMessage(
      `Run this command?\n\n${command}`, { modal: true }, 'Run'
    );
    log(ok === 'Run' ? 'User confirmed the command' : 'User declined the command');
    if (ok !== 'Run') { return `User declined to run: ${command}`; }
  }

  // Servers/watchers never exit — run them in a persistent terminal, not exec.
  if (SERVER_RE.test(command)) {
    return runInTerminal(command, root.fsPath);
  }

  log(`Agent runs command: ${command}`);
  // Installs/downloads (npm i, pip install, playwright's browser download) can
  // legitimately take minutes — give them at least 5, whatever the config says.
  const isInstall = /\b(?:install|ci)\b/i.test(command);
  const timeoutMs = isInstall ? Math.max(config.commandTimeout, 300000) : config.commandTimeout;
  const options = {
    cwd: root.fsPath,
    timeout: timeoutMs,
    maxBuffer: 10 * 1024 * 1024,
    windowsHide: true,
  };

  return new Promise<string>((resolve) => {
    const handle = (error: any, stdout: string, stderr: string) => {
      const code = error && typeof error.code === 'number' ? error.code : (error ? 1 : 0);
      const killed = error && error.killed;
      const clip = (s: string) =>
        s.length > MAX_OUTPUT_CHARS ? s.slice(0, MAX_OUTPUT_CHARS) + '\n… (output truncated)' : s;

      let out = `$ ${command}\nExit code: ${code}`;
      if (killed) { out += ` (timed out after ${timeoutMs}ms)`; }
      if (stdout && stdout.trim()) { out += `\n--- stdout ---\n${clip(stdout.trimEnd())}`; }
      if (stderr && stderr.trim()) { out += `\n--- stderr ---\n${clip(stderr.trimEnd())}`; }
      if ((!stdout || !stdout.trim()) && (!stderr || !stderr.trim())) { out += '\n(no output)'; }
      log(`Command exited ${code}`);
      resolve(out);
    };

    if (process.platform === 'win32') {
      // The model writes PowerShell-style commands (2>$null, Test-Path, cmdlets),
      // but Node's exec would run them through cmd.exe — which creates a "$null"
      // file and mangles cmdlets. Run through PowerShell instead, passing the
      // command base64-encoded to avoid any quoting problems.
      // PowerShell aliases curl to Invoke-WebRequest, which chokes on real curl
      // flags (-s -o -w). Point the alias at the real curl.exe instead. (Not
      // via Remove-Item — our trash shim overrides that cmdlet.)
      const unalias = "Set-Alias -Name curl -Value curl.exe -Option AllScope -Force;";
      const wrapped = `${REMOVE_SHIM}\n${unalias}\n$ProgressPreference='SilentlyContinue';\n${translateChaining(translateUnixPipes(command))}`;
      const encoded = Buffer.from(wrapped, 'utf16le').toString('base64');
      execFile('powershell.exe',
        ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encoded],
        options, handle);
    } else {
      exec(command, options, handle);
    }
  });
}

/**
 * Run a verification command (typecheck/tests) WITHOUT the model and without a
 * confirmation prompt — it's the verify gate, driven by config the user set.
 * Returns the exit status and clipped output for feedback. Never throws.
 */
export function runVerifyCommand(command: string, timeoutMs: number): Promise<{ ok: boolean; output: string }> {
  const root = workspaceRoot();
  if (!root) { return Promise.resolve({ ok: true, output: 'No workspace folder is open.' }); }

  const options = { cwd: root.fsPath, timeout: timeoutMs, maxBuffer: 10 * 1024 * 1024, windowsHide: true };
  return new Promise((resolve) => {
    const handle = (error: any, stdout: string, stderr: string) => {
      const code = error && typeof error.code === 'number' ? error.code : (error ? 1 : 0);
      const killed = error && error.killed;
      const clip = (s: string) =>
        s.length > MAX_OUTPUT_CHARS ? s.slice(0, MAX_OUTPUT_CHARS) + '\n… (output truncated)' : s;
      let out = `$ ${command}\nExit code: ${code}`;
      if (killed) { out += ` (timed out after ${timeoutMs}ms)`; }
      if (stdout && stdout.trim()) { out += `\n--- stdout ---\n${clip(stdout.trimEnd())}`; }
      if (stderr && stderr.trim()) { out += `\n--- stderr ---\n${clip(stderr.trimEnd())}`; }
      resolve({ ok: code === 0 && !killed, output: out });
    };
    if (process.platform === 'win32') {
      const unalias = "Set-Alias -Name curl -Value curl.exe -Option AllScope -Force;";
      const wrapped = `${REMOVE_SHIM}\n${unalias}\n$ProgressPreference='SilentlyContinue';\n${translateChaining(translateUnixPipes(command))}`;
      const encoded = Buffer.from(wrapped, 'utf16le').toString('base64');
      execFile('powershell.exe',
        ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encoded],
        options, handle);
    } else {
      exec(command, options, handle);
    }
  });
}

function findSpec(name: string): ToolSpec | undefined {
  return REGISTRY.find(s => s.def.function.name === name);
}

/**
 * Execute a tool call by name via its registry handler. `rawArgs` is the JSON
 * string the model produced. Always resolves to a string (never throws) so the
 * loop can feed it back. Tools with no handler (update_todos, run_subagent) are
 * dispatched by the provider and never reach here.
 */
export async function executeTool(name: string, rawArgs: string): Promise<string> {
  const spec = findSpec(name);
  if (!spec || !spec.handler) { return `Unknown tool: ${name}`; }

  let args: any = {};
  try {
    args = rawArgs ? JSON.parse(rawArgs) : {};
  } catch {
    return `Invalid JSON arguments for ${name}: ${rawArgs}`;
  }

  // Never log a credential: api_store_key's arguments carry the raw key.
  log(name === 'api_store_key' ? `Tool call: ${name}(…)` : `Tool call: ${name}(${rawArgs})`);
  try {
    return await spec.handler(args);
  } catch (err: any) {
    return `Tool ${name} failed: ${err.message}`;
  }
}

/** Short human-readable summary of a tool call for the chat UI. */
export function describeToolCall(name: string, rawArgs: string): string {
  let args: any = {};
  try { args = rawArgs ? JSON.parse(rawArgs) : {}; } catch { /* ignore */ }
  const spec = findSpec(name);
  return spec ? spec.describe(args) : `${name}(${rawArgs})`;
}

/** The raw command of a run_command call, so the UI can offer copy-to-clipboard. */
export function copyableCommand(name: string, rawArgs: string): string | undefined {
  const spec = findSpec(name);
  if (!spec?.copyable) { return undefined; }
  try { return spec.copyable(JSON.parse(rawArgs || '{}')); } catch { return undefined; }
}
