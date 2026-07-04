chrome.action.onClicked.addListener((tab) => {
  if (!tab.id) return;
  chrome.tabs.sendMessage(tab.id, { type: "PROMPTDOCK_TOGGLE" }).catch(() => {
    // Content script may not be injected yet (e.g. page just loaded) — ignore.
  });
});
