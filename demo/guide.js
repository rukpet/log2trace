/**
 * Shared runtime utilities for the log2trace-ui interactive guide pages:
 * - Page shell (theme toggle synced with unpinned <trace-visualizer> elements, TOC scroll-spy, mobile TOC)
 * - Zero-dependency syntax highlighting & copy-to-clipboard code blocks
 * - Fresh, domain-diverse sample datasets under ./data/
 * - Structured live event inspector widget
 */

export const GUIDE_PAGES = [
  { id: 'getting-started', href: './index.html', label: 'Getting Started & Data' },
  { id: 'views', href: './views.html', label: 'Views & Theming' },
  { id: 'filtering', href: './filtering.html', label: 'Filtering & Sources' },
  { id: 'api', href: './api.html', label: 'Events & API' },
  { id: 'playground', href: './playground.html', label: 'Setup Playground' },
];

const THEME_KEY = 'l2t-guide-theme';

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

// ---------------------------------------------------------------------------
// Zero-dependency syntax highlighter (HTML, JS/TS, JSON, CSS)
// ---------------------------------------------------------------------------

function highlightHtml(src) {
  const tokenRe = /(<!--[\s\S]*?-->)|(<\/?[a-zA-Z][\w:-]*)|(\s+[a-zA-Z_:][\w:.-]*(?=\s*=|\s*\/?>|\s))|(="[^"]*"|='[^']*')|(\/?>)/g;
  let out = '';
  let last = 0;
  for (const m of src.matchAll(tokenRe)) {
    const idx = m.index ?? 0;
    if (idx > last) out += escapeHtml(src.slice(last, idx));
    if (m[1]) out += `<span class="tok-com">${escapeHtml(m[1])}</span>`;
    else if (m[2]) out += `<span class="tok-tag">${escapeHtml(m[2])}</span>`;
    else if (m[3]) out += `<span class="tok-attr">${escapeHtml(m[3])}</span>`;
    else if (m[4]) {
      const eq = m[4][0];
      const val = m[4].slice(1);
      out += `${escapeHtml(eq)}<span class="tok-str">${escapeHtml(val)}</span>`;
    } else if (m[5]) out += `<span class="tok-tag">${escapeHtml(m[5])}</span>`;
    last = idx + m[0].length;
  }
  if (last < src.length) out += escapeHtml(src.slice(last));
  return out;
}

function highlightJs(src) {
  const tokenRe = /(\/\/[^\n]*|\/\*[\s\S]*?\*\/)|(`(?:\\[\s\S]|[^\\`])*`|"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*')|\b(import|from|export|const|let|var|function|async|await|return|if|else|for|of|in|new|true|false|null|undefined|class|extends|void|typeof|try|catch|finally|throw)\b|\b(\d+(?:_\d+)*(?:\.\d+)?)\b|\b([a-zA-Z_$][\w$]*)(?=\s*\()/g;
  let out = '';
  let last = 0;
  for (const m of src.matchAll(tokenRe)) {
    const idx = m.index ?? 0;
    if (idx > last) out += escapeHtml(src.slice(last, idx));
    if (m[1]) out += `<span class="tok-com">${escapeHtml(m[1])}</span>`;
    else if (m[2]) out += `<span class="tok-str">${escapeHtml(m[2])}</span>`;
    else if (m[3]) out += `<span class="tok-kw">${escapeHtml(m[3])}</span>`;
    else if (m[4]) out += `<span class="tok-num">${escapeHtml(m[4])}</span>`;
    else if (m[5]) out += `<span class="tok-fn">${escapeHtml(m[5])}</span>`;
    last = idx + m[0].length;
  }
  if (last < src.length) out += escapeHtml(src.slice(last));
  return out;
}

function highlightCss(src) {
  const tokenRe = /(\/\*[\s\S]*?\*\/)|(--[\w-]+)|("(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|#[0-9a-fA-F]{3,8}\b)|\b(\d+(?:\.\d+)?(?:px|rem|em|%|vh|vw|ms|s)?)\b/g;
  let out = '';
  let last = 0;
  for (const m of src.matchAll(tokenRe)) {
    const idx = m.index ?? 0;
    if (idx > last) out += escapeHtml(src.slice(last, idx));
    if (m[1]) out += `<span class="tok-com">${escapeHtml(m[1])}</span>`;
    else if (m[2]) out += `<span class="tok-attr">${escapeHtml(m[2])}</span>`;
    else if (m[3]) out += `<span class="tok-str">${escapeHtml(m[3])}</span>`;
    else if (m[4]) out += `<span class="tok-num">${escapeHtml(m[4])}</span>`;
    last = idx + m[0].length;
  }
  if (last < src.length) out += escapeHtml(src.slice(last));
  return out;
}

export function highlightCode(code, lang = 'html') {
  const normalized = String(code).replace(/^\n+|\s+$/g, '');
  if (lang === 'html' || lang === 'xml') return highlightHtml(normalized);
  if (lang === 'css') return highlightCss(normalized);
  return highlightJs(normalized);
}

export function setCodeBlock(codeEl, rawText, lang = 'html') {
  if (!codeEl) return;
  const clean = String(rawText).replace(/^\n+|\s+$/g, '');
  codeEl.dataset.rawCode = clean;
  codeEl.dataset.lang = lang;
  codeEl.innerHTML = highlightCode(clean, lang);
}

export function enhanceCodeBlocks(root = document) {
  for (const panel of root.querySelectorAll('.code-panel')) {
    for (const codeEl of panel.querySelectorAll('.code-pre code')) {
      if (!codeEl.dataset.highlighted) {
        const lang = codeEl.dataset.lang || 'html';
        const raw = codeEl.dataset.rawCode ?? codeEl.textContent ?? '';
        setCodeBlock(codeEl, raw, lang);
        codeEl.dataset.highlighted = 'true';
      }
    }
    const tabBtns = [...panel.querySelectorAll('[data-code-tab]')];
    if (tabBtns.length && !panel.dataset.tabsBound) {
      panel.dataset.tabsBound = 'true';
      const panes = [...panel.querySelectorAll('[data-code-pane]')];
      for (const btn of tabBtns) {
        btn.addEventListener('click', () => {
          const target = btn.dataset.codeTab;
          for (const b of tabBtns) {
            const active = b.dataset.codeTab === target;
            b.classList.toggle('is-active', active);
            b.setAttribute('aria-selected', String(active));
          }
          for (const p of panes) {
            p.hidden = p.dataset.codePane !== target;
          }
        });
      }
    }
    const copyBtn = panel.querySelector('.copy-btn');
    if (copyBtn && !copyBtn.dataset.bound) {
      copyBtn.dataset.bound = 'true';
      copyBtn.addEventListener('click', async () => {
        const activeCode = panel.querySelector('.code-pre:not([hidden]) code') ?? panel.querySelector('.code-pre code');
        const text = activeCode?.dataset.rawCode ?? activeCode?.textContent ?? '';
        try {
          await navigator.clipboard.writeText(text);
          const prev = copyBtn.textContent;
          copyBtn.textContent = 'Copied';
          copyBtn.classList.add('is-copied');
          setTimeout(() => {
            copyBtn.textContent = prev;
            copyBtn.classList.remove('is-copied');
          }, 1400);
        } catch {
          // clipboard unavailable
        }
      });
    }
  }
}

// ---------------------------------------------------------------------------
// Page theme synchronization
// ---------------------------------------------------------------------------

let currentThemePref = 'auto';

function resolveTheme(pref) {
  if (pref === 'light' || pref === 'dark') return pref;
  return globalThis.matchMedia?.('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

export function syncVisualizerThemes() {
  for (const viz of document.querySelectorAll('trace-visualizer')) {
    if (viz.hasAttribute('data-pin-theme')) continue;
    if (currentThemePref === 'auto') {
      if (viz.dataset.guideManagedTheme === '1') {
        viz.removeAttribute('theme');
        delete viz.dataset.guideManagedTheme;
      }
    } else {
      viz.setAttribute('theme', currentThemePref);
      viz.dataset.guideManagedTheme = '1';
    }
  }
}

export function setPageTheme(pref) {
  currentThemePref = pref === 'light' || pref === 'dark' ? pref : 'auto';
  try {
    localStorage.setItem(THEME_KEY, currentThemePref);
  } catch {}
  const resolved = resolveTheme(currentThemePref);
  document.documentElement.dataset.pageTheme = resolved;
  for (const btn of document.querySelectorAll('[data-theme-btn]')) {
    btn.setAttribute('aria-pressed', String(btn.dataset.themeBtn === currentThemePref));
  }
  syncVisualizerThemes();
}

export function getPageThemePreference() {
  return currentThemePref;
}

// ---------------------------------------------------------------------------
// Shell initialization (Header, TOC scroll-spy, Code blocks)
// ---------------------------------------------------------------------------

export function initGuideShell() {
  let saved = 'auto';
  try {
    saved = localStorage.getItem(THEME_KEY) || 'auto';
  } catch {}
  setPageTheme(saved);

  const mq = globalThis.matchMedia?.('(prefers-color-scheme: dark)');
  if (mq) {
    mq.addEventListener('change', () => {
      if (currentThemePref === 'auto') setPageTheme('auto');
    });
  }

  for (const btn of document.querySelectorAll('[data-theme-btn]')) {
    btn.addEventListener('click', () => setPageTheme(btn.dataset.themeBtn));
  }

  const pageNav = document.querySelector('.page-nav');
  if (pageNav) {
    const syncNavFade = () => {
      const maxScroll = pageNav.scrollWidth - pageNav.clientWidth;
      pageNav.classList.toggle('is-overflow-left', pageNav.scrollLeft > 4);
      pageNav.classList.toggle('is-overflow-right', maxScroll - pageNav.scrollLeft > 4);
    };
    const scrollActiveTab = () => {
      const activeTab = pageNav.querySelector('a[aria-current="page"]');
      if (activeTab) {
        activeTab.scrollIntoView({ inline: 'center', block: 'nearest', behavior: 'instant' });
      }
      syncNavFade();
    };
    scrollActiveTab();
    document.fonts?.ready?.then(scrollActiveTab);
    pageNav.addEventListener('scroll', syncNavFade, { passive: true });
    window.addEventListener('resize', syncNavFade, { passive: true });
  }

  const toc = document.getElementById('sidebar-toc');
  const mobileBtn = document.getElementById('toc-mobile-btn');
  if (toc && mobileBtn) {
    mobileBtn.addEventListener('click', () => {
      const open = toc.classList.toggle('is-open');
      mobileBtn.setAttribute('aria-expanded', String(open));
    });
    toc.addEventListener('click', (e) => {
      if (e.target instanceof Element && e.target.closest('a')) {
        toc.classList.remove('is-open');
        mobileBtn.setAttribute('aria-expanded', 'false');
      }
    });
  }

  const tocLinks = [...document.querySelectorAll('.sidebar-toc a[href^="#"]')];
  if (tocLinks.length > 0 && 'IntersectionObserver' in globalThis) {
    const targets = tocLinks
      .map((a) => document.getElementById(a.getAttribute('href').slice(1)))
      .filter(Boolean);
    const setActive = (id) => {
      for (const a of tocLinks) {
        a.classList.toggle('is-active', a.getAttribute('href') === `#${id}`);
      }
    };
    if (targets[0]) setActive(targets[0].id);
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting) {
            setActive(entry.target.id);
            break;
          }
        }
      },
      { rootMargin: '-15% 0px -72% 0px' },
    );
    for (const t of targets) observer.observe(t);
  }

  enhanceCodeBlocks(document);
}

// ---------------------------------------------------------------------------
// Live Event Console widget
// ---------------------------------------------------------------------------

export function createEventConsole(container, vizEl, { maxEntries = 80 } = {}) {
  const activeTypes = new Set(['trace-loaded', 'span-selected', 'filter-changed', 'view-changed', 'api-call']);
  let count = 0;

  container.classList.add('event-console');
  container.innerHTML = `
    <div class="event-console-bar">
      <div class="event-console-filters" role="group" aria-label="Filter event types">
        <span style="font-weight:600;margin-right:0.25rem">Events</span>
        <button type="button" class="ev-chip" data-ev-toggle="trace-loaded" aria-pressed="true">trace-loaded</button>
        <button type="button" class="ev-chip" data-ev-toggle="span-selected" aria-pressed="true">span-selected</button>
        <button type="button" class="ev-chip" data-ev-toggle="filter-changed" aria-pressed="true">filter-changed</button>
        <button type="button" class="ev-chip" data-ev-toggle="view-changed" aria-pressed="true">view-changed</button>
      </div>
      <div style="display:inline-flex;align-items:center;gap:0.5rem">
        <span data-ev-count style="font-variant-numeric:tabular-nums">0 events</span>
        <button type="button" class="copy-btn" data-ev-clear>Clear</button>
      </div>
    </div>
    <div class="event-console-list" role="log" aria-live="off">
      <div class="event-empty">Interact with the visualizer (click spans, filter, or switch tabs) to inspect emitted events…</div>
    </div>
  `;

  const listEl = container.querySelector('.event-console-list');
  const countEl = container.querySelector('[data-ev-count]');

  function refreshVisibility() {
    let visible = 0;
    for (const row of listEl.querySelectorAll('.event-row')) {
      const show = activeTypes.has(row.dataset.evType);
      row.hidden = !show;
      if (show) visible++;
    }
    const empty = listEl.querySelector('.event-empty');
    if (empty) empty.hidden = visible > 0;
  }

  function push(type, detail) {
    count++;
    countEl.textContent = `${count} event${count === 1 ? '' : 's'}`;
    const empty = listEl.querySelector('.event-empty');
    if (empty) empty.hidden = true;

    const now = new Date();
    const ts = now.toLocaleTimeString('en-US', { hour12: false }) + '.' + String(now.getMilliseconds()).padStart(3, '0');
    const row = document.createElement('div');
    row.className = 'event-row';
    row.dataset.evType = type;
    row.hidden = !activeTypes.has(type);

    const timeSpan = document.createElement('span');
    timeSpan.className = 'event-time';
    timeSpan.textContent = ts;

    const badge = document.createElement('span');
    badge.className = 'event-badge';
    badge.dataset.ev = type;
    badge.textContent = type;

    const payload = document.createElement('span');
    payload.className = 'event-payload';
    payload.textContent = typeof detail === 'string' ? detail : JSON.stringify(detail);

    row.append(timeSpan, badge, payload);
    listEl.prepend(row);

    const rows = listEl.querySelectorAll('.event-row');
    if (rows.length > maxEntries) rows[rows.length - 1].remove();
  }

  for (const chip of container.querySelectorAll('[data-ev-toggle]')) {
    chip.addEventListener('click', () => {
      const t = chip.dataset.evToggle;
      if (activeTypes.has(t)) activeTypes.delete(t);
      else activeTypes.add(t);
      chip.setAttribute('aria-pressed', String(activeTypes.has(t)));
      refreshVisibility();
    });
  }

  container.querySelector('[data-ev-clear]').addEventListener('click', () => {
    count = 0;
    countEl.textContent = '0 events';
    for (const row of listEl.querySelectorAll('.event-row')) row.remove();
    const empty = listEl.querySelector('.event-empty');
    if (empty) empty.hidden = false;
  });

  if (vizEl) attachTo(vizEl);

  function attachTo(el) {
    el.addEventListener('trace-loaded', (e) => push('trace-loaded', e.detail));
    el.addEventListener('span-selected', (e) => {
      const s = e.detail.span;
      push('span-selected', {
        spanId: e.detail.spanId,
        name: s?.name,
        kind: s?.kind,
        view: e.detail.view,
        spanIdsCount: e.detail.spanIds?.length ?? 1,
      });
    });
    el.addEventListener('filter-changed', (e) => push('filter-changed', e.detail));
    el.addEventListener('view-changed', (e) => push('view-changed', e.detail));
  }

  return {
    log: push,
    attachTo,
    clear: () => container.querySelector('[data-ev-clear]').click(),
  };
}

// ---------------------------------------------------------------------------
// Fresh Datasets (sample traces and logs under ./data/)
// ---------------------------------------------------------------------------

const cache = new Map();

async function loadJson(path) {
  if (!cache.has(path)) {
    const res = await fetch(path);
    if (!res.ok) throw new Error(`HTTP ${res.status} loading ${path}`);
    cache.set(path, await res.json());
  }
  return cache.get(path);
}

/** Compact Starter: Edge API & Session Auth — 14 spans, 4 services, 184 ms. */
export const loadEdgeAuthTrace = () => loadJson('./data/edge-auth-trace.json');

/** Modern Raw Logs: Card Settlement & Fraud Pipeline — 61 structured logs -> 21 spans across 9 services. */
export const loadFintechLogs = () => loadJson('./data/fintech-logs.json');

/** Complex Multi-View: AI RAG & Hybrid Search — 43 spans, 9 services + 4 peers, 5x shard loop, 429 failover. */
export const loadAiSearchTrace = () => loadJson('./data/ai-search-trace.json');

/** Incident Cascade: Retry Storm & Circuit Breaker — 19 spans, 3 exponential-backoff retries, DLQ fallback. */
export const loadIncidentCascade = () => loadJson('./data/incident-cascade.json');

/** Worker Pool: batch fan-out onto an 8-slot worker pool — 138 spans, saturation, an idle gap, ghost peers (s3, postgresql), 3 failures. */
export const loadWorkerPoolTrace = () => loadJson('./data/worker-pool-trace.json');

export const FINTECH_LOG_RULES = [
  { match: { component: 'http-server' }, kind: 'Server' },
  { match: { component: 'grpc-server' }, kind: 'Server' },
  { match: { component: 'http-client' }, kind: 'Client' },
  { match: { component: 'db-client' }, kind: 'Client' },
  { match: { component: 'redis-client' }, kind: 'Client' },
  { match: { component: 'kafka-producer' }, kind: 'Producer' },
  { match: { component: 'kafka-consumer' }, kind: 'Consumer' },
  { match: { component: 'internal-worker' }, kind: 'Internal' },
];

export const FINTECH_LOG_CONFIG = {
  traceIdField: 'trace.id',
  spanGroupFields: ['service.name', 'operation'],
  spanNameField: 'operation',
  serviceNameField: 'service.name',
  timestampField: 'ts',
  statusCodeField: 'code',
  parentSpanLookupFields: ['caller'],
  spanKindRules: FINTECH_LOG_RULES,
};

/** Compact inline OTel trace (3 spans) for minimal programmatic examples. */
export const INLINE_STARTER_TRACE = {
  resourceSpans: [
    {
      resource: { attributes: [{ key: 'service.name', value: { stringValue: 'edge-proxy' } }] },
      scopeSpans: [{
        scope: { name: 'edge.router' },
        spans: [
          {
            traceId: '9f2a4c8e1b0d0001', spanId: 'sp-root',
            name: 'GET /v2/profile', kind: 2,
            startTimeUnixNano: '1795702800000000000',
            endTimeUnixNano: '1795702800086000000',
            status: { code: 1 },
            attributes: [
              { key: 'http.request.method', value: { stringValue: 'GET' } },
              { key: 'http.response.status_code', value: { intValue: '200' } },
            ],
          },
        ],
      }],
    },
    {
      resource: { attributes: [{ key: 'service.name', value: { stringValue: 'profile-svc' } }] },
      scopeSpans: [{
        scope: { name: 'profile.rpc' },
        spans: [
          {
            traceId: '9f2a4c8e1b0d0001', spanId: 'sp-redis', parentSpanId: 'sp-root',
            name: 'GET user:usr_88412', kind: 3,
            startTimeUnixNano: '1795702800009000000',
            endTimeUnixNano: '1795702800021000000',
            status: { code: 1 },
            attributes: [{ key: 'db.system', value: { stringValue: 'redis' } }],
          },
          {
            traceId: '9f2a4c8e1b0d0001', spanId: 'sp-pg', parentSpanId: 'sp-root',
            name: 'SELECT * FROM profiles WHERE id = $1', kind: 3,
            startTimeUnixNano: '1795702800024000000',
            endTimeUnixNano: '1795702800079000000',
            status: { code: 1 },
            attributes: [{ key: 'db.system', value: { stringValue: 'postgresql' } }],
            events: [{ timeUnixNano: '1795702800074000000', name: 'rows.fetched', attributes: [{ key: 'rows', value: { intValue: '1' } }] }],
          },
        ],
      }],
    },
  ],
};
