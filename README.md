# GitHub PR Markdown Reviewer

A Chrome extension for reviewing GitHub PRs that touch markdown files. GitHub's
built-in "rich diff" shows rendered markdown but disables inline commenting —
this extension gives you both: read the file as rendered markdown, click any
section to comment on the underlying source line, and see and reply to existing
review threads inline. All commenting goes through GitHub's own (hidden) forms,
so auth, pending reviews, and permissions stay fully native — no tokens, no API
setup.

Built against GitHub's **React-based "Files changed" page** (`/pull/<n>/changes`),
which is what github.com serves as of mid-2026.

## Install

1. Open `chrome://extensions`
2. Enable **Developer mode** (top right)
3. Click **Load unpacked** and select the `extension/` folder in this repo

## Use

1. Open a PR's **Files changed** tab
2. Each `.md` / `.markdown` / `.mdx` file gets a **View rendered** button next to its
   filename — or click the **extension's toolbar icon** to toggle every markdown
   file at once (click again to switch them all back to source)
3. Click it — the source diff is replaced by the rendered head version of the file:
   - Sections changed in the PR have a **green bar / green tint**
   - Hovering a commentable section shows a 💬 affordance
4. **Click a section to comment** — a clean comment box opens inline directly
   below the clicked section, while the rendered view stays on screen. Submitting
   goes through GitHub's real inline comment form behind the scenes, so
   **Comment** and **Start a review** behave exactly as normal.
5. **Existing review threads appear inline** as cards under the section they
   anchor to — author, timestamps, and comment bodies are GitHub's own rendered
   markup. Each card has a **Reply** box (replies go through GitHub's native
   reply form, so pending reviews work as usual), and a Hide/Show toggle
6. If the comment-box flow ever fails (e.g. GitHub UI changes), the extension
   falls back to revealing the source diff at the right line, with a floating
   **↩ Back to rendered view** pill to return to reading

## How it works

- The content script watches PR "Files changed" pages (handles GitHub's SPA
  navigation and progressively-loaded diffs via a MutationObserver)
- File content (PR head version) is fetched same-origin from the blob page's
  embedded JSON payload — works for **private repos** using your existing session
- Markdown is rendered locally with a bundled [markdown-it](https://github.com/markdown-it/markdown-it)
  (raw HTML disabled, so PR content can't inject markup); each block element is
  stamped with its source line range
- Changed lines are read from the diff DOM (`data-grid-cell-id` cells); blocks
  whose line range intersects an added line are highlighted
- The comment box and thread replies are the extension's own UI, **bridged** to
  GitHub's hidden inline forms: the extension programmatically hovers the diff
  cell, clicks GitHub's "Add comment" button, fills the React-controlled
  textarea, and clicks GitHub's real submit button — no GitHub API calls, no
  permissions beyond running on `github.com`
- Thread cards clone GitHub's own rendered comment markup for display, so they
  look native; replies go through the hidden thread's reply form the same way

## Limitations

- Comments target the **first added line** of the clicked block; for multi-line
  suggestions, adjust the range in GitHub's form as usual
- Only lines present in the diff (hunks + context) are commentable — a GitHub
  restriction, not an extension one
- Deleted-only content doesn't appear in the rendered view (it renders the head
  version of the file)
- No markdown toolbar / preview tab in the comment box (the posted comment still
  renders markdown normally); file attachments and suggestion blocks need the
  source diff view
- Collapsed diffs ("Load diff") must be expanded before changed-block
  highlighting can see those lines — toggle the rendered view again after expanding
- Relative images/links inside the rendered markdown may not resolve
- If GitHub changes the new files-changed DOM again, selectors live at the top
  of `extension/content.js` (`getLineSets`, `findCellForLine`, `injectButtons`)

## Development

After editing files in `extension/`, click the reload (↻) button on the
extension's card in `chrome://extensions`, then refresh the PR tab — Chrome
does not pick up content-script changes otherwise.

`extension/vendor/markdown-it.min.js` is copied from the npm package:

```sh
npm install
cp node_modules/markdown-it/dist/markdown-it.min.js extension/vendor/
```

The icon PNGs are rendered from `extension/icons/icon.svg`:

```sh
node -e "
const { Resvg } = require('@resvg/resvg-js');
const fs = require('fs');
const svg = fs.readFileSync('extension/icons/icon.svg', 'utf8');
for (const size of [16, 32, 48, 128]) {
  fs.writeFileSync('extension/icons/icon' + size + '.png',
    new Resvg(svg, { fitTo: { mode: 'width', value: size } }).render().asPng());
}
"
```
