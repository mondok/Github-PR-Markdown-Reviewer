// GitHub PR Markdown Reviewer
// Targets GitHub's React-based PR "Files changed" page (/pull/<n>/files or /changes).
// For each markdown file in the diff, adds a "Rendered" toggle that shows the file's
// head version rendered as markdown. Changed blocks are highlighted; clicking a block
// opens GitHub's native inline comment form on the underlying source line.

(() => {
  'use strict';

  const MD_EXTENSIONS = /\.(md|markdown|mdx)$/i;
  const BIDI_MARKS = /[‎‏‪-‮]/g;

  // ---------------------------------------------------------------------------
  // Markdown rendering with source-line mapping
  // ---------------------------------------------------------------------------

  const md = window.markdownit({ html: false, linkify: true });

  // Stamp block-level open tokens with their source line range (1-based, inclusive).
  md.core.ruler.push('pmr_source_lines', (state) => {
    for (const token of state.tokens) {
      if (token.map && (token.nesting === 1 || token.type === 'fence' || token.type === 'code_block' || token.type === 'hr' || token.type === 'html_block')) {
        token.attrSet('data-pmr-start', String(token.map[0] + 1));
        token.attrSet('data-pmr-end', String(token.map[1]));
      }
    }
  });

  // The default fence renderer drops custom attrs in its common path; re-add them.
  const defaultFence = md.renderer.rules.fence || md.renderer.renderToken.bind(md.renderer);
  md.renderer.rules.fence = (tokens, idx, options, env, self) => {
    const html = defaultFence(tokens, idx, options, env, self);
    const map = tokens[idx].map;
    if (map && !html.includes('data-pmr-start')) {
      return html.replace(/^<pre/, `<pre data-pmr-start="${map[0] + 1}" data-pmr-end="${map[1]}"`);
    }
    return html;
  };

  // Render YAML frontmatter as a code block by swapping the `---` delimiters for
  // fence markers. Line count is unchanged, so source-line mapping stays correct.
  function preprocess(text) {
    const lines = text.split('\n');
    if (lines[0] === '---') {
      for (let i = 1; i < Math.min(lines.length, 100); i++) {
        if (lines[i] === '---') {
          lines[0] = '```yaml';
          lines[i] = '```';
          break;
        }
      }
    }
    return lines.join('\n');
  }

  // ---------------------------------------------------------------------------
  // Fetching file content (same-origin; works for private repos via session)
  // ---------------------------------------------------------------------------

  const rawCache = new Map();

  function findRawLines(obj, depth = 0) {
    if (!obj || typeof obj !== 'object' || depth > 8) return null;
    if (Array.isArray(obj.rawLines)) return obj.rawLines;
    for (const key of Object.keys(obj)) {
      const found = findRawLines(obj[key], depth + 1);
      if (found) return found;
    }
    return null;
  }

  async function fetchFileText(owner, repo, oid, path) {
    const cacheKey = `${oid}:${path}`;
    if (rawCache.has(cacheKey)) return rawCache.get(cacheKey);
    const url = `/${owner}/${repo}/blob/${oid}/${path.split('/').map(encodeURIComponent).join('/')}`;
    const resp = await fetch(url, { credentials: 'include' });
    if (!resp.ok) throw new Error(`fetch ${url}: ${resp.status}`);
    const html = await resp.text();
    const re = /<script type="application\/json" data-target="react-app\.embeddedData">([\s\S]*?)<\/script>/g;
    let m;
    while ((m = re.exec(html))) {
      try {
        const rawLines = findRawLines(JSON.parse(m[1]).payload);
        if (rawLines) {
          const text = rawLines.join('\n');
          rawCache.set(cacheKey, text);
          return text;
        }
      } catch { /* try next script block */ }
    }
    throw new Error('could not extract file content from blob page');
  }

  function getHeadOid() {
    for (const script of document.querySelectorAll('script[data-target="react-app.embeddedData"]')) {
      const m = /"headOid":"([a-f0-9]{40})"/.exec(script.textContent);
      if (m) return m[1];
    }
    return null;
  }

  // ---------------------------------------------------------------------------
  // Diff DOM helpers
  // ---------------------------------------------------------------------------

  const GRID_ID_RE = /^diff-[a-f0-9]{40,64}-(\d+)-(\d+)-\d+$/;

  // Returns { added: Set<newLine>, visible: Set<newLine> } for one file container.
  function getLineSets(fileEl) {
    const added = new Set();
    const visible = new Set();
    for (const td of fileEl.querySelectorAll('td[data-grid-cell-id]')) {
      if (!td.classList.contains('diff-text-cell')) continue;
      const code = td.querySelector('code.diff-text');
      if (!code || code.classList.contains('deletion')) continue;
      const m = GRID_ID_RE.exec(td.getAttribute('data-grid-cell-id') || '');
      if (!m) continue;
      const newLine = Number(m[2]);
      visible.add(newLine);
      if (code.classList.contains('addition')) added.add(newLine);
    }
    return { added, visible };
  }

  // Find the diff text cell for a given new-file line number, preferring the
  // right side / addition cell (works in both split and unified views).
  function findCellForLine(fileEl, line) {
    let fallback = null;
    for (const td of fileEl.querySelectorAll('td[data-grid-cell-id]')) {
      if (!td.classList.contains('diff-text-cell')) continue;
      const m = GRID_ID_RE.exec(td.getAttribute('data-grid-cell-id') || '');
      if (!m || Number(m[2]) !== line) continue;
      const code = td.querySelector('code.diff-text');
      if (!code || code.classList.contains('deletion')) continue;
      if (code.classList.contains('addition') || /right-side/.test(td.className)) return td;
      fallback = fallback || td;
    }
    return fallback;
  }

  function getFilePath(fileEl) {
    const h3 = fileEl.querySelector('h3');
    if (!h3) return null;
    let path = h3.textContent.replace(BIDI_MARKS, '').trim();
    // Renames show "old → new"; the head version lives at the new path.
    const arrow = path.split(' → ');
    if (arrow.length === 2) path = arrow[1].trim();
    return path || null;
  }

  // ---------------------------------------------------------------------------
  // Click-to-comment
  // ---------------------------------------------------------------------------

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  async function openCommentForm(fileEl, line) {
    // Reveal the source diff so GitHub's comment form is visible and usable.
    fileEl.classList.remove('pmr-active');
    const cell = findCellForLine(fileEl, line);
    if (!cell) {
      showBackPill(fileEl);
      return;
    }
    cell.scrollIntoView({ block: 'center', behavior: 'instant' });
    const row = cell.closest('tr');
    if (row) {
      row.classList.add('pmr-row-flash');
      setTimeout(() => row.classList.remove('pmr-row-flash'), 2500);
    }
    // GitHub renders the "Add comment" button on hover.
    for (const type of ['mouseover', 'mouseenter', 'mousemove']) {
      cell.dispatchEvent(new MouseEvent(type, { bubbles: true }));
    }
    let btn = null;
    for (let i = 0; i < 10 && !btn; i++) {
      await sleep(100);
      btn = Array.from(cell.querySelectorAll('button')).find(
        (b) => (b.getAttribute('aria-label') || '') === 'Add comment'
      );
    }
    if (btn) btn.click();
    showBackPill(fileEl);
  }

  function showBackPill(fileEl) {
    document.querySelector('.pmr-back-pill')?.remove();
    const pill = document.createElement('button');
    pill.className = 'pmr-back-pill';
    pill.textContent = '↩ Back to rendered view';
    pill.addEventListener('click', () => {
      fileEl.classList.add('pmr-active');
      syncToggleLabel(fileEl);
      pill.remove();
      fileEl.scrollIntoView({ block: 'start' });
    });
    document.body.appendChild(pill);
  }

  // ---------------------------------------------------------------------------
  // Rendered view
  // ---------------------------------------------------------------------------

  function buildRenderedView(fileEl, path, text) {
    const { added, visible } = getLineSets(fileEl);
    const container = document.createElement('div');
    container.className = 'pmr-rendered markdown-body';
    container.innerHTML = md.render(preprocess(text));

    for (const el of container.querySelectorAll('[data-pmr-start]')) {
      const start = Number(el.getAttribute('data-pmr-start'));
      const end = Number(el.getAttribute('data-pmr-end'));
      let firstAdded = 0;
      let firstVisible = 0;
      for (let line = start; line <= end; line++) {
        if (!firstAdded && added.has(line)) firstAdded = line;
        if (!firstVisible && visible.has(line)) firstVisible = line;
        if (firstAdded) break;
      }
      if (firstAdded) el.classList.add('pmr-changed');
      const target = firstAdded || firstVisible;
      if (target) {
        el.classList.add('pmr-commentable');
        el.title = 'Click to comment on line ' + target;
        el.addEventListener('click', (ev) => {
          if (ev.target.closest('a')) return; // let links behave normally
          ev.preventDefault();
          ev.stopPropagation(); // nested blocks (li in ul) are also commentable
          openCommentForm(fileEl, target);
        });
      }
    }

    const note = document.createElement('div');
    note.className = 'pmr-note';
    note.textContent =
      'Rendered head version of ' + path +
      ' — green-marked sections changed in this PR; click any marked section to comment on it.';
    container.prepend(note);
    return container;
  }

  function syncToggleLabel(fileEl) {
    const btn = fileEl.querySelector('.pmr-toggle');
    if (!btn) return;
    const active = fileEl.classList.contains('pmr-active');
    btn.textContent = active ? 'View source diff' : 'View rendered';
    btn.setAttribute('aria-pressed', String(active));
  }

  async function toggleRendered(fileEl, path) {
    if (fileEl.classList.contains('pmr-active')) {
      fileEl.classList.remove('pmr-active');
      document.querySelector('.pmr-back-pill')?.remove();
      syncToggleLabel(fileEl);
      return;
    }
    let rendered = fileEl.querySelector('.pmr-rendered');
    if (!rendered) {
      const btn = fileEl.querySelector('.pmr-toggle');
      if (btn) btn.textContent = 'Loading…';
      try {
        const [owner, repo] = location.pathname.split('/').slice(1, 3);
        const oid = getHeadOid();
        if (!oid) throw new Error('could not determine PR head commit');
        const text = await fetchFileText(owner, repo, oid, path);
        rendered = buildRenderedView(fileEl, path, text);
        fileEl.appendChild(rendered);
      } catch (err) {
        console.error('[pr-md-reviewer]', err);
        if (btn) btn.textContent = 'View rendered';
        alert('PR Markdown Reviewer: could not load rendered view (' + err.message + ')');
        return;
      }
    }
    fileEl.classList.add('pmr-active');
    syncToggleLabel(fileEl);
  }

  // ---------------------------------------------------------------------------
  // Injection + SPA navigation
  // ---------------------------------------------------------------------------

  function isPRFilesPage() {
    return /^\/[^/]+\/[^/]+\/pull\/\d+\/(files|changes)/.test(location.pathname);
  }

  function injectButtons() {
    if (!isPRFilesPage()) return;
    const list = document.querySelector('[data-testid="progressive-diffs-list"]');
    if (!list) return;
    for (const fileEl of list.children) {
      if (fileEl.querySelector('.pmr-toggle')) continue;
      const path = getFilePath(fileEl);
      if (!path || !MD_EXTENSIONS.test(path)) continue;
      const h3 = fileEl.querySelector('h3');
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'pmr-toggle';
      btn.textContent = 'View rendered';
      btn.addEventListener('click', (ev) => {
        ev.preventDefault();
        ev.stopPropagation();
        toggleRendered(fileEl, path);
      });
      h3.insertAdjacentElement('afterend', btn);
    }
  }

  let scanTimer = null;
  function scheduleScan() {
    clearTimeout(scanTimer);
    scanTimer = setTimeout(injectButtons, 400);
  }

  new MutationObserver(scheduleScan).observe(document.body, { childList: true, subtree: true });
  ['turbo:load', 'turbo:render', 'pjax:end', 'popstate'].forEach((ev) =>
    window.addEventListener(ev, scheduleScan)
  );
  injectButtons();
})();
