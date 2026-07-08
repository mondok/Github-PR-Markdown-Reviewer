# Getting Started

Welcome to the **GitHub PR Markdown Reviewer**! This guide walks you through
installing the extension and reviewing your first markdown-heavy pull request.

## Installation

1. Clone this repository
2. Open `chrome://extensions` and enable **Developer mode**
3. Click **Load unpacked** and select the `extension/` folder
4. Pin the extension to your toolbar for one-click toggling

## Your first review

Open any pull request that touches a markdown file and head to the
**Files changed** tab. You'll see a *View rendered* button next to each
markdown file:

```text
docs/getting-started.md   [View rendered]
```

Click it and the diff transforms into the fully rendered document. Changed
sections carry a green bar in the margin — click any of them to leave a
comment without ever leaving the rendered view.

## Keyboard-friendly workflow

| Action              | How                                      |
| ------------------- | ---------------------------------------- |
| Toggle one file     | Click **View rendered** in the file header |
| Toggle all files    | Click the extension's toolbar icon       |
| Comment on a change | Click the highlighted section            |
| Reply to a thread   | Type in the thread card's reply box      |
| Bail out to source  | Click **View source diff**               |

## What gets highlighted?

- **Green bar + tint** — this section was added or modified in the PR
- **Hover outline** — this section maps to a commentable diff line
- **💬 badge** — you commented on this section during this session

> [!TIP]
> The rendered view shows the PR's *head* version of the file, so what you
> read is exactly what will land when the PR merges.
