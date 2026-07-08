# Architecture Notes

This document sketches how the extension turns GitHub's diff view into a
rendered, commentable document.

## The bridge pattern

The core idea: **never rebuild GitHub's commenting machinery — borrow it.**

> The extension's comment box and reply boxes are its own UI, but every
> submission flows through GitHub's real (hidden) inline forms. Auth, CSRF,
> pending reviews, and permissions are all GitHub's problem, not ours.

The sequence for a new comment:

1. User clicks a rendered block
2. The extension finds the matching diff cell by line number
3. It "primes" the hidden diff table so GitHub's hover machinery has layout
   boxes to work with
4. It hovers the cell, clicks GitHub's *Add comment* button, and waits for the
   form row to mount
5. On submit, it fills the React-controlled textarea with a native value
   setter and clicks GitHub's real submit button

## Source-line mapping

Markdown rendering happens locally with `markdown-it`. Every block token
carries its source line range:

```js
md.core.ruler.push('pmr_source_lines', (state) => {
  for (const token of state.tokens) {
    if (token.map && token.nesting === 1) {
      token.attrSet('data-pmr-start', String(token.map[0] + 1));
      token.attrSet('data-pmr-end', String(token.map[1]));
    }
  }
});
```

Those attributes are the glue between the rendered document and the diff:
highlighting, click-to-comment, and thread anchoring all resolve through them.

## Hard-won GitHub quirks

- The hover *Add comment* button mounts lazily — only after a visibly
  *painted* cell has been hovered once
- `opacity: 0` priming passes GitHub's visibility checks; `visibility: hidden`
  does not
- A `contain: layout paint` ancestor clips anything positioned outside the
  diff container
- GitHub autofocuses its comment textarea on mount, so the bridge pins the
  scroll position while it works
