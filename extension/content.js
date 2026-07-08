// GitHub PR Markdown Reviewer
// Targets GitHub's React-based PR "Files changed" page (/pull/<n>/files or /changes).
// For each markdown file in the diff, adds a "Rendered" toggle that shows the file's
// head version rendered as markdown. Changed blocks are highlighted; clicking a block
// opens a clean inline comment box under it. The box bridges to GitHub's own (hidden)
// inline comment form for submission, so auth, pending reviews, and permissions are
// all native — no tokens, no API setup.

(() => {
  'use strict';

  console.log('[pr-md-reviewer] v0.4.2 loaded');

  const MD_EXTENSIONS = /\.(md|markdown|mdx)$/i;
  const BIDI_MARKS = /[‎‏‪-‮]/g;
  const SUBMIT_LABEL_RE = /^(Comment|Start a review|Add (single |review )?comment)$/;

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

  // The PR's head commit. Never trust the embedded JSON in the current DOM —
  // after GitHub's SPA navigation it belongs to a previously loaded page (it
  // may be missing, or worse, be another PR's oid). Instead fetch this PR's
  // files page fresh, once per PR.
  let headOidCache = { key: null, oid: null };

  async function getHeadOid(owner, repo) {
    const prMatch = /^\/[^/]+\/[^/]+\/pull\/(\d+)/.exec(location.pathname);
    if (!prMatch) return null;
    const key = `${owner}/${repo}#${prMatch[1]}`;
    if (headOidCache.key === key) return headOidCache.oid;
    try {
      const resp = await fetch(`/${owner}/${repo}/pull/${prMatch[1]}/files`, { credentials: 'include' });
      if (!resp.ok) return null;
      const html = await resp.text();
      const m = /"headOid":"([a-f0-9]{40})"/.exec(html) || /"headRefOid":"([a-f0-9]{40})"/.exec(html);
      if (m) {
        headOidCache = { key, oid: m[1] };
        return m[1];
      }
    } catch { /* fall through */ }
    return null;
  }

  // ---------------------------------------------------------------------------
  // Diff DOM helpers
  // ---------------------------------------------------------------------------

  // Cell ids look like diff-<sha256(path)>-<oldLine>-<newLine>-<col>. For new
  // files the old side is the literal string "empty" (and vice versa for
  // deletions, which we skip by requiring a numeric new line).
  const GRID_ID_RE = /^diff-[a-f0-9]{40,64}-(\d+|empty)-(\d+)-\d+$/;

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

  function getDiffTable(fileEl) {
    return fileEl.querySelector('table.tab-size');
  }

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  // ---------------------------------------------------------------------------
  // Hidden GitHub form machinery
  // ---------------------------------------------------------------------------

  // Hover a diff cell and click GitHub's hover-revealed "Add comment" button.
  // The cell must have a layout box (the priming CSS provides one), or GitHub's
  // hover machinery won't mount the button.
  async function clickAddComment(cell) {
    const rect = cell.getBoundingClientRect();
    const at = {
      bubbles: true,
      clientX: rect.left + Math.min(40, rect.width / 2),
      clientY: rect.top + rect.height / 2,
    };
    for (const type of ['mouseover', 'mouseenter', 'mousemove']) {
      cell.dispatchEvent(new MouseEvent(type, at));
    }
    for (let i = 0; i < 10; i++) {
      await sleep(100);
      const btn = Array.from(cell.querySelectorAll('button')).find(
        (b) => (b.getAttribute('aria-label') || '') === 'Add comment'
      );
      if (btn) {
        btn.click();
        return true;
      }
    }
    return false;
  }

  function findFormRow(table) {
    return Array.from(table.querySelectorAll('tr')).find((tr) => tr.querySelector('textarea')) || null;
  }

  // GitHub mounts its hover "Add comment" button lazily on the first hover of a
  // visibly-painted cell. Hover one cell while the table is still visible so
  // that later (invisible) priming hovers work.
  async function warmHoverMachinery(fileEl) {
    const cell = fileEl.querySelector('td.diff-text-cell');
    if (!cell) return;
    const rect = cell.getBoundingClientRect();
    if (!rect.width) return;
    const at = {
      bubbles: true,
      clientX: rect.left + Math.min(40, rect.width / 2),
      clientY: rect.top + rect.height / 2,
    };
    for (const type of ['mouseover', 'mouseenter', 'mousemove']) {
      cell.dispatchEvent(new MouseEvent(type, at));
    }
    for (let i = 0; i < 15; i++) {
      await sleep(100);
      if (cell.querySelector('button[aria-label="Add comment"]')) break;
    }
    // No mouseleave: it can abort GitHub's still-in-flight button mount.
  }

  // Open (or find) GitHub's inline comment form for a line, while the diff table
  // stays hidden. Returns the form's <tr>, or null.
  async function tryOpenFormPrimed(fileEl, line) {
    const table = getDiffTable(fileEl);
    if (!table) return null;
    table.classList.add('pmr-priming');
    await sleep(60);
    const cell = findCellForLine(fileEl, line);
    let formRow = null;
    try {
      if (cell && cell.querySelector('textarea')) {
        // A form is already open on this line — reuse it (hovering shows no
        // "Add comment" button while a form is open).
        formRow = cell.closest('tr');
      } else if (cell) {
        let opened = await clickAddComment(cell);
        if (!opened) {
          await sleep(400);
          opened = await clickAddComment(cell);
        }
        for (let i = 0; opened && i < 20 && !formRow; i++) {
          await sleep(100);
          formRow = findFormRow(table);
        }
      }
    } finally {
      table.classList.remove('pmr-priming');
    }
    return formRow;
  }

  async function ensureHiddenForm(fileEl, line) {
    let formRow = await tryOpenFormPrimed(fileEl, line);
    if (!formRow) {
      // Last resort: briefly show the real table (GitHub's hover machinery is
      // most reliable when actually painted), open the form, re-hide. The
      // caller's scroll lock keeps the viewport still.
      const wasActive = fileEl.classList.contains('pmr-active');
      if (wasActive) fileEl.classList.remove('pmr-active');
      await sleep(150);
      const cell = findCellForLine(fileEl, line);
      if (cell) {
        if (cell.querySelector('textarea')) {
          formRow = cell.closest('tr');
        } else if (await clickAddComment(cell)) {
          const table = getDiffTable(fileEl);
          for (let i = 0; table && i < 20 && !formRow; i++) {
            await sleep(100);
            formRow = findFormRow(table);
          }
        }
      }
      if (wasActive) fileEl.classList.add('pmr-active');
    }
    return formRow;
  }

  // GitHub autofocuses its comment form's textarea when it mounts, which yanks
  // the viewport toward the (hidden) diff table. Pin the scroll position while
  // the bridge works. Returns an unlock function.
  function lockScroll(durationMs) {
    const x = window.scrollX;
    const y = window.scrollY;
    const onScroll = () => window.scrollTo(x, y);
    window.addEventListener('scroll', onScroll, true);
    const timer = setTimeout(() => window.removeEventListener('scroll', onScroll, true), durationMs);
    return () => {
      clearTimeout(timer);
      window.removeEventListener('scroll', onScroll, true);
      window.scrollTo(x, y);
    };
  }

  // Set a React-controlled textarea's value so React registers it.
  function setNativeValue(textarea, value) {
    const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set;
    setter.call(textarea, value);
    textarea.dispatchEvent(new Event('input', { bubbles: true }));
  }

  function ghSubmitButtons(formRow) {
    return Array.from(formRow.querySelectorAll('button')).filter((b) =>
      SUBMIT_LABEL_RE.test((b.textContent || '').trim())
    );
  }

  function ghCancelButton(formRow) {
    return Array.from(formRow.querySelectorAll('button')).find(
      (b) => (b.textContent || '').trim() === 'Cancel'
    ) || null;
  }

  // ---------------------------------------------------------------------------
  // Inline comment box (our own UI, bridged to the hidden GitHub form)
  // ---------------------------------------------------------------------------

  let activeBox = null; // { box, textarea, formRow }

  function closeActiveBox({ cancelHidden } = { cancelHidden: true }) {
    if (!activeBox) return;
    const { box, formRow } = activeBox;
    activeBox = null;
    if (cancelHidden && formRow && document.contains(formRow)) {
      const ta = formRow.querySelector('textarea');
      if (ta) setNativeValue(ta, ''); // empty ⇒ Cancel won't prompt to discard
      ghCancelButton(formRow)?.click();
    }
    box.remove();
  }

  function openCommentBox(fileEl, blockEl, line) {
    if (activeBox) {
      if (activeBox.textarea.value.trim()) {
        // Don't discard typed text; bring the existing box back into view.
        activeBox.box.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
        activeBox.textarea.focus();
        return;
      }
      closeActiveBox();
    }

    const box = document.createElement('div');
    box.className = 'pmr-comment-box';
    box.innerHTML = `
      <div class="pmr-box-head">Comment on line ${line}</div>
      <textarea placeholder="Leave a comment" aria-label="Comment on line ${line}"></textarea>
      <div class="pmr-box-status" hidden></div>
      <div class="pmr-box-actions">
        <button type="button" class="pmr-btn pmr-btn-cancel">Cancel</button>
        <span class="pmr-box-submits"><button type="button" class="pmr-btn" disabled>Connecting…</button></span>
      </div>`;
    const textarea = box.querySelector('textarea');
    const status = box.querySelector('.pmr-box-status');
    const submits = box.querySelector('.pmr-box-submits');

    blockEl.insertAdjacentElement('afterend', box);
    textarea.focus();
    activeBox = { box, textarea, formRow: null };
    const thisBox = activeBox;

    box.querySelector('.pmr-btn-cancel').addEventListener('click', () => closeActiveBox());
    textarea.addEventListener('keydown', (ev) => {
      if (ev.key === 'Escape' && !textarea.value.trim()) closeActiveBox();
    });

    const showError = (msg) => {
      status.hidden = false;
      status.textContent = msg;
      submits.innerHTML = '';
      const retry = document.createElement('button');
      retry.type = 'button';
      retry.className = 'pmr-btn pmr-btn-primary';
      retry.textContent = 'Retry';
      retry.addEventListener('click', () => {
        status.hidden = true;
        submits.innerHTML = '<button type="button" class="pmr-btn" disabled>Connecting…</button>';
        connect();
      });
      const openSrc = document.createElement('button');
      openSrc.type = 'button';
      openSrc.className = 'pmr-btn';
      openSrc.textContent = 'Open source diff';
      openSrc.addEventListener('click', () => {
        closeActiveBox({ cancelHidden: false });
        fileEl.classList.remove('pmr-active');
        syncToggleLabel(fileEl);
        findCellForLine(fileEl, line)?.scrollIntoView({ block: 'center' });
      });
      submits.append(retry, openSrc);
    };

    // Connect to GitHub's hidden form in the background.
    const connect = async () => {
      const unlock = lockScroll(6000);
      let formRow = null;
      try {
        formRow = await ensureHiddenForm(fileEl, line);
      } finally {
        unlock();
        // GitHub's form steals focus when it mounts; take it back.
        if (thisBox === activeBox) textarea.focus({ preventScroll: true });
      }
      if (thisBox !== activeBox) {
        // Box was closed while connecting — clean up the orphan hidden form.
        if (formRow && document.contains(formRow)) ghCancelButton(formRow)?.click();
        return;
      }
      if (!formRow) {
        showError('Could not reach GitHub’s comment form for this line.');
        return;
      }
      thisBox.formRow = formRow;
      const ghButtons = ghSubmitButtons(formRow);
      if (!ghButtons.length) {
        showError('Could not find GitHub’s submit buttons.');
        return;
      }
      submits.innerHTML = '';
      for (const ghBtn of ghButtons) {
        const label = ghBtn.textContent.trim();
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'pmr-btn' + (label === 'Comment' || /review/.test(label) ? '' : '');
        if (label !== 'Start a review') btn.classList.add('pmr-btn-primary');
        btn.textContent = label;
        btn.disabled = !textarea.value.trim();
        btn.addEventListener('click', () => submitVia(ghBtn, label));
        submits.appendChild(btn);
      }
      const syncDisabled = () => {
        const empty = !textarea.value.trim();
        for (const b of submits.querySelectorAll('button')) b.disabled = empty;
      };
      textarea.addEventListener('input', syncDisabled);
      syncDisabled();

      async function submitVia(ghBtn, label) {
        const ghTa = formRow.querySelector('textarea');
        if (!ghTa || !document.contains(ghBtn)) {
          showError('GitHub’s comment form went away — please retry.');
          return;
        }
        for (const b of submits.querySelectorAll('button')) b.disabled = true;
        status.hidden = false;
        status.textContent = 'Posting…';
        const unlock = lockScroll(9000);
        try {
          setNativeValue(ghTa, textarea.value);
          await sleep(80);
          ghBtn.click();
          // Success = the hidden form disappears (posted, or moved into a thread).
          for (let i = 0; i < 27; i++) {
            await sleep(300);
            if (!document.contains(formRow) || !formRow.querySelector('textarea')) {
              markCommented(blockEl, line);
              closeActiveBox({ cancelHidden: false });
              // The posted comment becomes a review thread — surface it inline.
              setTimeout(() => insertThreadCards(fileEl), 800);
              return;
            }
          }
          showError('GitHub didn’t confirm the comment. It may need attention in the source view.');
        } finally {
          unlock();
        }
      }
    };
    connect();
  }

  function markCommented(blockEl, line) {
    if (blockEl.querySelector('.pmr-commented-badge')) return;
    const badge = document.createElement('span');
    badge.className = 'pmr-commented-badge';
    badge.textContent = '💬';
    badge.title = 'You commented on line ' + line + ' — switch to the source diff to see the thread.';
    blockEl.appendChild(badge);
  }

  // ---------------------------------------------------------------------------
  // Existing review threads: shown inline as cards, replies bridged to the
  // hidden thread's own reply form
  // ---------------------------------------------------------------------------

  const seenThreads = new WeakSet();

  // New-file line a thread anchors to (its row's grid id, same convention as
  // the rest of the code), or null for rows with no line number.
  function getThreadLine(threadEl) {
    const row = threadEl.closest('tr');
    if (!row) return null;
    for (const td of row.querySelectorAll('td[data-grid-cell-id]')) {
      const m = GRID_ID_RE.exec(td.getAttribute('data-grid-cell-id') || '');
      if (m) return Number(m[2]);
    }
    return null;
  }

  // Clone GitHub's rendered thread markup for display; strip everything
  // interactive (the live thread stays in the hidden table for bridging).
  function cloneThreadContent(threadEl) {
    const clone = threadEl.cloneNode(true);
    for (const el of clone.querySelectorAll('button, form, textarea, input')) el.remove();
    return clone;
  }

  async function submitReply(threadEl, text) {
    if (!document.contains(threadEl)) return false;
    const unlock = lockScroll(9000);
    try {
      let ta = threadEl.querySelector('textarea');
      if (!ta) {
        const write = Array.from(threadEl.querySelectorAll('button')).find(
          (b) => b.textContent.trim() === 'Write a reply'
        );
        if (!write) return false;
        write.click();
        for (let i = 0; i < 20 && !ta; i++) {
          await sleep(100);
          ta = threadEl.querySelector('textarea');
        }
        if (!ta) return false;
      }
      setNativeValue(ta, text);
      await sleep(80);
      const buttons = Array.from(threadEl.querySelectorAll('button'));
      const btn =
        buttons.find((b) => /^(Reply|Add review comment)$/.test(b.textContent.trim())) ||
        buttons.find((b) => b.textContent.trim() === 'Start a review');
      if (!btn) return false;
      btn.click();
      for (let i = 0; i < 27; i++) {
        await sleep(300);
        if (!threadEl.querySelector('textarea')) return true;
      }
      return false;
    } finally {
      unlock();
    }
  }

  function buildThreadCard(threadEl, line) {
    const card = document.createElement('div');
    card.className = 'pmr-thread-card';
    card.dataset.pmrLine = String(line);
    card.innerHTML = `
      <div class="pmr-thread-head">
        <span>Review thread — line ${line}</span>
        <button type="button" class="pmr-btn pmr-btn-small">Hide</button>
      </div>
      <div class="pmr-thread-content"></div>
      <div class="pmr-thread-reply">
        <textarea placeholder="Reply…" aria-label="Reply to review thread on line ${line}"></textarea>
        <div class="pmr-thread-reply-actions">
          <button type="button" class="pmr-btn pmr-btn-primary" disabled>Reply</button>
        </div>
      </div>`;
    const content = card.querySelector('.pmr-thread-content');
    const toggleBtn = card.querySelector('.pmr-thread-head button');
    const replyWrap = card.querySelector('.pmr-thread-reply');
    const rta = replyWrap.querySelector('textarea');
    const rbtn = replyWrap.querySelector('button');
    content.appendChild(cloneThreadContent(threadEl));

    // Clicks inside the card must not trigger the block's click-to-comment.
    card.addEventListener('click', (ev) => ev.stopPropagation());

    toggleBtn.addEventListener('click', () => {
      const hidden = content.style.display === 'none';
      content.style.display = hidden ? '' : 'none';
      replyWrap.style.display = hidden ? '' : 'none';
      toggleBtn.textContent = hidden ? 'Hide' : 'Show';
    });
    rta.addEventListener('input', () => {
      rbtn.disabled = !rta.value.trim();
    });
    rbtn.addEventListener('click', async () => {
      rbtn.disabled = true;
      rbtn.textContent = 'Posting…';
      const ok = await submitReply(threadEl, rta.value);
      rbtn.textContent = 'Reply';
      if (ok) {
        rta.value = '';
        content.innerHTML = '';
        content.appendChild(cloneThreadContent(threadEl));
      } else {
        rbtn.disabled = false;
        alert('PR Markdown Reviewer: the reply was not confirmed — check the source diff view.');
      }
    });
    return card;
  }

  // Insert cards for any threads not yet shown. Safe to call repeatedly.
  function insertThreadCards(fileEl) {
    const container = fileEl.querySelector('.pmr-rendered');
    if (!container) return;
    const blocks = Array.from(container.querySelectorAll(':scope > [data-pmr-start]')).map((el) => ({
      el,
      start: Number(el.getAttribute('data-pmr-start')),
      end: Number(el.getAttribute('data-pmr-end')),
    }));
    for (const threadEl of fileEl.querySelectorAll('[data-testid="review-thread"]')) {
      if (seenThreads.has(threadEl)) continue;
      const line = getThreadLine(threadEl);
      if (!line) continue;
      seenThreads.add(threadEl);
      let anchor = null;
      for (const b of blocks) {
        if (b.start <= line && line <= b.end && (!anchor || b.start >= anchor.start)) anchor = b;
      }
      if (!anchor) {
        for (const b of blocks) {
          if (b.start <= line && (!anchor || b.start > anchor.start)) anchor = b;
        }
      }
      const card = buildThreadCard(threadEl, line);
      if (anchor) {
        let after = anchor.el;
        while (
          after.nextElementSibling &&
          after.nextElementSibling.matches('.pmr-thread-card, .pmr-comment-box')
        ) {
          after = after.nextElementSibling;
        }
        after.insertAdjacentElement('afterend', card);
      } else {
        container.appendChild(card);
      }
    }
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
          if (ev.target.closest('a, .pmr-comment-box, .pmr-commented-badge')) return;
          ev.preventDefault();
          ev.stopPropagation(); // nested blocks (li in ul) are also commentable
          openCommentBox(fileEl, el, target);
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
      closeActiveBox();
      fileEl.classList.remove('pmr-active');
      syncToggleLabel(fileEl);
      return;
    }
    let rendered = fileEl.querySelector('.pmr-rendered');
    if (!rendered) {
      const btn = fileEl.querySelector('.pmr-toggle');
      if (btn) btn.textContent = 'Loading…';
      try {
        const [owner, repo] = location.pathname.split('/').slice(1, 3);
        const oid = await getHeadOid(owner, repo);
        if (!oid) throw new Error('could not determine PR head commit');
        const text = await fetchFileText(owner, repo, oid, path);
        rendered = buildRenderedView(fileEl, path, text);
        const table = getDiffTable(fileEl);
        if (table) table.insertAdjacentElement('afterend', rendered);
        else fileEl.appendChild(rendered);
      } catch (err) {
        console.error('[pr-md-reviewer]', err);
        if (btn) btn.textContent = 'View rendered';
        alert('PR Markdown Reviewer: could not load rendered view (' + err.message + ')');
        return;
      }
    }
    await warmHoverMachinery(fileEl); // while the table is still visible
    fileEl.classList.add('pmr-active');
    syncToggleLabel(fileEl);
    insertThreadCards(fileEl);
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

  // Toolbar button: toggle every markdown file to rendered view; if they are
  // all already rendered, toggle them all back to the source diff.
  async function toggleAll() {
    if (!isPRFilesPage()) return;
    injectButtons();
    const list = document.querySelector('[data-testid="progressive-diffs-list"]');
    if (!list) return;
    const files = Array.from(list.children).filter((f) => {
      const path = getFilePath(f);
      return path && MD_EXTENSIONS.test(path);
    });
    if (!files.length) return;
    const allActive = files.every((f) => f.classList.contains('pmr-active'));
    for (const f of files) {
      if (f.classList.contains('pmr-active') === allActive) {
        await toggleRendered(f, getFilePath(f));
      }
    }
  }

  if (typeof chrome !== 'undefined' && chrome.runtime?.onMessage) {
    chrome.runtime.onMessage.addListener((msg) => {
      if (msg && msg.type === 'pmr-toggle-all') toggleAll();
    });
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
