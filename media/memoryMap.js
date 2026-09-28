// Settings → Memory map: a picture of what the agent remembers and, for each
// kind of memory, HOW it reaches the model. The data comes from the extension
// (src/engine/memoryMap.ts); layout() is pure so its claims are testable, and
// render() only turns that view model into DOM.
//
// Translation: static labels are plain text nodes, so media/ui.js translates
// them like the rest of the Settings panel. Everything that came from memory
// (task titles, skill names, facts) is marked .mm-data and never translated.
(function () {
  'use strict';

  const ACCESS = {
    always: { label: 'In every prompt', hint: 'Every turn starts with these, in this project.' },
    auto: { label: 'Automatically, when relevant', hint: 'Up to 5 that match the request are added to the prompt.' },
    request: { label: 'Only on request', hint: 'The agent sees these only when it calls recall_memory or list_skills itself.' },
    stored: { label: 'Stored, not read back', hint: 'Written with record_landscape; nothing reads them back into a prompt yet.' },
    nightshift: { label: 'Night Shift', hint: 'Night Shift picks its next goal from these.' },
  };

  function day(ms) {
    if (!ms) { return ''; }
    const d = new Date(ms);
    const two = n => String(n).padStart(2, '0');
    return d.getFullYear() + '-' + two(d.getMonth() + 1) + '-' + two(d.getDate()) + ' ' + two(d.getHours()) + ':' + two(d.getMinutes());
  }

  function skillItem(s) {
    const uses = [];
    if (s.successes) { uses.push('✓' + s.successes); }
    if (s.failures) { uses.push('✗' + s.failures); }
    if (s.inconclusive) { uses.push('?' + s.inconclusive); }
    const details = [['summary', [s.summary]], ['whenToUse', [s.whenToUse]]];
    if (typeof s.lift === 'number') { details.push(['lift', [(s.lift >= 0 ? '+' : '') + Math.round(s.lift * 100) + '%']]); }
    return {
      kind: 'skill', label: s.name, status: s.status, badge: uses.join(' '),
      meta: 'v' + s.version + ' · ' + day(s.updatedAt), details,
    };
  }

  function column(key, title, access, items, empty) {
    return { key, title, access, count: items.length, items, empty };
  }

  /** Pure: memory-map data → what to draw. */
  function layout(map) {
    const p = map.project;
    const isValidated = s => s.status === 'validated';
    const projectCandidates = p.skills.filter(s => !isValidated(s)).map(skillItem);
    const projectValidated = p.skills.filter(isValidated).map(skillItem);
    const globalCandidates = map.global.skills.filter(s => !isValidated(s)).map(skillItem);
    const globalValidated = map.global.skills.filter(isValidated).map(skillItem);
    const experiences = p.experiences.map(e => ({
      kind: 'experience', label: e.title, status: e.status, failedChecks: e.failedChecks.length,
      badge: e.outcome, meta: day(e.updatedAt),
      details: [['observations', e.observations], ['failedChecks', e.failedChecks]],
    }));
    return {
      tiles: [
        { value: p.facts.length, label: 'Facts in every prompt', access: 'always' },
        { value: projectValidated.length + globalValidated.length, label: 'Validated skills', access: 'auto' },
        { value: p.experienceTotal, label: 'Experiences', access: 'request' },
        { value: projectCandidates.length + globalCandidates.length, label: 'Candidate skills', access: 'request' },
      ],
      project: {
        available: p.available,
        name: p.name || '',
        flow: [
          column('experiences', 'Experiences', map.access.experiences, experiences, 'No experiments recorded yet.'),
          column('candidates', 'Candidate skills', map.access.candidates, projectCandidates, 'No candidates.'),
          column('validated', 'Validated skills', map.access.validated, projectValidated, 'Nothing validated yet.'),
        ],
        arrows: ['reflection or save_skill', 'proven in a mission with tests'],
        side: [
          column('facts', 'Facts (memory.md)', map.access.facts,
            p.facts.map(f => ({ kind: 'fact', label: f.text, status: 'fact', badge: f.category, meta: '', details: [] })),
            'No facts stored.'),
          column('goals', 'Goals and acceptance criteria', map.access.goals,
            p.goals.map(g => ({
              kind: 'goal', label: g.goal, status: 'goal', badge: g.acceptanceCriteria.length + ' ✓',
              meta: day(g.updatedAt),
              details: [['acceptanceCriteria', g.acceptanceCriteria], ['decisions', g.decisions]],
            })),
            'No goals recorded.'),
          column('backlog', 'Backlog', map.access.backlog,
            p.backlog.map(b => ({ kind: 'backlog', label: b.title, status: b.status === 'done' ? 'ok' : b.status === 'failed' ? 'fail' : 'open', badge: b.status, meta: '', details: [] })),
            'Backlog is empty.'),
        ],
        truncated: p.experienceTotal > p.experiences.length ? p.experienceTotal - p.experiences.length : 0,
        lastReflectionAt: p.lastReflectionAt || 0,
      },
      global: {
        flow: [
          column('candidates', 'Candidate skills', map.access.candidates, globalCandidates, 'No candidates.'),
          column('validated', 'Validated skills', map.access.validated, globalValidated, 'Nothing validated yet.'),
        ],
        arrows: ['proven in a mission with tests'],
      },
    };
  }

  const DETAIL_TITLES = {
    observations: 'What the checks observed', failedChecks: 'Failed checks', summary: 'Summary',
    whenToUse: 'When to use', lift: 'Measured lift (with vs. without)', acceptanceCriteria: 'Acceptance criteria',
    decisions: 'Decisions',
  };

  function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) { node.className = className; }
    if (text !== undefined && text !== null && text !== '') { node.textContent = String(text); }
    return node;
  }
  const data = (tag, className, text) => el(tag, (className ? className + ' ' : '') + 'mm-data', text);

  function accessChip(access) {
    const chip = el('span', 'mm-access mm-access-' + access, ACCESS[access].label);
    chip.title = ACCESS[access].hint;
    return chip;
  }

  function render(container, map, onRefresh) {
    const view = layout(map);
    let selected = null;
    const detail = el('div', 'mm-detail');
    detail.append(el('div', 'mm-detail-hint', 'Select an item to see what is stored.'));

    function showDetail(item, col, node) {
      if (selected) { selected.classList.remove('selected'); }
      selected = node;
      node.classList.add('selected');
      detail.replaceChildren();
      const head = el('div', 'mm-detail-head');
      head.append(data('strong', '', item.label));
      if (item.badge) { head.append(data('span', 'mm-badge', item.badge)); }
      detail.append(head);
      const where = el('div', 'mm-detail-where');
      where.append(el('span', '', col.title), accessChip(col.access));
      if (item.meta) { where.append(data('span', 'mm-meta', item.meta)); }
      detail.append(where, el('div', 'mm-detail-hint', ACCESS[col.access].hint));
      for (const [key, lines] of item.details) {
        const clean = (lines || []).filter(Boolean);
        if (!clean.length) { continue; }
        detail.append(el('div', 'mm-detail-label', DETAIL_TITLES[key] || key));
        const list = el('ul', 'mm-detail-list');
        clean.forEach(line => list.append(data('li', '', line)));
        detail.append(list);
      }
    }

    function renderColumn(col) {
      const box = el('section', 'mm-col mm-col-' + col.key);
      const head = el('div', 'mm-col-head');
      head.append(el('span', 'mm-col-title', col.title), data('span', 'mm-count', col.count));
      box.append(head, accessChip(col.access));
      const list = el('div', col.key === 'experiences' ? 'mm-grid' : 'mm-list');
      if (!col.items.length) { list.append(el('div', 'mm-empty', col.empty)); }
      for (const item of col.items) {
        const node = document.createElement('button');
        node.type = 'button';
        node.className = 'mm-item mm-' + item.kind + ' mm-status-' + item.status + (item.failedChecks ? ' mm-has-fail' : '');
        if (col.key === 'experiences') {
          node.title = item.label + ' — ' + item.badge + ' — ' + item.meta;
          node.setAttribute('aria-label', item.label);
        } else {
          node.append(data('span', 'mm-item-label', item.label));
          if (item.badge) { node.append(data('span', 'mm-badge', item.badge)); }
        }
        node.addEventListener('click', () => showDetail(item, col, node));
        list.append(node);
      }
      box.append(list);
      return box;
    }

    function renderFlow(flow, arrows) {
      const row = el('div', 'mm-flow mm-flow-' + flow.length);
      flow.forEach((col, i) => {
        row.append(renderColumn(col));
        if (i < arrows.length) {
          const arrow = el('div', 'mm-arrow');
          arrow.append(el('span', 'mm-arrow-glyph', '→'), el('span', 'mm-arrow-label', arrows[i]));
          row.append(arrow);
        }
      });
      return row;
    }

    const root = el('div', 'mm-root');
    const top = el('div', 'mm-top');
    const tiles = el('div', 'mm-tiles');
    for (const tile of view.tiles) {
      const t = el('div', 'mm-tile mm-tile-' + tile.access);
      t.append(data('span', 'mm-tile-value', tile.value), el('span', 'mm-tile-label', tile.label));
      tiles.append(t);
    }
    const refresh = el('button', 'mm-refresh', 'Refresh');
    refresh.type = 'button';
    refresh.addEventListener('click', onRefresh);
    top.append(tiles, refresh);
    root.append(top);

    const project = el('div', 'mm-lane');
    const ph = el('div', 'mm-lane-head');
    ph.append(el('span', 'mm-lane-title', 'This project'));
    if (view.project.name) { ph.append(data('span', 'mm-lane-name', view.project.name)); }
    ph.append(el('span', 'mm-lane-hint', 'stays in this workspace'));
    project.append(ph);
    if (!view.project.available) {
      project.append(el('div', 'mm-empty', 'No project storage in this window: open a folder to see what it learned.'));
    } else {
      project.append(renderFlow(view.project.flow, view.project.arrows));
      if (view.project.truncated) {
        const more = el('div', 'mm-note');
        more.append(el('span', '', 'Older experiences not drawn:'), data('span', '', ' ' + view.project.truncated));
        project.append(more);
      }
      const side = el('div', 'mm-side');
      view.project.side.forEach(col => side.append(renderColumn(col)));
      project.append(side);
    }
    root.append(project);

    const shared = el('div', 'mm-lane mm-lane-global');
    const gh = el('div', 'mm-lane-head');
    gh.append(el('span', 'mm-lane-title', 'Agent memory'), el('span', 'mm-lane-hint', 'shared by all projects'));
    shared.append(gh, renderFlow(view.global.flow, view.global.arrows));
    root.append(shared);

    const legend = el('div', 'mm-legend');
    legend.append(el('div', 'mm-detail-label', 'How each part reaches the agent'));
    for (const key of Object.keys(ACCESS)) {
      const row = el('div', 'mm-legend-row');
      row.append(accessChip(key), el('span', 'mm-legend-hint', ACCESS[key].hint));
      legend.append(row);
    }
    const status = el('div', 'mm-legend-row');
    status.append(el('span', 'mm-item mm-experience mm-status-ok mm-swatch'), el('span', 'mm-legend-hint', 'accepted'),
      el('span', 'mm-item mm-experience mm-status-open mm-swatch'), el('span', 'mm-legend-hint', 'inconclusive'),
      el('span', 'mm-item mm-experience mm-status-fail mm-swatch'), el('span', 'mm-legend-hint', 'rejected'),
      el('span', 'mm-item mm-experience mm-status-open mm-has-fail mm-swatch'), el('span', 'mm-legend-hint', 'some checks failed'));
    legend.append(status);

    root.append(detail, legend);
    container.replaceChildren(root);
  }

  function init(vscode) {
    const tabs = document.querySelector('.config-tabs');
    const pane = document.querySelector('[data-pane="memory-map"]');
    const container = document.getElementById('memory-map');
    if (!tabs || !pane || !container) { return; }
    const tab = el('button', 'config-tab', 'Memory map');
    tab.type = 'button';
    tab.dataset.tab = 'memory-map';
    const request = () => vscode.postMessage({ type: 'getMemoryMap' });
    tab.addEventListener('click', () => {
      document.querySelectorAll('.config-tab').forEach(t => t.classList.toggle('active', t === tab));
      document.querySelectorAll('.config-pane').forEach(p => p.classList.toggle('hidden', p !== pane));
      request();
    });
    tabs.appendChild(tab);
    window.addEventListener('message', event => {
      const msg = event.data || {};
      if (msg.type === 'memoryMap') {
        if (msg.error || !msg.map) {
          container.replaceChildren(el('div', 'mm-empty', msg.error || 'Memory storage is unavailable in this window.'));
        } else {
          render(container, msg.map, request);
        }
      } else if (msg.type === 'memoryState' && !pane.classList.contains('hidden')) {
        // A clear or reflection just changed memory while the map is open.
        request();
      }
    });
  }

  window.CodeFlareMemoryMap = { init, layout, render, access: ACCESS };
})();
