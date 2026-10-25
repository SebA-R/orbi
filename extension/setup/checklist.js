// The setup checklist, drawn by the setup page and the toolbar popup. Each
// item has a heading, a status line that starts with "Done" or "Needed" (so
// nothing relies on color), and one button. Changes are announced in the
// page's status live region.

import { loadSettings } from "../lib/settings.js";
import { micStateMessage } from "../lib/mic-grant.js";
import {
  EXTENSIONS_PAGE, agentHealth, allReady, hasSiteAccess, keyName, micState, requestSiteAccess, talkKeyHelp, updateBadge,
} from "../lib/setup.js";

const SITE_HELP = "Chrome did not turn it on. Open chrome://extensions, find Orbi and choose Details. Under Site access, choose On all sites.";

function el(tag, attrs = {}, text) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, v);
  if (text != null) node.textContent = text;
  return node;
}

// root: an empty element to draw into. live: the role="status" element.
// level: heading level for the items. onMic: what the mic button does.
export function createChecklist({ root, live, level = 2, onMic, chromeApi = globalThis.chrome }) {
  const items = {};
  const last = {};

  function item(key, title, buttonText) {
    const li = el("li", { class: "item", "data-state": "wait" });
    const h = el(`h${level}`, { id: `${key}-title` }, title);
    const status = el("p", { class: "state", id: `${key}-state`, tabindex: "-1" });
    const mark = el("span", { class: "mark", "aria-hidden": "true" });
    const text = el("span", {}, "Checking.");
    status.append(mark, " ", text);
    const detail = el("p", { class: "hint", id: `${key}-detail`, hidden: "" });
    li.append(h, status, detail);
    let button = null;
    if (buttonText) {
      button = el("button", { type: "button", id: `${key}-button`, "aria-describedby": `${key}-state ${key}-detail` }, buttonText);
      const row = el("div", { class: "row" });
      row.append(button);
      li.append(row);
    }
    items[key] = { li, status, mark, text, detail, button };
    return li;
  }

  const list = el("ul", { class: "checklist" });
  list.append(
    item("site", "Site access on all sites", "Allow on all sites"),
    item("mic", "Microphone", "Allow microphone"),
    item("agent", "Agent server", "Check again"),
    item("key", "Talk key"),
  );
  const extRow = el("div", { class: "row", hidden: "" });
  const extButton = el("button", { type: "button", class: "secondary" }, "Open Orbi's details in Chrome");
  extRow.append(extButton);
  items.site.li.insertBefore(extRow, items.site.detail.nextSibling);

  const keyLink = el("a", { href: "../options/options.html#hotkey" }, "Change the talk key in settings");
  keyLink.addEventListener("click", (e) => {
    e.preventDefault();
    chromeApi.tabs.create({ url: chromeApi.runtime.getURL("options/options.html#hotkey") });
  });
  const keyRow = el("p");
  keyRow.append(keyLink);
  items.key.li.append(keyRow);

  const summary = el("p", { class: "summary", id: "summary", tabindex: "-1" });
  const tryIt = el("p", { class: "hint" }, "Try it: reload any tab that was open before you installed or updated Orbi, then hold the talk key there.");
  root.append(summary, list, tryIt);

  function announce(text) {
    live.textContent = "";
    // Re-set on the next frame so a repeated message is announced again.
    requestAnimationFrame(() => { live.textContent = text; });
  }

  function set(key, ok, text, { detail = "", button = true } = {}) {
    const it = items[key];
    const state = ok ? "ok" : "todo";
    it.li.dataset.state = state;
    it.mark.textContent = ok ? "✓" : "!";
    it.text.textContent = `${ok ? "Done" : "Needed"}: ${text}`;
    it.detail.textContent = detail;
    it.detail.hidden = !detail;
    if (it.button) {
      const hide = !button;
      if (hide && document.activeElement === it.button) it.status.focus();
      it.button.hidden = hide;
    }
    const changed = last[key] !== undefined && last[key] !== state;
    last[key] = state;
    return changed ? `${it.li.querySelector("h" + level).textContent}: ${it.text.textContent}` : null;
  }

  let siteRefused = false;
  let state = null;

  async function refresh({ announceAll = false } = {}) {
    const settings = await loadSettings(chromeApi.storage.local);
    const [site, mic, agent] = await Promise.all([hasSiteAccess(chromeApi), micState(), agentHealth(settings.agentUrl)]);
    state = { site, mic, agent };
    const notes = [];
    notes.push(set("site", site, site ? "Orbi works on every site." : "Orbi is limited to some sites, so the talk key may not work.",
      { detail: !site && siteRefused ? SITE_HELP : "", button: !site }));
    extRow.hidden = site || !siteRefused;
    notes.push(set("mic", mic === "granted", micStateMessage(mic), { button: mic !== "granted" }));
    const voice = agent.voice === true ? "Voice is on." : agent.voice === false ? "Voice is off on the server." : "";
    notes.push(set("agent", agent.connected,
      agent.connected ? `Connected to ${agent.url}. ${voice}`.trim() : `Not connected to ${agent.url}. Start the agent server, then press Check again.`,
      { detail: agent.connected ? "" : `To use a different address, change it in All settings.${site ? "" : " Turning on site access may also fix this check."}` }));
    notes.push(set("key", true, `Your talk key is ${keyName(settings.hotkey)}. ${talkKeyHelp(settings.hotkey)}`));

    const ready = allReady(state);
    const left = [!site, mic !== "granted", !agent.connected].filter(Boolean).length;
    summary.textContent = ready ? "You're set. Hold the talk key on any page to talk to Orbi." : `${left} ${left === 1 ? "step" : "steps"} left.`;
    summary.className = ready ? "summary ready" : "summary";
    updateBadge(chromeApi, [!site && "site", mic !== "granted" && mic !== "unknown" && "mic"].filter(Boolean));

    const changes = notes.filter(Boolean);
    if (announceAll || changes.length) announce([...changes, summary.textContent].join(" "));
    return state;
  }

  items.site.button.addEventListener("click", async () => {
    const ok = await requestSiteAccess(chromeApi);
    if (!ok) siteRefused = true;
    await refresh();
    if (!ok) announce(SITE_HELP);
  });
  extButton.addEventListener("click", () => chromeApi.tabs.create({ url: EXTENSIONS_PAGE(chromeApi.runtime.id) }));
  items.mic.button.addEventListener("click", async () => {
    const message = await onMic();
    await refresh();
    if (message) announce(message);
  });
  items.agent.button.addEventListener("click", () => refresh({ announceAll: true }));

  return {
    refresh,
    items,
    summary,
    get state() { return state; },
    firstNeeded: () => Object.values(items).find((it) => it.li.dataset.state === "todo" && it.button && !it.button.hidden)?.button || null,
  };
}
