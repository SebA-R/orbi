// Clearcart service worker (Manifest V3, ES module).
//
// Chrome starts and stops this worker on its own. Everything that must
// survive a restart lives in chrome.storage; listeners are registered at the
// top level so Chrome can wake the worker for them.

const VERSION = chrome.runtime.getManifest().version;

chrome.runtime.onInstalled.addListener(({ reason }) => {
  console.info(`[clearcart] installed (${reason}), version ${VERSION}`);
});

chrome.runtime.onStartup.addListener(() => {
  console.info(`[clearcart] browser started, version ${VERSION}`);
});
