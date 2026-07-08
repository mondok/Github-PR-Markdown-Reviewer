# GitHub PR Markdown Reviewer

A Chrome extension for reviewing GitHub PRs that touch markdown files. GitHub's
built-in "rich diff" shows rendered markdown but disables inline commenting —
this extension gives you both: read the file as rendered markdown, and click any
section to open GitHub's native inline comment form on the underlying source line.

Built against GitHub's **React-based "Files changed" page** (`/pull/<n>/changes`),
which is what github.com serves as of mid-2026.

## Install

1. Open `chrome://extensions`
2. Enable **Developer mode** (top right)
3. Click **Load unpacked** and select the `extension/` folder in this repo

## Use

1. Open a PR's **Files changed** tab
2. Each `.md` / `.markdown` / `.mdx` file gets a **View rendered** button next to its filename
3. Click it — the source diff is replaced by the rendered head version of the file:
   - Sections changed in the PR have a **green bar / green tint**
   - Hovering a commentable section shows a 💬 affordance
4. **Click a section to comment** — the extension reveals the source diff, scrolls
   to the corresponding line, and opens GitHub's native inline comment form
   (so pending-review comments, suggestions, etc. all work exactly as normal)
5. Use the floating **↩ Back to rendered view** pill to return to reading

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
- Click-to-comment programmatically hovers the matching diff cell and clicks
  GitHub's own "Add comment" button — no GitHub API calls, no permissions beyond
  running on `github.com`

## Limitations (v0.1)

- Comments target the **first added line** of the clicked block; for multi-line
  suggestions, adjust the range in GitHub's form as usual
- Only lines present in the diff (hunks + context) are commentable — a GitHub
  restriction, not an extension one
- Deleted-only content doesn't appear in the rendered view (it renders the head
  version of the file)
- Collapsed diffs ("Load diff") must be expanded before changed-block
  highlighting can see those lines — toggle the rendered view again after expanding
- Relative images/links inside the rendered markdown may not resolve
- If GitHub changes the new files-changed DOM again, selectors live at the top
  of `extension/content.js` (`getLineSets`, `findCellForLine`, `injectButtons`)

## Development

`extension/vendor/markdown-it.min.js` is copied from the npm package:

```sh
npm install
cp node_modules/markdown-it/dist/markdown-it.min.js extension/vendor/
```
