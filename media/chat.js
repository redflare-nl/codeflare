// CodeFlare Chat Webview Frontend Script
(function () {
  // @ts-ignore
  const vscode = acquireVsCodeApi();

  const messagesEl = document.getElementById('messages');
  const inputEl = document.getElementById('user-input');
  const sendBtn = document.getElementById('send-btn');
  const stopBtn = document.getElementById('stop-btn');
  const clearBtn = document.getElementById('clear-btn');
  const configBtn = document.getElementById('config-btn');
  const configOverlay = document.getElementById('config-overlay');
  const endpointLabel = document.getElementById('endpoint-label');
  const attachmentsEl = document.getElementById('attachments');
  const attachBtn = document.getElementById('attach-btn');
  const fileInput = document.getElementById('file-input');

  // Pending attachments to send with the next message.
  let pendingImages = []; // data URLs
  let pendingFiles = [];   // { name, content } text files

  const MAX_TEXT_CHARS = 200 * 1024;

  let isStreaming = false;
  let currentBubble = null;
  let currentContent = '';
  let thinkContent = '';

  // ── Markdown rendering ──────────────────────────────

  function escapeHtml(str) {
    return str.replace(/[&<>"']/g, m => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    })[m]);
  }

  function renderMarkdown(text) {
    // Fix incomplete code blocks
    const openingBackticks = (text.match(/```/g) || []).length;
    if (openingBackticks % 2 !== 0) {
      text += '\n```';
    }

    // Extract code blocks
    const codeBlocks = [];
    text = text.replace(/```(\w+)?\n([\s\S]*?)```/g, (match, lang, code) => {
      const placeholder = `__CODE_BLOCK_${codeBlocks.length}__`;
      codeBlocks.push({ lang: lang || 'plaintext', code });
      return placeholder;
    });

    // Extract inline code
    const inlineCodes = [];
    text = text.replace(/`([^`]+)`/g, (match, code) => {
      const placeholder = `__INLINE_CODE_${inlineCodes.length}__`;
      inlineCodes.push(code);
      return placeholder;
    });

    // Escape HTML
    text = escapeHtml(text);

    // Block elements, line by line — headers, horizontal rules (---), and
    // bullet/numbered lists. Done BEFORE inline formatting so a list's "*"
    // bullet is consumed here and never mistaken for italic emphasis. Without
    // this the structured output the model now produces (reviews with "---"
    // separators and "- " lists, headings) renders as literal markdown text.
    {
      const lines = text.split('\n');
      const out = [];
      let inList = null; // 'ul' | 'ol'
      const closeList = () => { if (inList) { out.push('</' + inList + '>'); inList = null; } };
      for (const line of lines) {
        const t = line.trim();
        if (/^(-{3,}|\*{3,}|_{3,})$/.test(t)) { closeList(); out.push('<hr>'); continue; }
        const h = t.match(/^(#{1,6})\s+(.+)$/);
        if (h) { closeList(); const lvl = Math.min(h[1].length + 2, 6); out.push('<h' + lvl + '>' + h[2] + '</h' + lvl + '>'); continue; }
        const ul = line.match(/^\s*[-*+]\s+(.+)$/);
        if (ul) { if (inList !== 'ul') { closeList(); out.push('<ul>'); inList = 'ul'; } out.push('<li>' + ul[1] + '</li>'); continue; }
        const ol = line.match(/^\s*\d+[.)]\s+(.+)$/);
        if (ol) { if (inList !== 'ol') { closeList(); out.push('<ol>'); inList = 'ol'; } out.push('<li>' + ol[1] + '</li>'); continue; }
        closeList();
        out.push(line);
      }
      closeList();
      text = out.join('\n');
    }

    // Inline formatting (after block processing, so list bullets aren't touched).
    text = text.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
    text = text.replace(/\*(.+?)\*/g, '<em>$1</em>');

    // Links: markdown [text](url) first, then bare URLs (clicking an anchor in
    // a VSCode webview opens the system browser automatically). Trailing
    // sentence punctuation stays outside the link.
    text = text.replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, '<a href="$2">$1</a>');
    text = text.replace(/(^|[\s(])(https?:\/\/[^\s<]+?)([.,;:!?)]*)(?=\s|$)/g,
      (m, pre, url, trail) => `${pre}<a href="${url}">${url}</a>${trail}`);

    // Newlines → <br>, but not adjacent to block tags (they already break).
    text = text.replace(/\n/g, '<br>');
    text = text
      .replace(/<br>\s*(<\/?(?:h[1-6]|hr|ul|ol|li)\b[^>]*>)/g, '$1')
      .replace(/(<\/?(?:h[1-6]|hr|ul|ol|li)\b[^>]*>)\s*<br>/g, '$1');

    // Restore inline codes
    inlineCodes.forEach((code, i) => {
      text = text.replace(`__INLINE_CODE_${i}__`, `<code>${escapeHtml(code)}</code>`);
    });

    // Restore code blocks with headers
    codeBlocks.forEach((block, i) => {
      const escaped = escapeHtml(block.code);
      const lineCount = block.code.split('\n').length;
      const isLargeBlock = lineCount > 20;
      const isShell = ['bash', 'sh', 'shell', 'cmd', 'powershell', 'ps1'].includes(block.lang);
      const runBtn = isShell
        ? `<button class="action-btn run-btn" data-code="${encodeURIComponent(block.code)}">Run</button>`
        : '';
      const insertBtn = `<button class="action-btn insert-btn" data-code="${encodeURIComponent(block.code)}">Insert</button>`;
      const copyBtn = `<button class="action-btn copy-btn" data-code="${encodeURIComponent(block.code)}">Copy</button>`;

      // Large code blocks get collapsed with a warning
      const collapseClass = isLargeBlock ? ' collapsed' : '';
      const warningHtml = isLargeBlock
        ? `<div class="code-dump-warning">Full code block (${lineCount} lines) — click to expand. Use "Replace" to apply to file.</div>`
        : '';

      text = text.replace(`__CODE_BLOCK_${i}__`,
        `<div class="code-block-wrapper${collapseClass}">
          <div class="code-header">
            <span class="lang-badge">${block.lang}${isLargeBlock ? ` (${lineCount} lines)` : ''}</span>
            <div class="actions">
              ${copyBtn}
              ${insertBtn}
              <button class="action-btn replace-btn" data-code="${encodeURIComponent(block.code)}">Replace</button>
              ${runBtn}
            </div>
          </div>
          ${warningHtml}
          <pre><code class="language-${block.lang}">${escaped}</code></pre>
        </div>`);
    });

    return text;
  }

  // ── SEARCH/REPLACE block rendering (Claude-style) ──

  function renderEditBlocks(text) {
    const editRegex = /<<<<<<< SEARCH\n([\s\S]*?)\n=======\n([\s\S]*?)\n>>>>>>> REPLACE/g;
    let editIndex = 0;
    const edits = [];

    // Collect all edit blocks
    let match;
    while ((match = editRegex.exec(text)) !== null) {
      edits.push({ full: match[0], search: match[1], replace: match[2] });
    }

    if (edits.length === 0) return text;

    // Strip all raw SEARCH/REPLACE text from the display
    let cleaned = text;
    for (const edit of edits) {
      cleaned = cleaned.replace(edit.full, '');
    }
    // Clean up excess whitespace/linebreaks left behind
    cleaned = cleaned.replace(/(<br\s*\/?>){3,}/gi, '<br><br>').trim();

    // Build compact diff blocks
    let diffHtml = '';

    if (edits.length > 1) {
      diffHtml += `<div class="edit-toolbar">
        <span class="edit-count">${edits.length} edits</span>
        <button class="edit-apply-all-btn">Apply All</button>
      </div>`;
    }

    for (const edit of edits) {
      const id = `edit-${Date.now()}-${editIndex++}`;
      const searchLines = edit.search.split('\n');
      const replaceLines = edit.replace.split('\n');

      // Build inline diff lines
      let diffLines = '';

      // Simple diff: show removed lines (red) then added lines (green)
      for (const line of searchLines) {
        diffLines += `<div class="diff-line diff-removed"><span class="diff-marker">-</span>${escapeHtml(line)}</div>`;
      }
      for (const line of replaceLines) {
        diffLines += `<div class="diff-line diff-added"><span class="diff-marker">+</span>${escapeHtml(line)}</div>`;
      }

      const previewLine = searchLines[0].trim().substring(0, 50);

      diffHtml += `<div class="edit-block" id="${id}">
        <div class="edit-header">
          <div class="edit-header-left">
            <span class="edit-icon">&#9998;</span>
            <span class="edit-summary">${escapeHtml(previewLine)}${previewLine.length >= 50 ? '...' : ''}</span>
          </div>
          <div class="edit-header-right">
            <button class="edit-toggle-btn" title="Toggle diff">&#9660;</button>
            <button class="edit-apply-btn" data-search="${encodeURIComponent(edit.search)}" data-replace="${encodeURIComponent(edit.replace)}">Apply</button>
          </div>
        </div>
        <div class="edit-diff">${diffLines}</div>
      </div>`;
    }

    return cleaned + diffHtml;
  }

  // ── Think tag processing ────────────────────────────

  // `live` marks a still-streaming think block: the ribbon gets a spinner,
  // shimmer and cursor, and the preview shows the TAIL of the thought stream
  // (scrolling by like terminal output) instead of the frozen first line.
  function processThinkTags(html, live) {
    const patterns = [
      /&lt;think&gt;([\s\S]*?)&lt;\/think&gt;/gi,
      /<think>([\s\S]*?)<\/think>/gi,
    ];

    // renderMarkdown already HTML-escaped the text, so the captured content
    // carries entities (&#39;, &lt;…). Decode them before re-escaping below —
    // otherwise the ribbon (and the copied log) shows literal "&#39;".
    const decodeEntities = (s) => {
      const t = document.createElement('textarea');
      t.innerHTML = s;
      return t.value;
    };

    for (const pattern of patterns) {
      html = html.replace(pattern, (match, content) => {
        const clean = decodeEntities(content.replace(/<[^>]*>/g, '')).trim();
        const oneLine = clean.replace(/\s+/g, ' ');
        const preview = live
          ? oneLine.slice(-110)
          : oneLine.slice(0, 100) + (oneLine.length > 100 ? '...' : '');
        return `<div class="think-ribbon${live ? ' live' : ''}">
          <div class="think-header">
            <span class="think-icon">${live ? '' : '&#9654;'}</span>
            <span class="think-label">THINKING</span>
            <span class="think-preview">${escapeHtml(preview)}</span>
          </div>
          <div class="think-content">${escapeHtml(clean)}</div>
        </div>`;
      });
    }

    return html;
  }

  // ── Message rendering ───────────────────────────────

  function addMessage(role, content) {
    const bubble = document.createElement('div');
    bubble.className = `bubble ${role}`;

    const meta = document.createElement('div');
    meta.className = 'meta';

    const roleSpan = document.createElement('span');
    roleSpan.className = 'role';
    roleSpan.textContent = role === 'user' ? 'You' : 'CodeFlare';
    meta.appendChild(roleSpan);

    const time = document.createElement('span');
    time.textContent = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    meta.appendChild(time);

    bubble.appendChild(meta);

    const body = document.createElement('div');
    body.className = 'body';

    let html = renderMarkdown(content);
    html = renderEditBlocks(html);
    html = processThinkTags(html);
    body.innerHTML = html;

    bubble.appendChild(body);
    messagesEl.appendChild(bubble);
    attachCodeActions(body);
    scrollToBottom();

    return bubble;
  }

  // Render a block of generated images produced by the agent.
  function addImageBlock(images) {
    if (!images || images.length === 0) return;
    const bubble = document.createElement('div');
    bubble.className = 'bubble assistant';

    const meta = document.createElement('div');
    meta.className = 'meta';
    const roleSpan = document.createElement('span');
    roleSpan.className = 'role';
    roleSpan.textContent = 'CodeFlare';
    meta.appendChild(roleSpan);
    bubble.appendChild(meta);

    const body = document.createElement('div');
    body.className = 'body';
    const wrap = document.createElement('div');
    wrap.className = 'message-images';
    images.forEach(im => {
      const img = document.createElement('img');
      img.src = im.url;
      img.className = 'message-image';
      img.title = im.name || '';
      wrap.appendChild(img);
    });
    body.appendChild(wrap);
    bubble.appendChild(body);
    messagesEl.appendChild(bubble);
    scrollToBottom();
  }

  // ── Todo / plan panel ───────────────────────────────
  let todoEl = null;
  let todoCollapsed = false;
  let lastTodos = [];

  function countLeaves(todos) {
    let total = 0, done = 0;
    for (const t of todos) {
      if (t.subtasks && t.subtasks.length) {
        const c = countLeaves(t.subtasks);
        total += c.total; done += c.done;
      } else {
        total++;
        if (t.status === 'completed') done++;
      }
    }
    return { total, done };
  }

  function renderTodoItems(todos, depth) {
    let html = '';
    // Tidy display: unfinished items first (in plan order), completed at the
    // bottom — so the list doesn't look scrambled as files finish out of order.
    const ordered = [
      ...todos.filter(t => t.status !== 'completed'),
      ...todos.filter(t => t.status === 'completed'),
    ];
    for (const t of ordered) {
      const icon = t.status === 'completed' ? '&#10003;'
        : t.status === 'in_progress' ? '&#9654;' : '&#9675;';
      html += `<div class="todo-item status-${t.status}" style="padding-left:${depth * 16}px">` +
        `<span class="todo-check">${icon}</span>` +
        `<span class="todo-text">${escapeHtml(t.content)}</span></div>`;
      if (t.subtasks && t.subtasks.length) {
        html += renderTodoItems(t.subtasks, depth + 1);
      }
    }
    return html;
  }

  function renderTodos(todos) {
    lastTodos = todos || [];
    if (!todos || todos.length === 0) {
      if (todoEl) { todoEl.remove(); todoEl = null; }
      return;
    }
    // Floating overlay pinned to the top-right of the plugin window: the chat
    // scrolls underneath it, it never moves, and it never yanks the scroll.
    if (!todoEl || !todoEl.isConnected) {
      todoEl = document.createElement('div');
      todoEl.className = 'todo-panel';
      document.body.appendChild(todoEl);
    }
    const { total, done } = countLeaves(todos);
    const pct = total ? Math.round((done / total) * 100) : 0;
    // A finished plan shows its 100% state briefly, then fades away — done is
    // done, the pill shouldn't keep occupying the corner.
    const finished = total > 0 && done === total;
    todoEl.classList.toggle('done', finished);
    if (finished && !todoEl._hideTimer) {
      const el = todoEl;
      el._hideTimer = setTimeout(() => {
        el.remove();
        if (todoEl === el) { todoEl = null; }
      }, 5000);
    } else if (!finished && todoEl._hideTimer) {
      clearTimeout(todoEl._hideTimer);
      todoEl._hideTimer = null;
    }
    todoEl.classList.toggle('collapsed', todoCollapsed);
    todoEl.innerHTML =
      `<div class="todo-progress"><div class="todo-progress-fill" style="width:${pct}%"></div></div>` +
      `<div class="todo-title"><span class="todo-caret">${todoCollapsed ? '&#9654;' : '&#9660;'}</span>` +
      ` Plan &middot; ${done}/${total}</div>` +
      `<div class="todo-items">${renderTodoItems(todos, 0)}</div>`;
    todoEl.querySelector('.todo-title').addEventListener('click', () => {
      todoCollapsed = !todoCollapsed;
      renderTodos(lastTodos);
    });
  }

  // ── Plan review (approve or give remarks before execution) ──
  let planReviewEl = null;

  function removePlanReview() {
    if (planReviewEl) { planReviewEl.remove(); planReviewEl = null; }
  }

  function showPlanReview() {
    removePlanReview();
    planReviewEl = document.createElement('div');
    planReviewEl.className = 'plan-review';
    planReviewEl.innerHTML =
      `<span class="plan-review-text">Plan klaar — opmerkingen of aanpassingen? Typ ze hieronder, of start direct.</span>` +
      `<button id="plan-approve-btn">&#9654; Voer plan uit</button>`;
    messagesEl.appendChild(planReviewEl);
    scrollToBottom();
    planReviewEl.querySelector('#plan-approve-btn').addEventListener('click', () => {
      removePlanReview();
      const text = 'Plan approved — execute it now, step by step, until every item is completed.';
      addMessage('user', text);
      vscode.postMessage({ type: 'sendMessage', text });
    });
  }

  // Re-render a persisted conversation when the panel reopens.
  function renderTranscript(entries) {
    if (!entries || entries.length === 0) return; // keep the welcome screen
    messagesEl.innerHTML = '';
    // The panel floats on document.body, so a chat wipe doesn't detach it —
    // remove it explicitly; the persisted todos re-render it right after.
    if (todoEl) { todoEl.remove(); todoEl = null; }
    for (const e of entries) {
      if (e.text) {
        const bubble = addMessage(e.role, e.text);
        if (e.images && e.images.length) appendImagesToBubble(bubble, e.images);
        if (e.files && e.files.length) appendFilesToBubble(bubble, e.files.map(n => ({ name: n })));
      } else if (e.images && e.images.length) {
        if (e.role === 'assistant') {
          // Old transcripts store plain url strings, newer ones {url, name}.
          addImageBlock(e.images.map(u => (typeof u === 'string' ? { url: u } : u)));
        } else {
          const bubble = addMessage(e.role, '(image)');
          appendImagesToBubble(bubble, e.images);
        }
      } else if (e.files && e.files.length) {
        const bubble = addMessage(e.role, '(attachment)');
        appendFilesToBubble(bubble, e.files.map(n => ({ name: n })));
      }
    }
    scrollToBottom();
  }

  function addStatusMessage(text, type) {
    const div = document.createElement('div');
    div.className = `status-message status-${type || 'info'}`;
    div.innerHTML = `<span class="status-icon">${type === 'success' ? '&#10003;' : '&#9888;'}</span> ${escapeHtml(text)}`;
    messagesEl.appendChild(div);
    scrollToBottom();
  }

  function startStreaming() {
    isStreaming = true;
    currentContent = '';
    thinkContent = '';
    sendBtn.style.display = 'none';
    stopBtn.style.display = 'inline-block';
    // The bubble is created lazily on the first token, so tool-only steps
    // (which stream no text) don't leave an empty bubble behind.
    currentBubble = null;
    showWaiting();
  }

  // Create the streaming bubble on demand (first token of a step).
  function ensureStreamBubble() {
    if (currentBubble) return;
    currentContent = '';
    thinkContent = '';

    currentBubble = document.createElement('div');
    currentBubble.className = 'bubble assistant';

    const meta = document.createElement('div');
    meta.className = 'meta';
    const roleSpan = document.createElement('span');
    roleSpan.className = 'role';
    roleSpan.textContent = 'CodeFlare';
    meta.appendChild(roleSpan);
    const time = document.createElement('span');
    time.textContent = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    meta.appendChild(time);
    currentBubble.appendChild(meta);

    const body = document.createElement('div');
    body.className = 'body';
    body.innerHTML = '<div class="streaming-indicator"><span class="dot"></span><span class="dot"></span><span class="dot"></span></div>';
    currentBubble.appendChild(body);

    messagesEl.appendChild(currentBubble);
    scrollToBottom();
  }

  // Freeze the current in-progress bubble (used between agent steps) without
  // ending the overall streaming state.
  function freezeCurrentBubble() {
    if (!currentBubble) return;
    const body = currentBubble.querySelector('.body');
    if (body) {
      let display = currentContent;
      if (thinkContent) {
        display = `<think>${thinkContent}</think>\n\n${display}`;
      }
      if (display.trim()) {
        let html = renderMarkdown(display);
        html = renderEditBlocks(html);
        html = processThinkTags(html);
        body.innerHTML = html;
        attachCodeActions(body);
      } else {
        // Nothing was said in this step — drop the empty bubble.
        currentBubble.remove();
      }
    }
    currentBubble = null;
    currentContent = '';
    thinkContent = '';
  }

  // Clipboard fallback for webviews where navigator.clipboard is unavailable.
  function fallbackCopy(text, done) {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    try { document.execCommand('copy'); done(); } catch { /* ignore */ }
    ta.remove();
  }

  // Render a tool-call activity chip (Claude-style "reading file…" line).
  function addToolActivity(label, copyText) {
    clearToolProgress();
    freezeCurrentBubble();
    const div = document.createElement('div');
    div.className = 'tool-activity';
    div.innerHTML = `<span class="tool-icon">&#128295;</span><span class="tool-label">${escapeHtml(label)}</span>`;
    if (copyText) {
      const btn = document.createElement('button');
      btn.className = 'tool-copy';
      btn.title = 'Copy command';
      btn.innerHTML = '&#x2398;';
      btn.addEventListener('click', () => {
        const done = () => {
          btn.innerHTML = '&#10003;';
          btn.classList.add('copied');
          setTimeout(() => { btn.innerHTML = '&#x2398;'; btn.classList.remove('copied'); }, 1200);
        };
        if (navigator.clipboard && navigator.clipboard.writeText) {
          navigator.clipboard.writeText(copyText).then(done, () => fallbackCopy(copyText, done));
        } else {
          fallbackCopy(copyText, done);
        }
      });
      div.appendChild(btn);
    }
    messagesEl.appendChild(div);
    scrollToBottom();
    // A tool just ran — we're now waiting on the model's next step.
    showWaiting();
  }

  // Live indicator while the model generates a tool call (e.g. a big file) —
  // otherwise the UI looks frozen since tool-call args aren't visible tokens.
  let progressEl = null;
  function showToolProgress(name, chars) {
    if (!progressEl) {
      progressEl = document.createElement('div');
      progressEl.className = 'tool-progress';
      messagesEl.appendChild(progressEl);
    }
    const size = chars >= 1000 ? (chars / 1000).toFixed(1) + 'k' : String(chars);
    const label = name ? `generating ${name} — ${size} chars` : `generating… ${size} chars`;
    progressEl.innerHTML =
      `<span class="tool-progress-spinner"></span><span class="tool-progress-label">${escapeHtml(label)}</span>`;
    messagesEl.appendChild(progressEl);
    scrollToBottom();
  }
  function clearToolProgress() {
    if (progressEl) { progressEl.remove(); progressEl = null; }
  }

  // Real old→new diff of a write: context, removed (red), added (green).
  function addToolDiff(msg) {
    const hunks = msg.hunks || [];
    if (hunks.length === 0) return;
    const name = String(msg.path || '').split(/[\\/]/).pop();

    let body = '';
    for (const h of hunks) {
      if (h.t === '.') {
        body += `<div class="diff-more">${escapeHtml(h.line)}</div>`;
      } else {
        const cls = h.t === '-' ? 'diff-removed' : h.t === '+' ? 'diff-added' : 'diff-context';
        const marker = h.t === ' ' ? ' ' : h.t;
        body += `<div class="diff-line ${cls}"><span class="diff-marker">${marker}</span>${escapeHtml(h.line)}</div>`;
      }
    }

    const wrap = document.createElement('div');
    wrap.className = 'tool-diff';
    wrap.innerHTML = `<div class="tool-diff-head">&#9998; ${escapeHtml(name)}</div><div class="tool-diff-body">${body}</div>`;

    // Place it right after its tool chip (before the "working…" indicator).
    if (progressEl && progressEl.parentNode === messagesEl) {
      messagesEl.insertBefore(wrap, progressEl);
    } else {
      messagesEl.appendChild(wrap);
    }
    scrollToBottom();
  }

  // Generic "waiting for the model" indicator — shown while the server is
  // processing the prompt or between steps, before any token/tool arrives.
  function showWaiting(label) {
    if (!isStreaming) return;
    if (!progressEl) {
      progressEl = document.createElement('div');
      progressEl.className = 'tool-progress';
      messagesEl.appendChild(progressEl);
    }
    progressEl.innerHTML =
      `<span class="tool-progress-spinner"></span><span class="tool-progress-label">${escapeHtml(label || 'working…')}</span>`;
    messagesEl.appendChild(progressEl);
    scrollToBottom();
  }

  // Live heartbeat while the server (re-)evaluates a big prompt: no tokens flow
  // for minutes, so show an elapsed counter to prove nothing is frozen.
  function showWaitingElapsed(seconds, promptTokens) {
    const mins = Math.floor(seconds / 60);
    const secs = seconds % 60;
    const elapsed = mins > 0 ? `${mins}m ${String(secs).padStart(2, '0')}s` : `${secs}s`;
    const size = promptTokens >= 1000 ? Math.round(promptTokens / 1000) + 'k' : String(promptTokens);
    showWaiting(`server is processing the prompt (~${size} tokens) — ${elapsed}`);
  }

  function appendToken(token) {
    clearToolProgress();
    ensureStreamBubble();
    currentContent += token;
    updateStreamingBubble();
  }

  function appendThinking(text) {
    clearToolProgress();
    ensureStreamBubble();
    thinkContent += text;
    updateStreamingBubble();
  }

  function updateStreamingBubble() {
    if (!currentBubble) return;
    const body = currentBubble.querySelector('.body');
    if (!body) return;

    // Fast path: only thinking is flowing and a live ribbon already exists —
    // update its text in place. A full innerHTML rebuild would restart the
    // ribbon's CSS animations (spinner/shimmer/cursor) on every token.
    if (thinkContent && !currentContent) {
      const ribbon = body.querySelector('.think-ribbon.live');
      if (ribbon) {
        const preview = ribbon.querySelector('.think-preview');
        const contentEl = ribbon.querySelector('.think-content');
        if (preview) preview.textContent = thinkContent.replace(/\s+/g, ' ').trim().slice(-110);
        if (contentEl) {
          contentEl.textContent = thinkContent.trim();
          contentEl.scrollTop = contentEl.scrollHeight;
        }
        scrollToBottom();
        return;
      }
    }

    let display = currentContent;
    if (thinkContent) {
      display = `<think>${thinkContent}</think>\n\n${currentContent}`;
    }

    // During streaming, strip partial SEARCH/REPLACE blocks to keep chat clean
    let streamDisplay = display.replace(/<<<<<<< SEARCH[\s\S]*$/g, '');

    let html = renderMarkdown(streamDisplay);
    // The ribbon stays "live" until answer tokens arrive — the think block is
    // done the moment the model starts talking.
    html = processThinkTags(html, !currentContent);
    body.innerHTML = html;
    scrollToBottom();
  }

  function finishStreaming(overrideContent) {
    isStreaming = false;
    clearToolProgress();
    sendBtn.style.display = 'inline-block';
    stopBtn.style.display = 'none';

    if (currentBubble) {
      const body = currentBubble.querySelector('.body');
      if (body) {
        // Use override content when the extension converted a code dump
        // to SEARCH/REPLACE blocks via post-processing
        let display = overrideContent || currentContent;
        if (thinkContent) {
          display = `<think>${thinkContent}</think>\n\n${display}`;
        }

        let html = renderMarkdown(display);
        html = renderEditBlocks(html);
        html = processThinkTags(html);
        body.innerHTML = html;
        attachCodeActions(body);
      }
    }

    currentBubble = null;
    currentContent = '';
    thinkContent = '';
    scrollToBottom();
  }

  // ── Code action buttons ─────────────────────────────

  function attachCodeActions(container) {
    // Copy buttons
    container.querySelectorAll('.copy-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        const code = decodeURIComponent(btn.dataset.code);
        vscode.postMessage({ type: 'copyCode', code });
        btn.textContent = 'Copied!';
        setTimeout(() => btn.textContent = 'Copy', 2000);
      });
    });

    // Insert buttons
    container.querySelectorAll('.insert-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        const code = decodeURIComponent(btn.dataset.code);
        vscode.postMessage({ type: 'insertCode', code });
        btn.textContent = 'Inserted!';
        setTimeout(() => btn.textContent = 'Insert', 2000);
      });
    });

    // Replace buttons (replace entire file content)
    container.querySelectorAll('.replace-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        const code = decodeURIComponent(btn.dataset.code);
        vscode.postMessage({ type: 'replaceCode', code });
        btn.textContent = 'Replaced!';
        setTimeout(() => btn.textContent = 'Replace', 2000);
      });
    });

    // Toggle collapsed code blocks (click on warning)
    container.querySelectorAll('.code-dump-warning').forEach(warning => {
      warning.addEventListener('click', () => {
        const wrapper = warning.closest('.code-block-wrapper');
        if (wrapper) wrapper.classList.toggle('collapsed');
      });
    });

    // Run buttons (terminal commands)
    container.querySelectorAll('.run-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        const code = decodeURIComponent(btn.dataset.code);
        vscode.postMessage({ type: 'runCommand', command: code });
      });
    });

    // Apply single edit buttons
    container.querySelectorAll('.edit-apply-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        const search = decodeURIComponent(btn.dataset.search);
        const replace = decodeURIComponent(btn.dataset.replace);
        vscode.postMessage({ type: 'applyEdit', searchReplace: { search, replace } });
        btn.textContent = 'Applied!';
        btn.disabled = true;
        btn.classList.add('applied');
        // Mark the edit block as applied
        const block = btn.closest('.edit-block');
        if (block) block.classList.add('applied');
      });
    });

    // Apply All button
    container.querySelectorAll('.edit-apply-all-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        container.querySelectorAll('.edit-apply-btn:not(.applied)').forEach(applyBtn => {
          applyBtn.click();
        });
        btn.textContent = 'All Applied!';
        btn.disabled = true;
        btn.classList.add('applied');
      });
    });

    // Toggle diff visibility
    container.querySelectorAll('.edit-toggle-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        const block = btn.closest('.edit-block');
        if (block) {
          block.classList.toggle('collapsed');
          btn.innerHTML = block.classList.contains('collapsed') ? '&#9654;' : '&#9660;';
        }
      });
    });

    // (Think-ribbon toggling is handled by a delegated listener on messagesEl,
    // so it also works on live ribbons rebuilt during streaming.)
  }

  // Think ribbons are re-rendered while streaming — delegate the toggle so it
  // survives rebuilds and works before attachCodeActions runs.
  messagesEl.addEventListener('click', (e) => {
    const header = e.target.closest ? e.target.closest('.think-header') : null;
    if (!header) return;
    const ribbon = header.closest('.think-ribbon');
    if (ribbon) ribbon.classList.toggle('expanded');
  });

  // ── Input handling ──────────────────────────────────

  function sendMessage() {
    const text = inputEl.value.trim();
    const images = pendingImages.slice();
    const files = pendingFiles.slice();
    if ((!text && images.length === 0 && files.length === 0) || isStreaming) return;
    // Typing remarks answers a pending plan review.
    removePlanReview();

    const label = text || (images.length ? '(image)' : '(attachment)');
    const bubble = addMessage('user', label);
    if (images.length > 0) { appendImagesToBubble(bubble, images); }
    if (files.length > 0) { appendFilesToBubble(bubble, files); }
    vscode.postMessage({ type: 'sendMessage', text, images, files });
    inputEl.value = '';
    pendingImages = [];
    pendingFiles = [];
    renderAttachments();
    autoResize();
  }

  function appendImagesToBubble(bubble, images) {
    const body = bubble.querySelector('.body');
    if (!body) return;
    const wrap = document.createElement('div');
    wrap.className = 'message-images';
    images.forEach(url => {
      const img = document.createElement('img');
      img.src = url;
      img.className = 'message-image';
      wrap.appendChild(img);
    });
    body.appendChild(wrap);
  }

  function appendFilesToBubble(bubble, files) {
    const body = bubble.querySelector('.body');
    if (!body) return;
    const wrap = document.createElement('div');
    wrap.className = 'message-files';
    files.forEach(f => {
      const chip = document.createElement('span');
      chip.className = 'message-file';
      chip.innerHTML = `<span class="file-icon">&#128196;</span>${escapeHtml(f.name)}`;
      wrap.appendChild(chip);
    });
    body.appendChild(wrap);
  }

  function autoResize() {
    inputEl.style.height = 'auto';
    inputEl.style.height = Math.min(inputEl.scrollHeight, 200) + 'px';
  }

  inputEl.addEventListener('input', autoResize);

  // ── Image paste ─────────────────────────────────────

  inputEl.addEventListener('paste', e => {
    const items = (e.clipboardData && e.clipboardData.items) || [];
    let handled = false;
    for (const item of items) {
      if (item.kind === 'file' && item.type.startsWith('image/')) {
        const file = item.getAsFile();
        if (!file) continue;
        handled = true;
        downscaleImage(file).then(url => {
          pendingImages.push(url);
          renderAttachments();
        }).catch(() => {/* ignore unreadable image */});
      }
    }
    if (handled) e.preventDefault();
  });

  // Shrink large pastes before sending: cap the longest side and re-encode,
  // so we don't ship a 4K screenshot (huge payload, more tokens) when vision
  // models downscale anyway.
  function downscaleImage(file, maxDim = 1536, quality = 0.85) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => {
        const img = new Image();
        img.onload = () => {
          const scale = Math.min(1, maxDim / Math.max(img.width, img.height));
          if (scale === 1 && file.size < 400 * 1024) {
            // Already small — keep the original bytes as-is.
            resolve(reader.result);
            return;
          }
          const w = Math.round(img.width * scale);
          const h = Math.round(img.height * scale);
          const canvas = document.createElement('canvas');
          canvas.width = w;
          canvas.height = h;
          const ctx = canvas.getContext('2d');
          ctx.drawImage(img, 0, 0, w, h);
          resolve(canvas.toDataURL('image/jpeg', quality));
        };
        img.onerror = reject;
        img.src = reader.result;
      };
      reader.onerror = reject;
      reader.readAsDataURL(file);
    });
  }

  // ── Attach button (file picker) ─────────────────────

  attachBtn.addEventListener('click', () => fileInput.click());
  fileInput.addEventListener('change', () => {
    handlePickedFiles(fileInput.files);
    fileInput.value = ''; // allow re-picking the same file
  });

  function isPdf(file) {
    return file.type === 'application/pdf' || /\.pdf$/i.test(file.name);
  }

  function handlePickedFiles(fileList) {
    for (const file of fileList) {
      if (file.type.startsWith('image/')) {
        downscaleImage(file).then(url => {
          pendingImages.push(url);
          renderAttachments();
        }).catch(() => {});
      } else if (isPdf(file)) {
        const reader = new FileReader();
        reader.onload = () => {
          const base64 = String(reader.result || '').split(',')[1] || '';
          addStatusMessage(`Extracting text from ${file.name}…`, 'info');
          vscode.postMessage({ type: 'extractPdf', name: file.name, dataBase64: base64 });
        };
        reader.readAsDataURL(file);
      } else {
        const reader = new FileReader();
        reader.onload = () => {
          let content = String(reader.result || '');
          if (content.length > MAX_TEXT_CHARS) {
            content = content.slice(0, MAX_TEXT_CHARS) + '\n… (truncated)';
          }
          pendingFiles.push({ name: file.name, content });
          renderAttachments();
        };
        reader.readAsText(file);
      }
    }
  }

  function renderAttachments() {
    attachmentsEl.innerHTML = '';
    pendingImages.forEach((url, i) => {
      const thumb = document.createElement('div');
      thumb.className = 'attachment-thumb';
      thumb.innerHTML =
        `<img src="${url}" alt="pasted image" />` +
        `<button class="attachment-remove" data-kind="image" data-i="${i}" title="Remove">&times;</button>`;
      attachmentsEl.appendChild(thumb);
    });
    pendingFiles.forEach((f, i) => {
      const chip = document.createElement('div');
      chip.className = 'attachment-file';
      chip.innerHTML =
        `<span class="file-icon">&#128196;</span>` +
        `<span class="file-name">${escapeHtml(f.name)}</span>` +
        `<button class="attachment-remove" data-kind="file" data-i="${i}" title="Remove">&times;</button>`;
      attachmentsEl.appendChild(chip);
    });
    attachmentsEl.querySelectorAll('.attachment-remove').forEach(btn => {
      btn.addEventListener('click', () => {
        const i = Number(btn.dataset.i);
        if (btn.dataset.kind === 'image') { pendingImages.splice(i, 1); }
        else { pendingFiles.splice(i, 1); }
        renderAttachments();
      });
    });
  }

  // ── @file mentions ──────────────────────────────────
  let mentionFiles = null;   // cached workspace file list (filled on demand)
  let mentionBox = null;     // dropdown element
  let mentionItems = [];
  let mentionIndex = 0;

  function mentionQuery() {
    const pos = inputEl.selectionStart;
    const before = inputEl.value.slice(0, pos);
    const m = before.match(/@([\w\-./\\]*)$/);
    return m ? { query: m[1].toLowerCase(), start: pos - m[1].length - 1 } : null;
  }

  function closeMentionBox() {
    if (mentionBox) { mentionBox.remove(); mentionBox = null; }
    mentionItems = [];
  }

  function updateMentionBox() {
    const q = mentionQuery();
    if (!q) { closeMentionBox(); return; }
    if (!mentionFiles) {
      vscode.postMessage({ type: 'listWorkspaceFiles' });
      return; // re-runs when the list arrives
    }
    const matches = mentionFiles.filter(f => f.toLowerCase().includes(q.query)).slice(0, 12);
    if (matches.length === 0) { closeMentionBox(); return; }
    if (!mentionBox) {
      mentionBox = document.createElement('div');
      mentionBox.id = 'mention-box';
      document.getElementById('input-area').appendChild(mentionBox);
    }
    mentionItems = matches;
    mentionIndex = Math.min(mentionIndex, matches.length - 1);
    mentionBox.innerHTML = matches.map((f, i) =>
      `<div class="mention-item${i === mentionIndex ? ' active' : ''}" data-i="${i}">${escapeHtml(f)}</div>`
    ).join('');
    mentionBox.querySelectorAll('.mention-item').forEach(el => {
      el.addEventListener('mousedown', (e) => { e.preventDefault(); pickMention(Number(el.dataset.i)); });
    });
  }

  function pickMention(i) {
    const q = mentionQuery();
    if (!q || !mentionItems[i]) { closeMentionBox(); return; }
    const v = inputEl.value;
    const after = v.slice(inputEl.selectionStart);
    inputEl.value = v.slice(0, q.start) + '@' + mentionItems[i] + ' ' + after;
    const caret = q.start + mentionItems[i].length + 2;
    inputEl.setSelectionRange(caret, caret);
    closeMentionBox();
    inputEl.focus();
  }

  inputEl.addEventListener('input', () => { mentionIndex = 0; updateMentionBox(); });
  inputEl.addEventListener('blur', () => setTimeout(closeMentionBox, 150));

  inputEl.addEventListener('keydown', e => {
    // The mention dropdown captures navigation keys while open.
    if (mentionBox && mentionItems.length) {
      if (e.key === 'ArrowDown') { e.preventDefault(); mentionIndex = (mentionIndex + 1) % mentionItems.length; updateMentionBox(); return; }
      if (e.key === 'ArrowUp') { e.preventDefault(); mentionIndex = (mentionIndex - 1 + mentionItems.length) % mentionItems.length; updateMentionBox(); return; }
      if (e.key === 'Enter' || e.key === 'Tab') { e.preventDefault(); pickMention(mentionIndex); return; }
      if (e.key === 'Escape') { closeMentionBox(); return; }
    }
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      sendMessage();
    }
  });

  sendBtn.addEventListener('click', sendMessage);

  stopBtn.addEventListener('click', () => {
    vscode.postMessage({ type: 'stopGeneration' });
    finishStreaming();
  });

  clearBtn.addEventListener('click', () => {
    vscode.postMessage({ type: 'clearChat' });
  });

  // ── Copy chat + extension log ───────────────────────

  function serializeChat() {
    const lines = [];
    // The plan panel floats outside the messages list — include it first.
    if (todoEl && todoEl.isConnected) {
      lines.push('[PLAN]');
      lines.push(todoEl.innerText.trim());
    }
    for (const el of messagesEl.children) {
      if (el.classList.contains('bubble')) {
        const body = el.querySelector('.body');
        const text = body ? body.innerText.trim() : '';
        const imgs = body ? Array.from(body.querySelectorAll('img')) : [];
        // A bubble with no text and no images (shouldn't happen) adds noise — skip.
        if (!text && imgs.length === 0) continue;
        const role = el.querySelector('.role');
        lines.push(`\n--- ${role ? role.innerText.toUpperCase() : 'MESSAGE'} ---`);
        if (text) lines.push(text);
        // Images have no innerText — without this, a screenshot bubble
        // serializes as an empty section. Reference each by name/path.
        for (const img of imgs) {
          lines.push(`[image] ${img.title || img.alt || '(inline image)'}`);
        }
      } else if (el.classList.contains('tool-activity')) {
        lines.push(`[tool] ${el.innerText.trim()}`);
      } else if (el.classList.contains('tool-diff')) {
        lines.push(`[diff] ${el.innerText.trim()}`);
      } else if (el.classList.contains('status-message')) {
        lines.push(`[status] ${el.innerText.trim()}`);
      }
    }
    return lines.join('\n');
  }

  document.getElementById('copylog-btn').addEventListener('click', () => {
    vscode.postMessage({ type: 'copyLog', chat: serializeChat() });
  });

  // ── Export chat as markdown (images embedded as data URIs) ─────────
  function serializeChatMarkdown() {
    const lines = ['# CodeFlare Chat', ''];
    if (todoEl && todoEl.isConnected) {
      lines.push('## Plan', '', '```', todoEl.innerText.trim(), '```', '');
    }
    for (const el of messagesEl.children) {
      if (el.classList.contains('bubble')) {
        const body = el.querySelector('.body');
        const text = body ? body.innerText.trim() : '';
        const imgs = body ? Array.from(body.querySelectorAll('img')) : [];
        if (!text && imgs.length === 0) continue;
        const role = el.querySelector('.role');
        lines.push(`## ${role ? role.innerText : 'Message'}`, '');
        if (text) lines.push(text, '');
        for (const img of imgs) {
          lines.push(`![${img.title || 'image'}](${img.src})`, '');
        }
      } else if (el.classList.contains('tool-activity')) {
        lines.push(`> \u{1F527} ${el.innerText.trim()}`, '');
      } else if (el.classList.contains('tool-diff')) {
        lines.push('```diff', el.innerText.trim(), '```', '');
      } else if (el.classList.contains('checkpoint-bar')) {
        lines.push(`> ↺ ${el.innerText.trim()}`, '');
      }
    }
    return lines.join('\n');
  }

  document.getElementById('export-btn').addEventListener('click', () => {
    vscode.postMessage({ type: 'exportChat', markdown: serializeChatMarkdown() });
  });

  // ── Config panel ────────────────────────────────────

  let lastConfig = { endpoint: '', model: '', hasToken: false, trustedCommands: [], confirmCommands: true };

  function selectConfigTab(name) {
    document.querySelectorAll('.config-tab').forEach(t =>
      t.classList.toggle('active', t.dataset.tab === name));
    document.querySelectorAll('.config-pane').forEach(p =>
      p.classList.toggle('hidden', p.dataset.pane !== name));
  }

  document.querySelectorAll('.config-tab').forEach(tab => {
    tab.addEventListener('click', () => selectConfigTab(tab.dataset.tab));
  });

  const PROVIDER_META = {
    local: {
      label: 'Local',
      endpoint: 'http://localhost:8001',
      model: '',
      hint: 'Any OpenAI-compatible server (VLLM, llama.cpp, Ollama). Token is optional.',
    },
    openai: {
      label: 'OpenAI',
      endpoint: 'https://api.openai.com',
      model: 'gpt-4o',
      hint: 'OpenAI API. A token (API key) is required.',
    },
    anthropic: {
      label: 'Anthropic',
      endpoint: 'https://api.anthropic.com',
      model: 'claude-opus-4-8',
      hint: 'Claude via the native Messages API. A token (Anthropic API key) is required.',
    },
  };
  function providerMeta(p) { return PROVIDER_META[p] || PROVIDER_META.local; }

  function updateProviderHint() {
    const p = document.getElementById('cfg-provider').value;
    const hintEl = document.getElementById('cfg-provider-hint');
    if (hintEl) hintEl.textContent = providerMeta(p).hint;
  }

  // Show the model discovered from the server (local provider) as the model
  // field's placeholder, so leaving it blank clearly means "use <that model>".
  function updateModelPlaceholder() {
    const el = document.getElementById('cfg-model');
    if (!el) return;
    const p = document.getElementById('cfg-provider').value;
    const detected = lastConfig.detectedModel;
    if (p === 'local' && detected) {
      el.placeholder = detected + '  —  auto-detected, leave blank to use';
    } else {
      el.placeholder = providerMeta(p).model || 'model name';
    }
  }

  // Switching provider resets endpoint/model to that provider's canonical
  // defaults (a single stored value is shared across providers) and re-labels
  // the token hint. The user can still override the endpoint/model afterwards.
  const providerSelect = document.getElementById('cfg-provider');
  if (providerSelect) {
    providerSelect.addEventListener('change', () => {
      const meta = providerMeta(providerSelect.value);
      document.getElementById('cfg-endpoint').value = meta.endpoint;
      document.getElementById('cfg-model').value = meta.model;
      updateProviderHint();
      updateModelPlaceholder();
    });
  }

  function openConfigPanel() {
    // Re-fetch config (also re-detects the server context window).
    vscode.postMessage({ type: 'getConfig' });
    document.getElementById('cfg-provider').value = lastConfig.provider || 'local';
    document.getElementById('cfg-endpoint').value = lastConfig.endpoint || '';
    document.getElementById('cfg-model').value = lastConfig.model || '';
    document.getElementById('cfg-token').value = '';
    document.getElementById('cfg-token-hint').textContent =
      lastConfig.hasToken ? 'A token is stored. Leave blank to keep it, or type a new one.' : '';
    document.getElementById('cfg-trusted').value = (lastConfig.trustedCommands || []).join('\n');
    document.getElementById('cfg-confirm-commands').checked = lastConfig.confirmCommands !== false;
    updateProviderHint();
    updateModelPlaceholder();
    selectConfigTab('connection');
    configOverlay.classList.remove('hidden');
    document.getElementById('cfg-endpoint').focus();
  }

  function closeConfigPanel() {
    configOverlay.classList.add('hidden');
  }

  configBtn.addEventListener('click', openConfigPanel);
  document.getElementById('cfg-cancel').addEventListener('click', closeConfigPanel);
  configOverlay.addEventListener('click', e => {
    if (e.target === configOverlay) closeConfigPanel();
  });

  document.getElementById('cfg-save').addEventListener('click', () => {
    const provider = document.getElementById('cfg-provider').value;
    const endpoint = document.getElementById('cfg-endpoint').value.trim();
    const model = document.getElementById('cfg-model').value.trim();
    const tokenField = document.getElementById('cfg-token').value;
    const trustedCommands = document.getElementById('cfg-trusted').value
      .split('\n').map(s => s.trim()).filter(Boolean);
    const confirmCommands = document.getElementById('cfg-confirm-commands').checked;
    const cfg = { provider, endpoint, model, trustedCommands, confirmCommands };
    // Only send the token when the user typed something, so an empty field
    // keeps the previously stored token instead of wiping it.
    if (tokenField !== '') cfg.token = tokenField;
    vscode.postMessage({ type: 'saveConfig', config: cfg });
    closeConfigPanel();
  });

  function applyConfigState(cfg) {
    lastConfig = cfg;
    if (endpointLabel) {
      const ctx = cfg.contextSize ? ` · ${Math.round(cfg.contextSize / 1024)}k ctx` : '';
      endpointLabel.textContent = cfg.endpoint ? shortenEndpoint(cfg.endpoint) + ctx : '';
      endpointLabel.title = cfg.endpoint +
        (cfg.hasToken ? ' (token set)' : '') +
        (cfg.activeModel ? ` — model ${cfg.activeModel}` : '') +
        (cfg.contextSize ? ` — context window ${cfg.contextSize} tokens` : '');
    }
    // If the connection panel is open when a fresh config/discovery lands,
    // refresh the model field — but never clobber the input the user is typing.
    if (configOverlay && !configOverlay.classList.contains('hidden')) {
      const el = document.getElementById('cfg-model');
      if (el && document.activeElement !== el) {
        el.value = cfg.model || '';
      }
      updateModelPlaceholder();
    }
  }

  function shortenEndpoint(url) {
    try {
      const u = new URL(url);
      return (cfgIsToken() ? '🔑 ' : '') + u.host;
    } catch {
      return url;
    }
  }
  function cfgIsToken() { return lastConfig.hasToken; }

  // ── Message handling from extension host ────────────

  window.addEventListener('message', event => {
    const msg = event.data;

    switch (msg.type) {
      case 'streamStart':
        startStreaming();
        break;

      case 'streamToken':
        appendToken(msg.token);
        break;

      case 'streamThinking':
        appendThinking(msg.text);
        break;

      case 'toolActivity':
        addToolActivity(msg.label, msg.copy);
        break;

      case 'toolProgress':
        showToolProgress(msg.name, msg.chars);
        break;

      case 'waiting':
        showWaitingElapsed(msg.seconds, msg.promptTokens);
        break;

      case 'toolDiff':
        addToolDiff(msg);
        break;

      case 'streamEnd':
        finishStreaming(msg.content);
        break;

      case 'streamError':
        finishStreaming();
        addErrorMessage(msg.error);
        break;

      case 'chatCleared':
        messagesEl.innerHTML = '';
        if (todoEl) { todoEl.remove(); todoEl = null; }
        planReviewEl = null;
        showWelcome();
        break;

      case 'addUserMessage':
        addMessage('user', msg.text);
        break;

      case 'statusUpdate':
        updateStatus(msg.healthy);
        break;

      case 'turnStats':
        updateTurnStats(msg);
        break;

      case 'workspaceFiles':
        mentionFiles = msg.files || [];
        updateMentionBox();
        break;

      case 'checkpoint':
        addCheckpointBar(msg.id, msg.count);
        break;

      case 'checkpointReverted':
        markCheckpointReverted(msg.id);
        break;

      case 'configState':
        applyConfigState(msg.config);
        break;

      case 'configSaved':
        addStatusMessage('Connection settings saved', 'success');
        break;

      case 'notice':
        addStatusMessage(msg.text, msg.level || 'info');
        break;

      case 'restoreTranscript':
        renderTranscript(msg.transcript);
        break;

      case 'todos':
        renderTodos(msg.todos);
        break;

      case 'planReview':
        showPlanReview();
        break;

      case 'showImages':
        addImageBlock(msg.images);
        break;

      case 'pdfExtracted':
        if (msg.error) {
          addStatusMessage(`PDF ${msg.name}: ${msg.error}`, 'warning');
        } else {
          pendingFiles.push({ name: msg.name, content: msg.content });
          renderAttachments();
          addStatusMessage(
            `Added ${msg.name} (${msg.pages} page${msg.pages === 1 ? '' : 's'}${msg.truncated ? ', truncated' : ''})`,
            'success'
          );
        }
        break;

      case 'editApplied':
        if (msg.applied > 0) {
          addStatusMessage(
            `Applied ${msg.applied} edit(s) to ${msg.file}` +
            (msg.failed > 0 ? ` (${msg.failed} failed)` : ''),
            msg.failed > 0 ? 'warning' : 'success'
          );
        }
        break;
    }
  });

  // ── Utility ─────────────────────────────────────────

  function scrollToBottom() {
    requestAnimationFrame(() => {
      messagesEl.scrollTop = messagesEl.scrollHeight;
    });
  }

  function addErrorMessage(error) {
    const div = document.createElement('div');
    div.className = 'bubble assistant';
    div.innerHTML = `<div class="meta"><span class="role">Error</span></div><div class="body" style="color:var(--vscode-errorForeground)">${escapeHtml(error)}</div>`;
    messagesEl.appendChild(div);
    scrollToBottom();
  }

  function updateStatus(healthy) {
    const dot = document.querySelector('.status-dot');
    if (dot) {
      dot.className = 'status-dot' + (healthy ? '' : ' offline');
    }
    const label = document.getElementById('status-label');
    if (label) {
      const name = providerMeta((lastConfig && lastConfig.provider) || 'local').label;
      label.textContent = healthy ? `${name} Connected` : `${name} Offline`;
    }
  }

  // Footer: context-window usage + generation speed of the last response.
  function updateTurnStats(s) {
    const speedEl = document.getElementById('speed-label');
    if (speedEl && s.completionTokens > 0 && s.genSeconds > 0.2) {
      speedEl.textContent = `${(s.completionTokens / s.genSeconds).toFixed(1)} tok/s`;
      speedEl.title = `Last response: ~${s.completionTokens} tokens in ${s.genSeconds.toFixed(1)}s`;
    }
    const fill = document.getElementById('ctx-fill');
    const label = document.getElementById('ctx-label');
    const meter = document.getElementById('ctx-meter');
    if (!fill || !label) return;
    const used = (s.promptTokens || 0) + (s.completionTokens || 0);
    const max = s.contextWindow || 0;
    if (max > 0) {
      const pct = Math.min(100, Math.round((used / max) * 100));
      fill.style.width = pct + '%';
      fill.classList.toggle('warn', pct > 65 && pct <= 85);
      fill.classList.toggle('crit', pct > 85);
      label.textContent = `${Math.round(used / 1000)}k/${Math.round(max / 1000)}k`;
      if (meter) meter.title = `Context: ~${used.toLocaleString()} of ${max.toLocaleString()} tokens (${pct}%)`;
    } else {
      label.textContent = `~${Math.round(used / 1000)}k tokens`;
    }
  }

  // Bar with a revert button after a turn that changed files.
  function addCheckpointBar(id, count) {
    const bar = document.createElement('div');
    bar.className = 'checkpoint-bar';
    bar.dataset.id = id;
    const label = document.createElement('span');
    label.className = 'checkpoint-label';
    label.textContent = `${count} file(s) changed this turn`;
    const btn = document.createElement('button');
    btn.className = 'checkpoint-revert';
    btn.textContent = '↺ Revert';
    btn.title = 'Restore these files to their state before this turn (created files go to the trash)';
    btn.addEventListener('click', () => {
      btn.disabled = true;
      btn.textContent = 'reverting…';
      vscode.postMessage({ type: 'revertCheckpoint', id });
    });
    bar.appendChild(label);
    bar.appendChild(btn);
    messagesEl.appendChild(bar);
    scrollToBottom();
  }

  function markCheckpointReverted(id) {
    const bar = messagesEl.querySelector(`.checkpoint-bar[data-id="${id}"]`);
    if (!bar) return;
    bar.classList.add('reverted');
    const btn = bar.querySelector('button');
    if (btn) { btn.disabled = true; btn.textContent = '↺ reverted'; }
  }

  function showWelcome() {
    messagesEl.innerHTML = `
      <div class="welcome">
        <h3>CodeFlare</h3>
        <p>Ask questions, get code suggestions, or use right-click actions.<br>
        <strong>Enter</strong> to send, <strong>Shift+Enter</strong> for new line.</p>
      </div>
    `;
  }

  // ── Init ────────────────────────────────────────────
  showWelcome();
  inputEl.focus();
  vscode.postMessage({ type: 'getConfig' });
  vscode.postMessage({ type: 'requestHistory' });
})();
