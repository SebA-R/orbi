// Chrome only injects manifest content scripts into pages loaded after an
// install, update, reload or site access grant. This adds them to the tabs
// that were already open, so hold-to-talk and captions work there too.
// Each script guards against running twice in the same page.

export const CONTENT_SCRIPTS = [
  { files: ["content/hotkey.js"], allFrames: true },
  { files: ["content/subtitles.js"], allFrames: false },
  { files: ["content/context.js"], allFrames: false },
];

const BLOCKED_HOSTS = new Set(["chromewebstore.google.com"]);

export function canInject(url) {
  let u;
  try { u = new URL(url); } catch { return false; }
  if (u.protocol !== "http:" && u.protocol !== "https:") return false;
  if (BLOCKED_HOSTS.has(u.hostname)) return false;
  if (u.hostname === "chrome.google.com" && u.pathname.startsWith("/webstore")) return false;
  return true;
}

// Resolves to the ids of the tabs that got every script. Never throws.
export async function injectIntoOpenTabs(chromeApi = globalThis.chrome) {
  const done = [];
  if (!chromeApi?.scripting?.executeScript) return done;
  let tabs = [];
  try { tabs = await chromeApi.tabs.query({ url: ["http://*/*", "https://*/*"] }); } catch { return done; }
  await Promise.all(tabs.filter((t) => t.id != null && canInject(t.url)).map(async (tab) => {
    try {
      for (const { files, allFrames } of CONTENT_SCRIPTS) {
        await chromeApi.scripting.executeScript({ target: { tabId: tab.id, allFrames }, files });
      }
      done.push(tab.id);
    } catch {
      // No access to this tab (restricted page, discarded, error page): skip it.
    }
  }));
  return done;
}
