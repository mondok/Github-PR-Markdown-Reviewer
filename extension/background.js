// Toolbar button: toggle all markdown files on the current PR to rendered view.
chrome.action.onClicked.addListener((tab) => {
  if (!tab.id) return;
  chrome.tabs.sendMessage(tab.id, { type: 'pmr-toggle-all' }).catch(() => {
    // No content script on this page (not github.com) — nothing to do.
  });
});
