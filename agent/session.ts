// One voice session = one Claude Agent SDK conversation.
//
// User turns stream into a single long-lived query() as SDKUserMessages, so
// the conversation keeps its context across turns. While request_checkout is
// waiting, the next user_text is routed to it instead of to Claude.
//
// Barge-in: {type:"interrupt"} from the client (the user held the talk key)
// mutes the turn in progress. Its held text is dropped, anything it still
// says goes out as a "(not spoken)" status, and the SDK turn is interrupted.
// The next turn speaks again. An interrupt during a checkout read-back only
// stops the speech: the read-back keeps waiting for a spoken answer.

import dns from "node:dns";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createSdkMcpServer, query, tool, type HookCallback, type Query, type SDKMessage, type SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";

import { callBrowserTool, evalInTab, resultText } from "./bridge.ts";
import { extBridge, extMode, TOOLS as EXT_TOOLS } from "./extbridge.ts";
import { createExtToolsServer } from "./exttools.ts";
import { withContext, type PageContext } from "./context.ts";
import { ocicDangerMode, ocicLockNote, ocicLockReason, pageScript, Protect } from "./ocic-lock.ts";
import { isLocalIp } from "./blocklist.ts";
import { isCheckoutUrl, originOf, SITE_POLICY, siteBlockReason, STORE_ORIGIN, type SitePolicy } from "./origins.ts";
import { checkoutSnapshot, payNow, type Confirmation, type PayState } from "./pay.ts";
import { buildSystemPrompt, EXT_TABS_PROMPT, guidedNote } from "./prompt.ts";
import {
  decideUnlock,
  isDirectAsk,
  lockInfoExt,
  ocicLockInfoScript,
  ocicPressScript,
  pressUnlockedExt,
  userUnlockGate,
  type LockInfo,
  type UnlockClass,
} from "./user-unlock.ts";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const MODEL = process.env.CLEARCART_MODEL || "claude-sonnet-5-5";
const BROWSER_SERVER =
  process.env.OCIC_SERVER || "/Users/sebastianarellano-rubach/code/open-claude-in-chrome/host/mcp-server.js";

// Which sites may be browsed comes from origins.ts (CLEARCART_BROWSE_MODE:
// open web minus a blocklist, or the allowlist). pay_now stays store-only
// and the unlock gate only serves CLEARCART_PAY_ORIGINS.

const B = "mcp__browser__";
const C = "mcp__clearcart__";

// Tools Claude never gets. execute_code is the big one: its sandbox can call
// every browser tool from inside one call, which would step around the
// per-tool guard below. javascript_tool would let page script press a
// locked button (button lock); pay_now still uses it over our own bridge
// client, which Claude cannot reach.
export const DISALLOWED_BROWSER = [
  "execute_code",
  "javascript_tool",
  "gif_creator",
  "read_network_requests",
  "file_upload",
  "upload_image",
  "switch_browser",
  "set_config",
  "get_config",
  "debug",
  "debug_timings",
  "recording_ack",
  "retranscribe_recording",
  "shortcuts_list",
  "shortcuts_execute",
  "resize_window",
  "update_plan",
].map((t) => B + t);

export const ALLOWED = [
  "tabs_context_mcp",
  "tabs_create_mcp",
  "tabs_close_mcp",
  "navigate",
  "computer",
  "find",
  "form_input",
  "get_page_text",
  "read_page",
  "read_console_messages",
  "set_tab_focus",
].map((t) => B + t).concat([C + "say", C + "request_checkout", C + "pay_now", C + "request_unlock"]);

// Blocked while card values sit in the checkout form: anything that can read
// or screenshot the page, or change it.
const BLOCKED_WHILE_CARD_LIVE = new Set(
  ["computer", "read_page", "get_page_text", "find", "form_input", "javascript_tool", "read_console_messages"].map((t) => B + t)
);

// CLEARCART_BROWSER=ext: Claude's browser tools are the Clearcart extension's
// TOOLS (exttools.ts), same mcp__browser__ prefix. Screenshot, click, type,
// key and scroll stand in for "computer" in the card-live block list.
const EXT_ALLOWED = EXT_TOOLS.map((t) => B + t).concat([C + "say", C + "request_checkout", C + "pay_now", C + "request_unlock"]);
const EXT_BLOCKED_WHILE_CARD_LIVE = new Set(
  ["screenshot", "click", "type", "key", "scroll", "read_page", "get_page_text", "find", "form_input"].map((t) => B + t)
);

function extPrompt(prompt: string): string {
  return prompt.replace(
    "calling tabs_context_mcp with createIfEmpty true, then use a tab in the MCP group.",
    "calling tabs_context. Use a tab already on the store, or open one with tabs_create."
  ) + EXT_TABS_PROMPT;
}

// The user's Guided mode setting: the extension's in ext mode, on until it
// says otherwise (Clearcart is built for blind and low-vision users).
// Elsewhere CLEARCART_GUIDED=0 turns it off.
export function currentGuided(): boolean {
  return extMode() ? (extBridge.guidedMode() ?? true) : process.env.CLEARCART_GUIDED !== "0";
}

// How long a user turn waits for page_context before going without it.
const CONTEXT_TIMEOUT_MS = 1_500;

// In ext mode the extension's blocked sites list replaces the suggested one
// once it has sent it.
export function sitePolicy(): SitePolicy {
  const entries = extMode() ? extBridge.blocklist() : null;
  return entries ? { ...SITE_POLICY, entries } : SITE_POLICY;
}

// The browse policy for a URL Claude asked to open (navigate, tabs_create).
// Null when it may open.
export function browseDenyReason(url: string, policy: SitePolicy = sitePolicy()): string | null {
  if (url === "back" || url === "forward") return null;
  const why = siteBlockReason(url, policy);
  if (!why) return null;
  if (policy.mode === "allowlist") return `Blocked: Clearcart only browses ${[...policy.allowed].join(", ")}.`;
  return `Blocked: Clearcart does not open ${originOf(url) || "that page"} (${why}). Tell the user if they asked for it.`;
}

const BLANK = /^(about:blank|chrome:\/\/newtab)/;
// The sweep also leaves chrome-error://chromewebdata/ alone: the extension's
// name for its "Can't reach this site" page (extension/background/errpage.js),
// which holds nothing. Only the sweep: the OCIC tab guard keeps BLANK, since
// Chrome's own error page names the host it failed on.
const SWEEP_BLANK = /^(about:blank|chrome:\/\/newtab|chrome-error:\/\/chromewebdata\/?$)/;

// Tools that act on an existing tab's page. On the Open Claude in Chrome
// path the guard checks that tab's current URL first (a redirect or page
// script can move it after navigate was checked). Our extension checks the
// tab itself (tabs.js resolveAllowedTab).
const TAB_TOOLS = new Set(["computer", "find", "form_input", "get_page_text", "read_page", "read_console_messages", "set_tab_focus"].map((t) => B + t));

type Tab = { tabId: number; url?: string };
type Lookup = (host: string) => Promise<Array<{ address: string }>>;

const DNS_TIMEOUT_MS = 1500;
const DNS_TTL_MS = 60_000;
const dnsCache = new Map<string, { local: boolean; at: number }>();
const systemLookup: Lookup = (host) => dns.promises.lookup(host, { all: true });

// Why `url` may not be opened because its host name resolves to this
// computer or the local network (localtest.me, a DNS rebinding domain), or
// null. Allowed origins (the store) and IP literals (blocklist.ts judges
// those) are skipped. A name that does not resolve here passes: the browser
// uses the same resolver, so it cannot load it either.
export async function localDnsReason(url: string, policy: SitePolicy = sitePolicy(), lookup: Lookup = systemLookup): Promise<string | null> {
  const o = originOf(url);
  if (!o || policy.allowed.has(o)) return null;
  const host = new URL(url).hostname.toLowerCase();
  if (host.startsWith("[") || /^[\d.]+$/.test(host)) return null;
  const hit = dnsCache.get(host);
  let local = hit && Date.now() - hit.at < DNS_TTL_MS ? hit.local : null;
  if (local === null) {
    const addrs = await Promise.race([lookup(host), new Promise<null>((r) => setTimeout(() => r(null), DNS_TIMEOUT_MS).unref?.())]).catch(() => null);
    if (!addrs) return null;
    local = addrs.some((a) => isLocalIp(a.address));
    dnsCache.set(host, { local, at: Date.now() });
  }
  return local ? `Blocked: Clearcart does not open ${o} (it points to this computer or the local network). Tell the user if they asked for it.` : null;
}

function tabIdOf(args: Record<string, unknown>): number | null {
  if (typeof args.tabId === "number") return args.tabId;
  if (typeof args.tabId === "string" && /^\d+$/.test(args.tabId)) return Number(args.tabId);
  return null;
}

// Tab sweep: any Clearcart-group tab whose page is not allowed (a clicked
// link, a redirect, history) is sent away from it. Allowlist mode: to the
// store home page. Open mode: back to the page before, or to the store home
// page when going back does not land somewhere allowed. `nav` loads a URL
// (or "back") in a tab and returns where the tab ended up, or null.
export async function returnStrays(
  tabs: Array<{ tabId: number; url?: string }>,
  nav: (tabId: number, url: string) => Promise<string | null>,
  policy: SitePolicy = sitePolicy()
): Promise<number> {
  const strays = tabs.filter((t) => isStrayTab(t.url, policy));
  for (const t of strays) {
    if (policy.mode === "open") {
      const at = await nav(t.tabId, "back").catch(() => null);
      if (at && (SWEEP_BLANK.test(at) || !strayReason(at, policy))) continue;
    }
    await nav(t.tabId, STORE_ORIGIN + "/").catch(() => null);
  }
  return strays.length;
}

export function sweepNote(n: number, policy: SitePolicy = sitePolicy()): string {
  return policy.mode === "open"
    ? `A tab opened a blocked site or a checkout page and was sent back${n > 1 ? " (" + n + " tabs)" : ""}. Never open sites on the user's blocked list; tell the user instead.`
    : `A tab left the allowed sites and was sent back to the store home page. Only browse ${[...policy.allowed].join(", ")}.`;
}

// Button lock for navigation: checkout and payment pages are off limits on
// every site except the store, where pay_now runs. Both browser paths, for
// navigate and for tabs_create / tabs_create_mcp with a url. passed: true
// when the user asked to go to checkout on this tab and origin
// (request_unlock's checkout pass), which lifts the block for that visit.
export function navigateLockReason(url: string, passed?: (url: string) => boolean): string | null {
  if (url === "back" || url === "forward") return null;
  if (isCheckoutUrl(url) && originOf(url) !== STORE_ORIGIN && !passed?.(url)) {
    return "Locked: Clearcart does not open checkout or payment pages on this site. Stop at the cart and tell the user.";
  }
  return null;
}

// Why the sweep sends a tab away from url, or null: a blocked site, or a
// checkout page navigate would have refused (a redirect or an in-page link
// can land there).
export function strayReason(url: string, policy: SitePolicy = sitePolicy()): string | null {
  return siteBlockReason(url, policy) || navigateLockReason(url);
}

export function isStrayTab(url: string | undefined, policy: SitePolicy = sitePolicy()): boolean {
  return !!url && !SWEEP_BLANK.test(url) && !!strayReason(url, policy);
}

// Text of an MCP tool result as the PostToolUse hook receives it.
function responseText(r: unknown): string {
  if (typeof r === "string") return r;
  const items = Array.isArray(r) ? r : Array.isArray((r as any)?.content) ? (r as any).content : [];
  return items.filter((c: any) => c && c.type === "text").map((c: any) => String(c.text ?? "")).join("\n");
}

export type ServerMessage =
  | { type: "agent_text"; text: string }
  | { type: "status"; text: string }
  | { type: "receipt"; item: string; total: string; last4: string }
  // Sent just before the read-back is spoken, so a screen can show the order
  // without parsing the sentence. Clients ignore types they do not know.
  | { type: "confirm"; item: string; quantity: number; total: string; changes: string }
  // How that read-back ended: paid, declined by the user, or failed (payment
  // not completed or the agent hit an error).
  | { type: "confirm_done"; outcome: "paid" | "declined" | "failed" };

// The whole answer must be a yes: affirmative phrases plus polite filler and
// nothing else, so "yes, but two of them", "do it later" or "pay attention"
// are not a yes. Longer phrases first so "pay now" is not read as "pay".
const AFFIRMATIVE = ["place the order", "place order", "go ahead", "pay now", "do it", "confirmed", "confirm", "yes", "yeah", "yep", "yup", "pay"];
const FILLER = ["thank you", "all right", "please", "thanks", "okay", "ok", "alright", "sure"];

export function isExplicitYes(text: string): boolean {
  let rest = ` ${text.toLowerCase().replace(/[^a-z\s]/g, " ").replace(/\s+/g, " ").trim()} `;
  let affirmed = false;
  for (let progress = true; progress && rest.trim(); ) {
    progress = false;
    for (const [phrase, strong] of [...AFFIRMATIVE.map((p) => [p, true] as const), ...FILLER.map((p) => [p, false] as const)]) {
      if (rest.startsWith(` ${phrase} `)) {
        rest = rest.slice(phrase.length + 1);
        affirmed ||= strong;
        progress = true;
        break;
      }
    }
  }
  return affirmed && !rest.trim();
}

// Danger mode, the user's setting: from the extension over the bridge
// (extBridge.dangerMode), or CLEARCART_DANGER_MODE on the Open Claude in
// Chrome path. Only for the spoken notice: the lock itself is enforced where
// the clicks are checked (the extension, ocic-lock.ts). It never touches
// request_checkout, pay_now, the unlock gates, masking or the blocklist.
export const DANGER_LINE = "Danger mode is on.";
export function dangerModeOn(): boolean {
  return extMode() ? extBridge.dangerMode() : ocicDangerMode();
}

class InputQueue implements AsyncIterable<SDKUserMessage> {
  private items: SDKUserMessage[] = [];
  private waiters: Array<(r: IteratorResult<SDKUserMessage>) => void> = [];
  private closed = false;

  push(text: string) {
    const msg: SDKUserMessage = { type: "user", message: { role: "user", content: text }, parent_tool_use_id: null };
    const w = this.waiters.shift();
    if (w) w({ value: msg, done: false });
    else this.items.push(msg);
  }

  close() {
    this.closed = true;
    for (const w of this.waiters.splice(0)) w({ value: undefined as any, done: true });
  }

  [Symbol.asyncIterator](): AsyncIterator<SDKUserMessage> {
    return {
      next: () => {
        const item = this.items.shift();
        if (item) return Promise.resolve({ value: item, done: false });
        if (this.closed) return Promise.resolve({ value: undefined as any, done: true });
        return new Promise((resolve) => this.waiters.push(resolve));
      },
    };
  }
}

// The checkout pass: set only after the user asked to go to checkout and
// the "Proceed to checkout" control was pressed. That one tab may stay on
// checkout pages of that origin. It must land within PASS_LAND_MS, ends
// when the tab leaves checkout pages or after PASS_MAX_MS, and lets Claude
// navigate there at most once (navUsed). Never covers a blocked site, and
// never lets Claude pay (Place order stays locked).
export const PASS_LAND_MS = 30_000;
export const PASS_MAX_MS = 2 * 60_000;
export type CheckoutPass = { tabId: number; origin: string; landBy: number; until: number; landed: boolean; navUsed?: boolean };

export function passCovers(pass: CheckoutPass | null, tabId: number | null, url: string | undefined, now = Date.now()): boolean {
  if (!pass || tabId == null || !url || pass.tabId !== tabId) return false;
  if (now > pass.until || (!pass.landed && now > pass.landBy)) return false;
  return originOf(url) === pass.origin && isCheckoutUrl(url);
}

// How long the user's last words count for request_unlock's direct match.
export const USER_WORDS_TTL_MS = 60_000;

// The user's most recent words, bound to the tab Clearcart was on when they
// spoke and that tab's origin then. spent: unlock classes already pressed
// for these words. passwordYes: these words are an explicit yes to an
// earlier "type your password, then tell me" for that sign in.
type UserWords = {
  text: string;
  spent: Set<string>;
  at: number;
  tabId: number | null;
  origin: Promise<string | null>;
  passwordYes: { tabId: number; label: string; origin: string } | null;
};

type ToolText = { content: Array<{ type: "text"; text: string }> };
const said = (text: string): ToolText => ({ content: [{ type: "text", text }] });

export class Session {
  private input = new InputQueue();
  private abort = new AbortController();
  private awaitingAnswer: ((text: string | null) => void) | null = null;
  private state: PayState = { lastTabId: null, confirmation: null, cardFieldsLive: false };
  private closed = false;
  private q: Query | null = null;
  // The user's most recent words, for request_unlock's direct-ask match.
  private lastUser: UserWords = { text: "", spent: new Set(), at: 0, tabId: null, origin: Promise.resolve(null), passwordYes: null };
  // A sign in the user asked for before typing their own password. Lives
  // only until the next utterance, which becomes passwordYes if it is an
  // explicit yes.
  private passwordAsk: { tabId: number; label: string; origin: string } | null = null;
  checkoutPass: CheckoutPass | null = null;
  // Set when a tab sweep could not run or could not move a stray tab. Every
  // browser call is refused until a sweep succeeds (fail closed).
  private sweepBroken = false;
  // DNS for localDnsReason; tests replace it.
  lookup: Lookup = systemLookup;
  // What the user is looking at, attached to each user turn (ext mode).
  // Null: no context. Tests replace it.
  pageContext: (() => Promise<PageContext>) | null = extMode()
    ? () => extBridge.call<PageContext>("page_context", {}, CONTEXT_TIMEOUT_MS)
    : null;
  // Keeps user turns in order while their context is fetched.
  private turns: Promise<void> = Promise.resolve();
  // User turns sent to the SDK whose result has not come back yet.
  private turnsOpen = 0;
  // The turn in progress was interrupted: nothing more from it is spoken.
  private muted = false;
  // Reply text of the current turn, spoken when the turn ends (see onSdkMessage).
  private held: string[] = [];
  // Guided mode as the model last heard it: the system prompt's at the
  // start, then the last note sent with a user turn (see withGuidedNote).
  guided = currentGuided();

  // "Danger mode is on." was spoken in this session.
  private dangerSaid = false;

  constructor(private send: (m: ServerMessage) => void) {}

  userText(text: string) {
    if (this.closed || !text.trim()) return;
    const tabId = this.state.lastTabId;
    const pw = this.passwordAsk;
    this.passwordAsk = null;
    this.lastUser = {
      text,
      spent: new Set(),
      at: Date.now(),
      tabId,
      origin: tabId == null ? Promise.resolve(null) : this.tabUrl(tabId).then((u) => originOf(u)),
      passwordYes: pw && isExplicitYes(text) ? pw : null,
    };
    if (this.awaitingAnswer) {
      const resolve = this.awaitingAnswer;
      this.awaitingAnswer = null;
      resolve(text);
      return;
    }
    if (!this.dangerSaid && dangerModeOn()) {
      this.dangerSaid = true;
      this.status("Danger mode is on: sign in and sign up are not locked; paying still needs the user's yes");
      this.say(DANGER_LINE);
    }
    // Counted now, while its context is fetched, so an interrupt sees it.
    this.turnsOpen++;
    const fetch = this.pageContext;
    if (!fetch) return this.input.push(this.withGuidedNote(text));
    const ctx = Promise.race([
      fetch().catch(() => null),
      new Promise<null>((r) => setTimeout(() => r(null), CONTEXT_TIMEOUT_MS + 200).unref?.()),
    ]);
    this.turns = this.turns.then(async () => {
      const c = await ctx;
      if (!this.closed) this.input.push(withContext(this.withGuidedNote(text), c, process.env.CLEARCART_ALLOW_ANY_SITE ? undefined : sitePolicy()));
    });
    return this.turns;
  }

  // The system prompt is fixed for a session, so a Guided mode change made
  // after it started goes in front of the user's words in the next turn
  // (after the context block, which starts the turn).
  private withGuidedNote(turn: string): string {
    const now = currentGuided();
    if (now === this.guided) return turn;
    this.guided = now;
    return `${guidedNote(now)}\n\n${turn}`;
  }

  // The user started talking over us.
  interrupt() {
    if (this.closed) return;
    this.stopActions();
    this.held.forEach((t) => this.unspoken(t));
    this.held = [];
    // A read-back waiting for an answer is not cancelled or confirmed by a
    // barge-in; the user is about to answer it.
    if (this.awaitingAnswer || this.turnsOpen === 0 || this.muted) return;
    this.muted = true;
    this.status("interrupted by the user");
    this.q?.interrupt().catch((e) => this.status(`interrupt failed: ${(e as Error).message}`));
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    this.awaitingAnswer?.(null);
    this.awaitingAnswer = null;
    this.input.close();
    this.abort.abort();
  }

  // Stops any paced click, typing or scroll the extension is still playing.
  private stopActions() {
    if (!extMode() || !extBridge.connected()) return;
    extBridge.call("actions_stop", {}, 5_000).catch(() => {});
  }

  private say(text: string) {
    if (this.muted) return this.unspoken(text);
    this.send({ type: "agent_text", text });
  }

  private unspoken(text: string) {
    this.status(`(not spoken) ${text.slice(0, 120)}`);
  }

  private status(text: string) {
    this.send({ type: "status", text });
  }

  private guard: HookCallback = async (input) => {
    if (input.hook_event_name !== "PreToolUse") return {};
    const name = input.tool_name;
    const args = (input.tool_input || {}) as Record<string, unknown>;
    const deny = (reason: string) => ({
      hookSpecificOutput: { hookEventName: "PreToolUse" as const, permissionDecision: "deny" as const, permissionDecisionReason: reason },
    });

    if (name.startsWith(B)) {
      const checkSites = !process.env.CLEARCART_ALLOW_ANY_SITE;
      if (checkSites && this.sweepBroken) {
        const ok = await this.runSweep().then(() => true, () => false);
        if (!ok) return deny("Blocked: Clearcart could not check which sites its tabs are on, so browser tools are paused. Try again in a moment, and tell the user if it keeps failing.");
      }
      if (this.state.cardFieldsLive && (extMode() ? EXT_BLOCKED_WHILE_CARD_LIVE : BLOCKED_WHILE_CARD_LIVE).has(name)) {
        return deny("Blocked: card details are in the checkout form. Wait for pay_now to finish.");
      }
      const opens = name === B + "navigate" || ((name === B + "tabs_create" || name === B + "tabs_create_mcp") && args.url != null);
      if (opens && checkSites) {
        const url = String(args.url || "");
        const blocked = browseDenyReason(url) || (url === "back" || url === "forward" ? null : await localDnsReason(url, sitePolicy(), this.lookup));
        if (blocked) return deny(blocked);
      }
      if (opens) {
        const navTab = name === B + "navigate" ? tabIdOf(args) ?? this.state.lastTabId : null;
        const locked = navigateLockReason(String(args.url || ""), (u) => this.useCheckoutPass(navTab, u));
        if (locked) return deny(locked);
      }
      if (checkSites && !extMode() && TAB_TOOLS.has(name)) {
        const why = await this.tabDenyReason(tabIdOf(args));
        if (why) return deny(why);
      }
      // Button lock, OCIC path: our own extension enforces it in the
      // extension; here the third-party one gets it from this hook.
      if (!extMode()) {
        const locked = await ocicLockReason(name.slice(B.length), args);
        if (locked) {
          this.status(`locked: ${name.slice(B.length)}`);
          return deny(locked);
        }
      }
      const tabId = tabIdOf(args);
      if (tabId != null) this.state.lastTabId = tabId;
    }
    return {};
  };

  // OCIC path: after read_page or find, name the locked refs for Claude and
  // draw the lock badges in the tab. Our own extension does both itself.
  private lockNotes: HookCallback = async (input) => {
    if (input.hook_event_name !== "PostToolUse" || !input.tool_name.startsWith(B) || extMode()) return {};
    const note = await ocicLockNote(
      input.tool_name.slice(B.length),
      (input.tool_input || {}) as Record<string, unknown>,
      responseText((input as any).tool_response)
    ).catch(() => null);
    if (!note) return {};
    return { hookSpecificOutput: { hookEventName: "PostToolUse" as const, additionalContext: note } };
  };

  // The browser's agent tabs: the MCP group, or on our extension the tabs
  // Clearcart opened (agent_tabs; the user's own tabs are never
  // swept). Throws when the list cannot be read.
  async listTabs(): Promise<Tab[]> {
    if (extMode()) return (await extBridge.call<{ tabs?: Tab[] }>("agent_tabs", {}, 10_000))?.tabs || [];
    return JSON.parse(resultText(await callBrowserTool("tabs_context_mcp", {})).split("\n")[0]).availableTabs || [];
  }

  // Loads `url` (or "back") in a tab and returns where it ended up. Our
  // extension's navigate reports that (and refuses a landing it does not
  // allow); the OCIC one does not, so list again.
  async navTab(tabId: number, url: string): Promise<string | null> {
    if (extMode()) return (await extBridge.call<{ url?: string }>("navigate", { url, tabId }))?.url ?? null;
    await callBrowserTool("navigate", { url, tabId });
    return (await this.listTabs()).find((t) => t.tabId === tabId)?.url ?? null;
  }

  // Sends back every agent tab on a site it may not be on (returnStrays) and
  // checks none is left. Returns how many moved; throws when the tabs cannot
  // be listed or a stray would not move. Clears sweepBroken on success.
  private async runSweep(): Promise<number> {
    const policy = sitePolicy();
    const n = await returnStrays(this.passTabs(await this.listTabs(), policy), (id, url) => this.navTab(id, url), policy);
    if (n) {
      const left = this.passTabs(await this.listTabs(), policy).filter((t) => isStrayTab(t.url, policy));
      if (left.length) throw new Error(`${left.length} tab(s) still on a blocked site`);
    }
    this.sweepBroken = false;
    return n;
  }

  // Claude's one navigate on the checkout pass: true at most once per pass.
  useCheckoutPass(tabId: number | null, url: string): boolean {
    const p = this.checkoutPass;
    if (!p || p.navUsed || !passCovers(p, tabId, url)) return false;
    p.navUsed = true;
    return true;
  }

  // The user's last words if they still count for this tab and its origin
  // (bound when spoken, USER_WORDS_TTL_MS), else empty words.
  private async wordsFor(tabId: number, href: string): Promise<UserWords | null> {
    const w = this.lastUser;
    if (!w.text || w.tabId !== tabId || Date.now() - w.at > USER_WORDS_TTL_MS) return null;
    const origin = await w.origin;
    return origin && origin === originOf(href) ? w : null;
  }

  // The tabs the sweep checks: the checkout pass tab is left out while it is
  // on a checkout page of its origin (and not on a blocked site). Updates
  // the pass: landed once seen there, ended once the tab leaves.
  private passTabs(tabs: Tab[], policy: SitePolicy): Tab[] {
    const p = this.checkoutPass;
    if (!p) return tabs;
    const now = Date.now();
    const t = tabs.find((x) => x.tabId === p.tabId);
    if (!t || now > p.until || (!p.landed && now > p.landBy)) {
      this.checkoutPass = null;
      return tabs;
    }
    if (passCovers(p, t.tabId, t.url, now) && !siteBlockReason(t.url!, policy)) {
      p.landed = true;
      return tabs.filter((x) => x !== t);
    }
    if (p.landed) this.checkoutPass = null;
    return tabs;
  }

  // OCIC path: why the tab a page tool would act on may not be touched, or
  // null. Unknown counts as blocked (fail closed). A tab found on a blocked
  // site is swept right away.
  private async tabDenyReason(tabId: number | null): Promise<string | null> {
    let tabs: Tab[];
    try {
      tabs = await this.listTabs();
    } catch {
      return "Blocked: Clearcart could not check which page that tab is on. Try again in a moment.";
    }
    const targets = tabId == null ? tabs : tabs.filter((t) => t.tabId === tabId);
    if (tabId != null && !targets.length) return `Blocked: tab ${tabId} is not one of Clearcart's tabs. Call tabs_context_mcp for the current tabs.`;
    const policy = sitePolicy();
    const bad: Tab[] = [];
    for (const t of targets) {
      if (!t.url) return "Blocked: Clearcart could not check which page that tab is on. Try again in a moment.";
      if (BLANK.test(t.url)) continue;
      if (siteBlockReason(t.url, policy) || (await localDnsReason(t.url, policy, this.lookup))) bad.push(t);
    }
    if (!bad.length) return null;
    const n = await this.runSweep().catch(() => {
      this.sweepBroken = true;
      return -1;
    });
    if (n > 0) this.status(`returned ${n} tab(s) from blocked sites`);
    return `Blocked: that tab is on a site Clearcart does not use (${originOf(bad[0].url) || "unknown"}). ${n >= 0 ? sweepNote(Math.max(n, 1)) : "Browser tools are paused until Clearcart can send it back."}`;
  }

  // After every browser call, send back any agent tab that landed on a site
  // it may not be on. Fails closed: if the sweep cannot run, Claude is told
  // and the guard refuses browser calls until a sweep succeeds.
  private sweep: HookCallback = async (input) => {
    if (input.hook_event_name !== "PostToolUse" || !input.tool_name.startsWith(B)) return {};
    if (process.env.CLEARCART_ALLOW_ANY_SITE) return {};
    let n: number;
    try {
      n = await this.runSweep();
    } catch (e) {
      this.sweepBroken = true;
      this.status(`tab sweep failed: ${(e as Error).message}`);
      return {
        hookSpecificOutput: {
          hookEventName: "PostToolUse" as const,
          additionalContext: "Clearcart could not check which sites its tabs are on after that call. Browser tools are paused until the check works again; do not rely on what that page showed.",
        },
      };
    }
    if (!n) return {};
    this.status(`returned ${n} tab(s) from blocked sites`);
    return { hookSpecificOutput: { hookEventName: "PostToolUse" as const, additionalContext: sweepNote(n) } };
  };

  // The request_checkout tool body: read the order back and wait for the answer.
  async requestCheckout({ item, quantity, total, changes }: { item: string; quantity: number; total: string; changes?: string }) {
    // The user cut this turn off: they never heard a read-back, so no yes can count.
    if (this.muted) {
      this.status("checkout not read back: the user interrupted");
      return { content: [{ type: "text" as const, text: "declined. The user interrupted before the order was read back." }] };
    }
    // Pin the yes to this checkout tab and the cart on it (pay.ts). Taken while
    // the read-back plays; if it can't be read in 5 s the tab stays unknown and
    // pay_now refuses (fail closed).
    const conf: Confirmation = { item, quantity, total, state: "pending", tabId: null, cart: "" };
    this.state.confirmation = conf;
    // No browser tab used yet: nothing to pin, and pay_now will refuse.
    const snap = this.state.lastTabId == null ? Promise.resolve({ tabId: null, cart: "" }) : Promise.race([
      checkoutSnapshot(this.state.lastTabId),
      new Promise<{ tabId: null; cart: string }>((r) => setTimeout(() => r({ tabId: null, cart: "" }), 5_000).unref()),
    ]);
    const changed = changes?.trim() ? changes.trim().replace(/([^.!?])$/, "$1.") : "";
    this.send({ type: "confirm", item, quantity, total, changes: changed });
    this.say(`You're buying ${quantity} ${item} for ${total}.${changed ? ` ${changed}` : ""} Say yes to pay, or no to change it.`);
    const answer = await new Promise<string | null>((resolve) => {
      this.awaitingAnswer = resolve;
    });
    Object.assign(conf, await snap);
    if (answer !== null && isExplicitYes(answer) && this.state.confirmation === conf) {
      conf.state = "confirmed";
      conf.confirmedAt = Date.now();
      this.status("checkout confirmed");
      return { content: [{ type: "text" as const, text: "confirmed" }] };
    }
    conf.state = "declined";
    this.status("checkout declined");
    this.send({ type: "confirm_done", outcome: "declined" });
    return { content: [{ type: "text" as const, text: `declined. The user said: ${JSON.stringify(answer ?? "")}` }] };
  }

  // Where a tab is now, on either browser path, or null.
  private async tabUrl(tabId: number): Promise<string | null> {
    try {
      if (extMode()) return (await extBridge.call<{ url?: string }>("tab_info", { tabId }, 10_000))?.url ?? null;
      return (await this.listTabs()).find((t) => t.tabId === tabId)?.url ?? null;
    } catch {
      return null;
    }
  }

  private async lockInfo(tabId: number, ref: string | undefined, label: string): Promise<LockInfo> {
    if (extMode()) {
      if (!ref) throw new Error("pass the control's ref from read_page or find");
      return lockInfoExt(extBridge, tabId, ref);
    }
    return (await evalInTab<LockInfo>(tabId, pageScript(ocicLockInfoScript(label)))) || { locked: false };
  }

  // Presses the control once with a fresh single-use grant.
  private async pressUnlocked(tabId: number, ref: string, label: string, cls: UnlockClass): Promise<string | null> {
    const issued = userUnlockGate.issue({ tabId, href: await this.tabUrl(tabId), ref, label, cls });
    if (!issued.ok) return issued.error;
    if (extMode()) {
      await pressUnlockedExt(extBridge, issued.grant, { tabId, ref, label, cls });
      return null;
    }
    if (!userUnlockGate.consume(issued.grant, { tabId, href: await this.tabUrl(tabId), ref, label, cls })) return "The page changed before the press.";
    const r = await evalInTab<string>(tabId, pageScript(ocicPressScript(label, cls)));
    return r === "pressed" ? null : `The control is ${r === "covered" ? "covered by something else" : r === "hidden" ? "not visible" : "gone from the page"}.`;
  }

  // The request_unlock tool body. The direct-ask match reads only the
  // user's own last words (this.lastUser), never anything Claude passes.
  async requestUnlock(args: { tabId?: number; ref?: string; label: string; action: string; reason?: string }): Promise<ToolText> {
    const tabId = args.tabId ?? this.state.lastTabId;
    if (tabId == null) return said("No tab is open yet. Open the page first, then call request_unlock with its tabId.");
    const href = await this.tabUrl(tabId);
    if (!href) return said("Could not check which page that tab is on. Try again in a moment.");
    if (!process.env.CLEARCART_ALLOW_ANY_SITE && siteBlockReason(href, sitePolicy())) {
      return said("Blocked: that tab is on a site Clearcart does not use, so nothing there unlocks.");
    }
    let info: LockInfo;
    try {
      info = await this.lockInfo(tabId, args.ref, args.label);
    } catch (e) {
      return said(`Could not check that control: ${(e as Error).message}.`);
    }
    const ref = args.ref || "label";
    const label = String(info.label || args.label);
    const origin = originOf(href);
    const words = await this.wordsFor(tabId, href);
    const userText = words?.text ?? "";
    const pw = words?.passwordYes;
    const passwordYes = !!pw && pw.tabId === tabId && pw.origin === origin && Protect.sameLabel(pw.label, label);
    const d = decideUnlock(info, { userText, spent: words?.spent, passwordYes });
    if (d.kind === "refuse") {
      if (info.locked) this.status(`unlock refused: ${info.kind}`);
      return said(d.message);
    }
    if (d.kind === "needs_password") {
      if (origin && info.cls && isDirectAsk(userText, info.cls as UnlockClass, label)) this.passwordAsk = { tabId, label, origin };
      this.status("unlock waiting: the user types their password");
      return said(d.message);
    }
    let how = "user asked";
    if (d.kind === "ask") {
      this.say(d.question);
      const answer = await new Promise<string | null>((resolve) => {
        this.awaitingAnswer = resolve;
      });
      if (answer === null || !isExplicitYes(answer)) {
        this.status(`unlock declined: ${d.cls}`);
        return said(`declined, nothing was pressed. The user said: ${JSON.stringify(answer ?? "")}`);
      }
      how = "user confirmed";
    } else {
      words!.spent.add(d.cls);
    }
    if (d.cls === "account") this.passwordAsk = null;
    let failed: string | null;
    try {
      failed = await this.pressUnlocked(tabId, ref, label, d.cls);
    } catch (e) {
      failed = (e as Error).message;
    }
    if (failed) {
      this.status(`unlock failed: ${d.cls}`);
      return said(`Not pressed: ${failed}`);
    }
    // The pass starts only after the press worked, for this tab alone.
    if (d.cls === "checkout" && origin) {
      const now = Date.now();
      this.checkoutPass = { tabId, origin, landBy: now + PASS_LAND_MS, until: now + PASS_MAX_MS, landed: false };
    }
    this.status(`unlocked once: ${d.cls} "${label}" (${how})`);
    const next =
      d.cls === "checkout"
        ? origin === STORE_ORIGIN
          ? " Continue as usual; paying still goes through request_checkout and pay_now."
          : " Read the checkout page for the user. Never enter an address, card or other details there, and never press Place order; tell the user they can finish it themselves."
        : d.cls === "account"
          ? " Never type a password or card number; the user types those themselves."
          : "";
    return said(`pressed ${label} once.${d.kind === "ask" ? " The question was already spoken; do not ask again." : ""}${next}`);
  }

  private tools() {
    const requestCheckout = tool(
      "request_checkout",
      "Read the order back to the user and wait for their spoken answer. Call this on the checkout page with the exact item, quantity and the order total shown on the page. Returns 'confirmed' only on an explicit yes, otherwise 'declined' with what the user said.",
      {
        item: z.string().describe("Product name and size or count, as the user would say it"),
        quantity: z.number().int().positive(),
        total: z.string().describe("Order total from the page, e.g. $14.27"),
        changes: z
          .string()
          .optional()
          .describe("One short sentence on anything you changed for the user, e.g. \"I removed a pre-checked Subscribe and Save membership that would have added $4.99.\" Omit if nothing changed."),
      },
      (args) => this.requestCheckout(args)
    );

    // Progress notes go through this tool. Free text written alongside tool
    // calls is reasoning, not speech, so it is never spoken (see the loop).
    const sayTool = tool(
      "say",
      "Speak a few words to the user right now, while you work. Never for reasoning, ids or URLs.",
      { text: z.string().max(160) },
      async ({ text }) => {
        this.say(text.trim());
        return { content: [{ type: "text", text: "spoken" }] };
      }
    );

    const payNowTool = tool(
      "pay_now",
      "Pay for the confirmed order. Only works right after request_checkout returned confirmed, with the checkout page open. Fills payment from the secure vault and places the order. Returns { ok, last4 } or { ok: false, error }.",
      {},
      async () => {
        this.status("paying");
        const r = await payNow(this.state);
        if (r.ok) {
          this.send({ type: "receipt", ...r.receipt });
          this.send({ type: "confirm_done", outcome: "paid" });
          this.status("order placed");
          return { content: [{ type: "text", text: JSON.stringify({ ok: true, last4: r.last4, total: r.receipt.total }) }] };
        }
        this.status(`payment not completed: ${r.error}`);
        this.send({ type: "confirm_done", outcome: "failed" });
        return { content: [{ type: "text", text: JSON.stringify({ ok: false, error: r.error }) }] };
      }
    );

    const requestUnlockTool = tool(
      "request_unlock",
      "Press a [locked] control the user wants pressed: go to checkout, sign in, sign up, subscribe, save a card, or a marked control. If the user's own words just asked for it, it is pressed at once; otherwise this tool asks the user one short question itself and presses only on an explicit yes. Never for Place order, Buy now, Pay or wallet buttons: paying goes through request_checkout and pay_now. Returns what happened.",
      {
        tabId: z.number().int().optional().describe("Tab id of the page with the control. Default: the last tab used."),
        ref: z.string().optional().describe("The control's ref from read_page or find, e.g. ref_12"),
        label: z.string().describe("The control's name as the page shows it, e.g. \"Proceed to checkout\""),
        action: z.string().describe("What pressing it does for the user, in a few words, e.g. \"go to checkout\""),
        reason: z.string().optional().describe("Why, in a few words, e.g. \"the user asked to check out\""),
      },
      (args) => this.requestUnlock(args)
    );

    return createSdkMcpServer({
      name: "clearcart",
      version: "0.1.0",
      tools: [sayTool, requestCheckout, payNowTool, requestUnlockTool],
      alwaysLoad: true,
      // request_checkout waits on a person; give it room.
      timeout: 10 * 60_000,
    });
  }

  // Text-only messages are held until the turn ends: the SDK can send the
  // text and the tool call of one step as separate messages, so a tool call
  // that follows turns the held text into thinking aloud.
  onSdkMessage(m: SDKMessage) {
    if (m.type === "system" && m.subtype === "init") {
      const servers = (m as any).mcp_servers as Array<{ name: string; status: string }> | undefined;
      this.status(`agent ready (${(servers || []).map((s) => `${s.name}: ${s.status}`).join(", ")})`);
    } else if (m.type === "assistant" && !m.parent_tool_use_id) {
      const blocks = m.message.content as any[];
      // Only a message with no tool calls is a reply to the user. Text next
      // to tool calls is the model thinking aloud: log it, never speak it.
      const working = blocks.some((b) => b.type === "tool_use");
      if (working) {
        this.held.forEach((t) => this.unspoken(t));
        this.held = [];
      }
      for (const block of blocks) {
        if (block.type === "text" && block.text?.trim()) {
          if (working || this.muted) this.unspoken(block.text.trim());
          else this.held.push(block.text.trim());
        } else if (block.type === "tool_use") this.status(toolLabel(block.name, block.input));
      }
    } else if (m.type === "result") {
      if (this.held.length) this.say(this.held.join(" "));
      this.held = [];
      this.turnsOpen = Math.max(0, this.turnsOpen - 1);
      // Nothing paced (a click on its way, typing) outlives its turn.
      this.stopActions();
      // The interrupted turn is over; the next one speaks again.
      this.muted = false;
      if (m.subtype !== "success") this.status(`turn ended: ${m.subtype}`);
    }
  }

  // Connection state of the MCP servers; needs no model call.
  async mcpStatus() {
    return this.q ? this.q.mcpServerStatus() : [];
  }

  async run() {
    const ext = extMode();
    const q = (this.q = query({
      prompt: this.input,
      options: {
        model: MODEL,
        systemPrompt: buildSystemPrompt({ guided: this.guided, ext: ext ? extPrompt : undefined }),
        cwd: HERE,
        tools: [],
        settingSources: [],
        strictMcpConfig: true,
        persistSession: false,
        abortController: this.abort,
        mcpServers: {
          browser: ext
            ? createExtToolsServer()
            : { type: "stdio", command: process.execPath, args: [BROWSER_SERVER], alwaysLoad: true, timeout: 90_000 },
          clearcart: this.tools(),
        },
        allowedTools: ext ? EXT_ALLOWED : ALLOWED,
        disallowedTools: DISALLOWED_BROWSER,
        // Anything not in allowedTools is denied without prompting; the
        // PreToolUse guard gates the allowed ones per call.
        permissionMode: "dontAsk",
        hooks: { PreToolUse: [{ hooks: [this.guard] }], PostToolUse: [{ hooks: [this.sweep, this.lockNotes] }] },
        stderr: (d) => {
          if (process.env.CLEARCART_DEBUG) process.stderr.write(`[claude] ${d}`);
        },
      },
    }));

    try {
      for await (const m of q) this.onSdkMessage(m);
    } catch (e) {
      if (!this.closed) {
        this.muted = false;
        this.status(`agent error: ${(e as Error).message}`);
        this.send({ type: "confirm_done", outcome: "failed" });
        this.say("Sorry, something went wrong on my side. Please try again.");
      }
    }
  }
}

function toolLabel(name: string, input: any): string {
  const short = name.replace(B, "").replace(C, "");
  if (short === "navigate") return `navigate ${input?.url ?? ""}`;
  if (short === "computer") return `computer ${input?.action ?? ""}`;
  if (short === "find") return `find "${input?.query ?? ""}"`;
  return short;
}
