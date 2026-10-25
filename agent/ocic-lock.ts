// Button lock for the Open Claude in Chrome path (CLEARCART_BROWSER unset).
//
// That extension is third-party, so the lock runs in our PreToolUse hook
// before each of Claude's browser calls. It uses the same classifier as our
// own extension (extension/content/protect.js), run two ways:
//   - by name, in Node, on the role and name the tab reports for a ref
//     (read_page with ref_id over our own bridge client), and
//   - in the page, through our own bridge client's javascript_tool, for
//     coordinate hit tests, the focused element on Enter/Space, and the
//     page's list of locked controls (so a ref whose name matches a locked
//     control is locked too).
// Every check fails closed: if it cannot run, the call is denied.
//
// Claude itself no longer has javascript_tool on this path (session.ts), so
// it cannot run page script around these checks. The page script runs in
// the page's main world, so a hostile page could tamper with DOM prototypes
// to fool it; our own extension runs the same checks in an isolated world.

import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { callBrowserTool, evalInTab, resultText } from "./bridge.ts";

const require = createRequire(import.meta.url);
const EXT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "extension", "content");

export type Lock = { kind: string; label: string; optin: boolean; checked: boolean };
type ProtectApi = {
  classifyLabel(label: string, opts?: { checkable?: boolean }): string | null;
  normalize(s: string): string;
  isActivationKey(k: string): boolean;
  message(l: Lock): string;
  blocks(l: Lock): boolean;
};
export const Protect: ProtectApi = require(path.join(EXT, "protect.js"));

const MASK_SRC = fs.readFileSync(path.join(EXT, "mask.js"), "utf8");
const PROTECT_SRC = fs.readFileSync(path.join(EXT, "protect.js"), "utf8");

// The classifier inside the page, on a private global object so the page's
// own scripts cannot swap ClearcartProtect for a fake. `body` sees P.
export function pageScript(body: string): string {
  return `(function (globalThis) {
var module = undefined;
${MASK_SRC}
${PROTECT_SRC}
var P = globalThis.ClearcartProtect;
${body}
})({})`;
}

export type Deps = {
  evalInTab: <T = unknown>(tabId: number, code: string) => Promise<T>;
  readRef: (tabId: number, ref: string) => Promise<string>;
};

const defaultDeps: Deps = {
  evalInTab,
  readRef: async (tabId, ref) => resultText(await callBrowserTool("read_page", { tabId, ref_id: ref, filter: "all" })),
};

const LOCK_JSON = "function J(l){ return l ? { kind: l.kind, label: l.label, optin: !!l.optin, checked: !!l.checked } : null; }";

const CLICKS = new Set(["left_click", "right_click", "double_click", "triple_click", "left_click_drag", "left_mouse_down", "left_mouse_up", "diag_input"]);

const UNCHECKED = "Locked: Clearcart could not check what this action would press, so it was not sent.";

function xy(v: unknown): [number, number] | null {
  return Array.isArray(v) && v.length === 2 && v.every((n) => typeof n === "number" && Number.isFinite(n)) ? [v[0], v[1]] : null;
}

// First line of OCIC's read_page for one ref: `role "name" [ref_N] ... type="checkbox"`.
export function parseRefLine(text: string): { role: string; name: string; type: string } | null {
  const line = text.split("\n").find((l) => /\[ref_\d+\]/.test(l));
  if (!line) return null;
  const m = /^\s*(\S+)(?:\s+"((?:[^"\\]|\\.)*)")?\s+\[ref_\d+\]/.exec(line);
  if (!m) return null;
  const type = /\stype="([^"]*)"/.exec(line)?.[1] || "";
  return { role: m[1], name: m[2] || "", type };
}

const CHECKABLE_ROLES = new Set(["checkbox", "radio", "switch", "menuitemcheckbox", "menuitemradio"]);

type PageLock = { name: string; kind: string; optin: boolean; checked: boolean };

// The page's locked controls with their full accessible names.
async function pageLocks(deps: Deps, tabId: number): Promise<PageLock[]> {
  const r = await deps.evalInTab<PageLock[]>(
    tabId,
    pageScript(`return P.listLocks(document, 300).map(function (x) {
  return { name: P.labelOf(x.el), kind: x.lock.kind, optin: !!x.lock.optin, checked: !!x.lock.checked };
});`)
  );
  if (!Array.isArray(r)) throw new Error("no lock list");
  return r;
}

function sameName(a: string, b: string): boolean {
  const x = Protect.normalize(a).trim();
  const y = Protect.normalize(b).trim();
  return !!x && !!y && (x === y || (x.length >= 12 && y.startsWith(x)) || (y.length >= 12 && x.startsWith(y)));
}

// Lock for a ref, by its name and by matching the page's locked controls.
async function refLock(deps: Deps, tabId: number, ref: string): Promise<Lock | null> {
  const text = await deps.readRef(tabId, ref);
  if (/^Error/i.test(text.trim())) throw new Error("ref not found");
  const info = parseRefLine(text);
  if (!info) throw new Error("ref line not understood");
  const checkable = CHECKABLE_ROLES.has(info.role) || info.type === "checkbox" || info.type === "radio";
  const kind = Protect.classifyLabel(info.name, { checkable });
  const label = info.name.slice(0, 60);
  if (kind) return { kind, label, optin: checkable, checked: false };
  const hit = (await pageLocks(deps, tabId)).find((l) => sameName(l.name, info.name));
  return hit ? { kind: hit.kind, label: hit.name.slice(0, 60), optin: hit.optin, checked: hit.checked } : null;
}

async function pointLock(deps: Deps, tabId: number, [x, y]: [number, number]): Promise<Lock | null> {
  return deps.evalInTab<Lock | null>(tabId, pageScript(`${LOCK_JSON} return J(P.lockAt(document, ${x}, ${y}));`));
}

async function keyLock(deps: Deps, tabId: number, key: string): Promise<Lock | null> {
  return deps.evalInTab<Lock | null>(tabId, pageScript(`${LOCK_JSON} return J(P.lockForKey(document, ${JSON.stringify(key)}));`));
}

function falsy(v: unknown): boolean {
  if (typeof v === "boolean") return !v;
  return /^(false|off|no|0|unchecked)$/i.test(String(v).trim());
}

// The deny reason for one of Claude's OCIC browser calls, or null to let it
// through. tool is the bare tool name (no mcp__browser__ prefix).
export async function ocicLockReason(tool: string, args: Record<string, unknown>, deps: Deps = defaultDeps): Promise<string | null> {
  const tabId = typeof args.tabId === "number" ? args.tabId : Number(args.tabId);
  try {
    if (tool === "computer") {
      const action = String(args.action || "");
      if (CLICKS.has(action)) {
        const points = [xy(args.start_coordinate), xy(args.coordinate)].filter((p): p is [number, number] => !!p);
        if (!Number.isFinite(tabId)) return points.length || args.ref ? UNCHECKED : null;
        for (const p of points) {
          const l = await pointLock(deps, tabId, p);
          if (l) return Protect.message(l);
        }
        if (!points.length && typeof args.ref === "string") {
          const l = await refLock(deps, tabId, args.ref);
          if (l && Protect.blocks(l)) return Protect.message(l);
        }
        return null;
      }
      if (action === "key" || action === "type") {
        const keys = action === "key" ? String(args.text || "").split(" ").filter(Boolean) : /[\r\n]/.test(String(args.text || "")) ? ["Enter"] : [];
        const act = keys.filter((k) => Protect.isActivationKey(k));
        if (!act.length) return null;
        if (!Number.isFinite(tabId)) return UNCHECKED;
        for (const k of act) {
          const l = await keyLock(deps, tabId, k);
          if (l) return Protect.message(l);
        }
        return null;
      }
      return null;
    }
    if (tool === "form_input") {
      if (typeof args.ref !== "string" || !Number.isFinite(tabId)) return UNCHECKED;
      const l = await refLock(deps, tabId, args.ref);
      // Unchecking an opt-in is fine; anything else on a locked control is not.
      if (l && !(l.optin && falsy(args.value))) return Protect.message(l);
      return null;
    }
    return null;
  } catch {
    return UNCHECKED;
  }
}

// After read_page or find: a note naming the locked refs, so Claude knows
// not to try them, and the lock badges drawn in the tab.
export async function ocicLockNote(tool: string, args: Record<string, unknown>, output: string, deps: Deps = defaultDeps): Promise<string | null> {
  if (tool !== "read_page" && tool !== "find") return null;
  const tabId = typeof args.tabId === "number" ? args.tabId : Number(args.tabId);
  let page: PageLock[] = [];
  if (Number.isFinite(tabId)) {
    try {
      page = await pageLocks(deps, tabId);
      await deps.evalInTab(tabId, pageScript("return P.showBadges(document);")).catch(() => {});
    } catch {}
  }
  const locked: string[] = [];
  const uncheck: string[] = [];
  const re = /(?:^|\s)(?:\[(ref_\d+)\]\s+)?(\S+)\s+"((?:[^"\\]|\\.)*)"(?:\s+\[(ref_\d+)\])?/;
  for (const line of output.split("\n")) {
    const m = re.exec(line);
    const ref = m && (m[1] || m[4]);
    if (!m || !ref) continue;
    const role = m[2];
    const name = m[3];
    const checkable = CHECKABLE_ROLES.has(role) || /type="(checkbox|radio)"/.test(line);
    const kind = Protect.classifyLabel(name, { checkable });
    const hit = kind ? { optin: checkable } : page.find((l) => sameName(l.name, name));
    if (!hit) continue;
    (hit.optin ? uncheck : locked).push(`${ref} "${name.slice(0, 60)}"`);
  }
  if (!locked.length && !uncheck.length) return null;
  const parts: string[] = [];
  if (locked.length) parts.push(`Locked controls, never press or submit them: ${locked.join(", ")}.`);
  if (uncheck.length) parts.push(`Uncheck only (you may turn these off, never on): ${uncheck.join(", ")}.`);
  return `Button lock: ${parts.join(" ")} Clearcart presses an order button itself only after the user says yes to request_checkout.`;
}
