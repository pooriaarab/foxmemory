// The demo's background page. It only opens the Memory page. The model and
// the memories live in the Memory page: Firefox stops an idle background
// page even while it owes a reply, so a slow model load there fails.
browser.action.onClicked.addListener(() => browser.tabs.create({ url: browser.runtime.getURL("memory.html") }));
