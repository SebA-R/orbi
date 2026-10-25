// A small in-memory fake of the chrome.* APIs used by background/tabs.js,
// cdp.js and allowlist.js. Install with installChrome(); it replaces
// globalThis.chrome so each test starts clean.

function event() {
  const ls = new Set();
  return {
    addListener: (f) => ls.add(f),
    removeListener: (f) => ls.delete(f),
    hasListener: (f) => ls.has(f),
    fire: (...a) => [...ls].forEach((f) => f(...a)),
    get size() {
      return ls.size;
    },
  };
}

function area(init = {}) {
  const data = { ...init };
  return {
    data,
    async get(keys) {
      const ks = keys == null ? Object.keys(data) : Array.isArray(keys) ? keys : [keys];
      return Object.fromEntries(ks.filter((k) => k in data).map((k) => [k, data[k]]));
    },
    async set(obj) {
      Object.assign(data, obj);
    },
    async remove(keys) {
      for (const k of Array.isArray(keys) ? keys : [keys]) delete data[k];
    },
  };
}

export function installChrome({ local = {}, session = {}, autoComplete = true } = {}) {
  let nextTab = 100;
  let nextGroup = 1;
  const tabs = new Map();
  const groups = new Map();
  const history = new Map();
  const calls = [];
  const attached = new Set();

  const onUpdated = event();
  const onRemoved = event();
  const groupRemoved = event();
  const onDetach = event();

  const snapshot = (t) => ({ ...t });

  function load(tab, url) {
    tab.url = url;
    tab.status = "loading";
    if (!autoComplete) {
      queueMicrotask(() => onUpdated.fire(tab.id, { status: "loading", url }, snapshot(tab)));
      return;
    }
    setTimeout(() => {
      onUpdated.fire(tab.id, { status: "loading", url }, snapshot(tab));
      setTimeout(() => {
        tab.status = "complete";
        tab.title = `Title of ${url}`;
        onUpdated.fire(tab.id, { status: "complete" }, snapshot(tab));
      }, 5);
    }, 1);
  }

  const chrome = {
    _calls: calls,
    _tabs: tabs,
    _groups: groups,
    _attached: attached,
    storage: { local: area(local), session: area(session) },
    tabs: {
      onUpdated,
      onRemoved,
      async create({ url = "about:blank", active = true, windowId = 1 } = {}) {
        const tab = { id: nextTab++, url, title: "", status: "complete", active, windowId, groupId: -1 };
        if (active) for (const t of tabs.values()) if (t.windowId === windowId) t.active = false;
        tabs.set(tab.id, tab);
        history.set(tab.id, { back: [], fwd: [] });
        if (url !== "about:blank") load(tab, url);
        return snapshot(tab);
      },
      async get(id) {
        const t = tabs.get(id);
        if (!t) throw new Error(`No tab with id: ${id}.`);
        return snapshot(t);
      },
      async query(q = {}) {
        return [...tabs.values()]
          .filter((t) => Object.entries(q).every(([k, v]) => t[k] === v))
          .map(snapshot);
      },
      async update(id, { url, active }) {
        const t = tabs.get(id);
        if (!t) throw new Error(`No tab with id: ${id}.`);
        if (active) t.active = true;
        if (url) {
          const h = history.get(id);
          h.back.push(t.url);
          h.fwd = [];
          load(t, url);
        }
        return snapshot(t);
      },
      async goBack(id) {
        const t = tabs.get(id);
        const h = history.get(id);
        if (!h.back.length) throw new Error("Cannot find a next page in history.");
        h.fwd.push(t.url);
        load(t, h.back.pop());
      },
      async goForward(id) {
        const t = tabs.get(id);
        const h = history.get(id);
        if (!h.fwd.length) throw new Error("Cannot find a next page in history.");
        h.back.push(t.url);
        load(t, h.fwd.pop());
      },
      async group({ tabIds, groupId, createProperties }) {
        const ids = Array.isArray(tabIds) ? tabIds : [tabIds];
        let gid = groupId;
        if (gid == null) {
          gid = nextGroup++;
          groups.set(gid, { id: gid, title: "", color: "grey", windowId: createProperties?.windowId ?? 1 });
        } else if (!groups.has(gid)) {
          throw new Error(`No group with id: ${gid}.`);
        }
        for (const id of ids) tabs.get(id).groupId = gid;
        return gid;
      },
      async remove(id) {
        const t = tabs.get(id);
        tabs.delete(id);
        onRemoved.fire(id, { windowId: t?.windowId, isWindowClosing: false });
        if (t && t.groupId !== -1 && ![...tabs.values()].some((x) => x.groupId === t.groupId)) {
          const g = groups.get(t.groupId);
          groups.delete(t.groupId);
          groupRemoved.fire(g);
        }
      },
    },
    tabGroups: {
      onRemoved: groupRemoved,
      async get(id) {
        const g = groups.get(id);
        if (!g) throw new Error(`No group with id: ${id}.`);
        return { ...g };
      },
      async query(q = {}) {
        return [...groups.values()].filter((g) => Object.entries(q).every(([k, v]) => g[k] === v)).map((g) => ({ ...g }));
      },
      async update(id, props) {
        Object.assign(groups.get(id), props);
        return { ...groups.get(id) };
      },
    },
    debugger: {
      onDetach,
      async attach({ tabId }, version) {
        calls.push(["attach", tabId, version]);
        if (!tabs.has(tabId)) throw new Error(`No tab with given id ${tabId}.`);
        if (attached.has(tabId)) throw new Error("Another debugger is already attached to the tab with id: " + tabId + ".");
        attached.add(tabId);
      },
      async detach({ tabId }) {
        calls.push(["detach", tabId]);
        if (!attached.delete(tabId)) throw new Error(`Debugger is not attached to the tab with id: ${tabId}.`);
      },
      async sendCommand({ tabId }, method, params) {
        if (!attached.has(tabId)) throw new Error(`Debugger is not attached to the tab with id: ${tabId}.`);
        calls.push(["send", tabId, method, params]);
        if (method === "Page.captureScreenshot") return { data: "BASE64JPEG" };
        return {};
      },
    },
  };
  globalThis.chrome = chrome;
  return chrome;
}
