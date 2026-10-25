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
//
// Every Orbi window shares this one session (hub.ts). When the user
// moves to another window, handOff() declines a read-back or unlock question
// still waiting (it was asked in the old window, so no yes from the new one
// may answer it) and mutes the turn in progress like a barge-in.

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
import { isCheckoutUrl, originOf, paySite, SITE_POLICY, siteBlockReason, type SitePolicy } from "./origins.ts";
import { checkoutSnapshot, payNow, type Confirmation, type PayState } from "./pay.ts";
import { buildSystemPrompt, dangerNote, EXT_TABS_PROMPT, guidedNote, MEMORY_OFF_PROMPT, MEMORY_PROMPT } from "./prompt.ts";
import { factFromUserWords, factNamedBy, isForgetAllAsk, isForgetAsk, isRememberAsk, memoryBlock, sensitiveReason, transcriptBlock, type MemoryStore, type Transcript, type Turn } from "./memory.ts";
import {
  decideUnlock,
  isDirectAsk,
  isUnlockYes,
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
// open web minus a blocklist, or the allowlist). pay_now and the unlock gate
// only serve CLEARCART_PAY_ORIGINS.

const B = "mcp__browser__";
const C = "mcp__clearcart__";

// Tools Claude never gets. execute_code is the big one: its sandbox can call
// every browser tool from inside one call, which would step around the
// per-tool guard below. javascript_tool would let page script press a
// locked button (button lock); our own lock checks still use it over our
// own bridge client, which Claude cannot reach.
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

// Long-term memory (memory.ts): remember asks the user unless their own
// words just asked for it; forget the same way; recall lists.
const MEMORY_TOOLS = [C + "remember", C + "forget", C + "recall"];

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
].map((t) => B + t).concat([C + "say", C + "request_checkout", C + "pay_now", C + "request_unlock"], MEMORY_TOOLS);

// Blocked while card values sit in the checkout form: anything that can read
// or screenshot the page, or change it.
const BLOCKED_WHILE_CARD_LIVE = new Set(
  ["computer", "read_page", "get_page_text", "find", "form_input", "javascript_tool", "read_console_messages"].map((t) => B + t)
);

// CLEARCART_BROWSER=ext: Claude's browser tools are the Orbi extension's
// TOOLS (exttools.ts), same mcp__browser__ prefix. Screenshot, click, type,
// key and scroll stand in for "computer" in the card-live block list.
const EXT_ALLOWED = EXT_TOOLS.map((t) => B + t).concat([C + "say", C + "request_checkout", C + "pay_now", C + "request_unlock"], MEMORY_TOOLS);
const EXT_BLOCKED_WHILE_CARD_LIVE = new Set(
  ["screenshot", "click", "type", "key", "scroll", "dismiss_overlay", "read_page", "get_page_text", "find", "form_input"].map((t) => B + t)
);

function extPrompt(prompt: string): string {
  return prompt.replace(
    "calling tabs_context_mcp with createIfEmpty true, then use a tab in the MCP group.",
    "calling tabs_context. Use a tab already on the site you need, or open one with tabs_create."
  ) + EXT_TABS_PROMPT;
}

// The user's Guided mode setting, the mode for blind and low-vision users:
// the extension's in ext mode, off until it says otherwise. Elsewhere
// CLEARCART_GUIDED=1 turns it on.
export function currentGuided(): boolean {
  return extMode() ? (extBridge.guidedMode() ?? false) : /^(1|true|on|yes)$/i.test(process.env.CLEARCART_GUIDED?.trim() || "");
}

// The user's Memory setting: the extension's in ext mode, off until the
// extension has said it is on (so a session that starts before the
// setting arrives never uses memory the user turned off). Elsewhere
// CLEARCART_MEMORY=0 turns it off. Off: saved facts
// are not used or saved and the conversation is not kept for a restart.
export function memoryOn(): boolean {
  return extMode() ? extBridge.memoryEnabled() === true : process.env.CLEARCART_MEMORY !== "0";
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
  if (policy.mode === "allowlist") return `Blocked: Orbi only browses ${[...policy.allowed].join(", ")}.`;
  return `Blocked: Orbi does not open ${originOf(url) || "that page"} (${why}). Tell the user if they asked for it.`;
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
// null. Allowed origins (CLEARCART_ALLOWED_ORIGINS) and IP literals
// (blocklist.ts judges those) are skipped. A name that does not resolve here passes: the browser
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
  return local ? `Blocked: Orbi does not open ${o} (it points to this computer or the local network). Tell the user if they asked for it.` : null;
}

function tabIdOf(args: Record<string, unknown>): number | null {
  if (typeof args.tabId === "number") return args.tabId;
  if (typeof args.tabId === "string" && /^\d+$/.test(args.tabId)) return Number(args.tabId);
  return null;
}

// Where the sweep sends a stray tab when going back does not help.
export const STRAY_PAGE = "about:blank";

// Tab sweep: any Orbi-group tab whose page is not allowed (a clicked
// link, a redirect, history) is sent away from it. Allowlist mode: to a
// blank page. Open mode: back to the page before, or to a blank page when
// going back does not land somewhere allowed. `nav` loads a URL (or "back")
// in a tab and returns where the tab ended up, or null.
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
    await nav(t.tabId, STRAY_PAGE).catch(() => null);
  }
  return strays.length;
}

export function sweepNote(n: number, policy: SitePolicy = sitePolicy()): string {
  const allowed = [...policy.allowed];
  return policy.mode === "open"
    ? `A tab opened a blocked site or a checkout page and was sent back${n > 1 ? " (" + n + " tabs)" : ""}. Never open sites on the user's blocked list; tell the user instead.`
    : `A tab left the allowed sites and was sent to a blank page. ${allowed.length ? `Only browse ${allowed.join(", ")}.` : "No sites are allowed yet; tell the user."}`;
}

// Button lock for navigation: checkout and payment pages are off limits on
// every site except the pay sites, where pay_now runs. Both browser paths,
// for navigate and for tabs_create / tabs_create_mcp with a url. passed:
// true when the user asked to go to checkout on this tab and origin
// (request_unlock's checkout pass), which lifts the block for that visit.
// Off in Danger mode, like the rest of the button lock.
export function navigateLockReason(url: string, passed?: (url: string) => boolean, danger: boolean = dangerModeOn()): string | null {
  if (danger || url === "back" || url === "forward") return null;
  if (isCheckoutUrl(url) && !paySite(url) && !passed?.(url)) {
    return "Locked: checkout pages open only by pressing the cart's checkout button. If the user asked to check out, call request_unlock with that button's ref and label; otherwise stop at the cart and tell the user what is in it. Never tell the user it is locked.";
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
// Chrome path. The click lock itself is enforced where the clicks are
// checked (the extension, ocic-lock.ts). Here it lifts the checkout page
// block (navigateLockReason) and the spoken yes (requestCheckout announces
// the order instead of waiting). It never touches masking, the card-live
// tool block or the blocklist.
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

// The user's most recent words, bound to the tab Orbi was on when they
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

const noWords = (): UserWords => ({ text: "", spent: new Set(), at: 0, tabId: null, origin: Promise.resolve(null), passwordYes: null });

type ToolText = { content: Array<{ type: "text"; text: string }> };
const said = (text: string): ToolText => ({ content: [{ type: "text", text }] });

// What Claude is told when a question got no answer at all: the window that
// asked it went away or the user moved to another one (handOff, close).
const NO_ANSWER = "No answer came: the user moved to another Orbi window, or it closed, before answering.";

export class Session {
  private input = new InputQueue();
  private abort = new AbortController();
  private awaitingAnswer: ((text: string | null) => void) | null = null;
  private state: PayState = { lastTabId: null, confirmation: null, cardFieldsLive: false, autoOk: () => dangerModeOn() };
  private closed = false;
  private q: Query | null = null;
  // The user's most recent words, for request_unlock's direct-ask match.
  private lastUser: UserWords = noWords();
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
  // Danger mode as last told to Claude in a user turn (see withSettingNotes).
  private dangerTold = false;

  // Saved facts and the recent conversation (memory.ts). Null in tests that
  // do not give them: nothing is read or written.
  private mem: MemoryStore | null;
  private log: Transcript | null;
  // Saved memory as the model last heard it (see withMemoryNote).
  private memSeen: string;
  // The conversation from before this session (a restart), read once when
  // the session is made and put in front of its first turn when Memory is on.
  private restore: Turn[] | null;
  // The remember or forget question waiting for an answer, if any.
  private memoryAsk: ((text: string | null) => void) | null = null;

  constructor(private send: (m: ServerMessage) => void, opts: { memory?: MemoryStore | null; log?: Transcript | null } = {}) {
    this.mem = opts.memory ?? null;
    this.log = opts.log ?? null;
    this.restore = this.log?.recent() ?? null;
    this.memSeen = this.memKey();
  }

  userText(text: string) {
    if (this.closed || !text.trim()) return;
    // Only the user's own words are kept, never the context block.
    if (memoryOn()) this.log?.add("user", text);
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
      this.status("Danger mode is on: no button lock, and orders are placed without waiting for a yes");
      this.say(DANGER_LINE);
    }
    // Counted now, while its context is fetched, so an interrupt sees it.
    this.turnsOpen++;
    const fetch = this.pageContext;
    if (!fetch) return this.input.push(this.withMemoryNote(this.withSettingNotes(text)));
    const ctx = Promise.race([
      fetch().catch(() => null),
      new Promise<null>((r) => setTimeout(() => r(null), CONTEXT_TIMEOUT_MS + 200).unref?.()),
    ]);
    this.turns = this.turns.then(async () => {
      const c = await ctx;
      if (!this.closed) this.input.push(withContext(this.withMemoryNote(this.withSettingNotes(text)), c, process.env.CLEARCART_ALLOW_ANY_SITE ? undefined : sitePolicy()));
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

  // The same for Danger mode: Claude hears when it turns on or off. Read
  // fresh for every turn, from the extension's setting (or the server's
  // CLEARCART_DANGER_MODE on the Open Claude in Chrome path), never from
  // anything Claude or a page sends.
  private withSettingNotes(turn: string): string {
    const withGuided = this.withGuidedNote(turn);
    const on = dangerModeOn();
    if (on === this.dangerTold) return withGuided;
    this.dangerTold = on;
    return `${dangerNote(on)}\n\n${withGuided}`;
  }

  // What the model knows of saved memory: "off", or the facts' text.
  private memKey(): string {
    if (!this.mem) return "none";
    return memoryOn() ? "on:" + JSON.stringify(this.mem.list().map((f) => f.text)) : "off";
  }

  // Memory changed outside the tools (the settings page deleted a fact, or
  // the switch moved): the next turn says so, like withGuidedNote.
  // The first turn also carries the conversation from before a restart,
  // as quoted data.
  private withMemoryNote(turn: string): string {
    const restore = this.restore;
    this.restore = null;
    if (restore?.length && memoryOn()) turn = `${transcriptBlock(restore)}\n\n${turn}`;
    const key = this.memKey();
    if (key === this.memSeen) return turn;
    const wasOff = !this.memSeen.startsWith("on:");
    this.memSeen = key;
    let note: string;
    if (key === "off") {
      // Off means nothing is kept: the recent conversation goes now.
      this.log?.clear();
      note = `[Setting changed, from the user's Orbi settings] ${MEMORY_OFF_PROMPT.trim().split("\n").slice(1).join(" ").replace(/^- /, "")}`;
    } else {
      note = `[${wasOff ? "Setting changed" : "Memory changed"}, from the user's Orbi settings]${wasOff ? MEMORY_PROMPT : ""}${memoryBlock(this.mem!.list())}`;
    }
    return `${note}\n\n${turn}`;
  }

  // The system prompt for this session: the rules, then memory (saved facts
  // and the conversation from before a restart) when it is on.
  systemPrompt(ext = extMode()): string {
    const base = buildSystemPrompt({ guided: this.guided, ext: ext ? extPrompt : undefined });
    this.memSeen = this.memKey();
    if (!this.mem) return base;
    if (!memoryOn()) return base + MEMORY_OFF_PROMPT;
    return base + MEMORY_PROMPT + memoryBlock(this.mem.list());
  }

  // The user started talking over us.
  interrupt(note = "interrupted by the user") {
    if (this.closed) return;
    this.stopActions();
    this.held.forEach((t) => this.unspoken(t));
    this.held = [];
    // A read-back waiting for an answer is not cancelled or confirmed by a
    // barge-in; the user is about to answer it.
    if (this.awaitingAnswer || this.turnsOpen === 0 || this.muted) return;
    this.muted = true;
    this.status(note);
    this.q?.interrupt().catch((e) => this.status(`interrupt failed: ${(e as Error).message}`));
  }

  // The user moved to another Orbi window, or the one they used went
  // away (hub.ts). A read-back or unlock question still waiting was asked
  // there, so it is declined, never confirmed. A yes given there that
  // pay_now has not used yet is withdrawn too: paying needs a read-back the
  // user hears in the window they are in now. (A payment already under way
  // is left to finish; its receipt goes to the new window.) The words said
  // there stop counting for request_unlock, and the turn in progress is
  // muted.
  handOff() {
    if (this.closed) return;
    const pending = this.awaitingAnswer;
    this.awaitingAnswer = null;
    this.passwordAsk = null;
    this.lastUser = noWords();
    pending?.(null);
    // Dropped rather than marked, so a read-back whose yes is still being
    // pinned to its tab (request_checkout awaiting the snapshot) can't turn
    // confirmed afterwards either.
    const yes = this.state.confirmation;
    if (yes && yes.state !== "used") {
      this.state.confirmation = null;
      if (yes.state === "confirmed") {
        yes.state = "declined";
        this.status("checkout yes withdrawn: the user moved to another Orbi window");
      }
    }
    this.interrupt("interrupted: the user moved to another Orbi window");
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
    if (memoryOn()) this.log?.add("assistant", text);
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
        if (!ok) return deny("Blocked: Orbi could not check which sites its tabs are on, so browser tools are paused. Try again in a moment, and tell the user if it keeps failing.");
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

  // OCIC path: after read_page, find or get_page_text, name the locked controls for Claude and
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
  // Orbi opened (agent_tabs; the user's own tabs are never
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
      return "Blocked: Orbi could not check which page that tab is on. Try again in a moment.";
    }
    const targets = tabId == null ? tabs : tabs.filter((t) => t.tabId === tabId);
    if (tabId != null && !targets.length) return `Blocked: tab ${tabId} is not one of Orbi's tabs. Call tabs_context_mcp for the current tabs.`;
    const policy = sitePolicy();
    const bad: Tab[] = [];
    for (const t of targets) {
      if (!t.url) return "Blocked: Orbi could not check which page that tab is on. Try again in a moment.";
      if (BLANK.test(t.url)) continue;
      if (siteBlockReason(t.url, policy) || (await localDnsReason(t.url, policy, this.lookup))) bad.push(t);
    }
    if (!bad.length) return null;
    const n = await this.runSweep().catch(() => {
      this.sweepBroken = true;
      return -1;
    });
    if (n > 0) this.status(`returned ${n} tab(s) from blocked sites`);
    return `Blocked: that tab is on a site Orbi does not use (${originOf(bad[0].url) || "unknown"}). ${n >= 0 ? sweepNote(Math.max(n, 1)) : "Browser tools are paused until Orbi can send it back."}`;
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
          additionalContext: "Orbi could not check which sites its tabs are on after that call. Browser tools are paused until the check works again; do not rely on what that page showed.",
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
    this.cancelMemoryAsk();
    const conf: Confirmation = { item, quantity, total, state: "pending", tabId: null, cart: "" };
    this.state.confirmation = conf;
    // No browser tab used yet: nothing to pin, and pay_now will refuse.
    const snap = this.state.lastTabId == null ? Promise.resolve({ tabId: null, cart: "" }) : Promise.race([
      checkoutSnapshot(this.state.lastTabId),
      new Promise<{ tabId: null; cart: string }>((r) => setTimeout(() => r({ tabId: null, cart: "" }), 5_000).unref()),
    ]);
    const changed = changes?.trim() ? changes.trim().replace(/([^.!?])$/, "$1.") : "";
    // Danger mode: the user chose no spoken yes. Say what is being bought,
    // so they hear it happen, and confirm without waiting. Read now, so a
    // switch turned off before this call gets the normal read-back.
    if (dangerModeOn()) {
      conf.auto = true;
      this.say(`Placing your order for ${item}, ${total}.${changed ? ` ${changed}` : ""}`);
      Object.assign(conf, await snap);
      if (this.state.confirmation !== conf || !dangerModeOn()) {
        conf.state = "declined";
        const why = this.state.confirmation !== conf ? "Another checkout started before this one." : "Danger mode was turned off. Call request_checkout again; the user now says yes first.";
        return { content: [{ type: "text" as const, text: `declined. ${why}` }] };
      }
      conf.state = "confirmed";
      conf.confirmedAt = Date.now();
      this.status("checkout announced: Danger mode, no yes needed");
      return { content: [{ type: "text" as const, text: "confirmed. Danger mode is on: the order was announced and no yes is needed. On an Orbi pay site call pay_now now; on another site press its Place order button yourself now." }] };
    }
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
    const why = answer === null
      ? NO_ANSWER
      : this.state.confirmation === null && isExplicitYes(answer)
        ? "The user moved to another Orbi window before their yes could count."
        : `The user said: ${JSON.stringify(answer)}`;
    return { content: [{ type: "text" as const, text: `declined. ${why}` }] };
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
      return said("Blocked: that tab is on a site Orbi does not use, so nothing there unlocks.");
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
      // Like request_checkout: a muted turn's question is never heard, so
      // the user's next words must not answer it.
      if (this.muted) {
        this.status(`unlock not asked: the user interrupted (${d.cls})`);
        return said("declined, nothing was pressed. The user interrupted before the question was asked.");
      }
      this.cancelMemoryAsk();
      this.say(d.question);
      const answer = await new Promise<string | null>((resolve) => {
        this.awaitingAnswer = resolve;
      });
      // A yes that says more ("yes, that's what I just said") counts here,
      // never for paying (request_checkout keeps isExplicitYes).
      if (answer === null || !(isExplicitYes(answer) || isUnlockYes(answer, d.cls, label))) {
        this.status(`unlock declined: ${d.cls}`);
        return said(
          `declined, nothing was pressed. ${answer === null ? NO_ANSWER : `The user said: ${JSON.stringify(answer)}. If that was not a no, ask them what they want; never tell them it is locked.`}`
        );
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
        ? paySite(href)
          ? " Continue as usual; paying still goes through request_checkout and pay_now."
          : " Read the checkout page for the user. Never enter an address, card or other details there, and never press Place order; tell the user they can finish it themselves."
        : d.cls === "account"
          ? " Never type a password or card number; the user types those themselves."
          : "";
    return said(`pressed ${label} once.${d.kind === "ask" ? " The question was already spoken; do not ask again." : ""} Do not click it again; another press needs another request_unlock.${next}`);
  }

  // The pay_now tool body.
  async payNowCall(): Promise<ToolText> {
    // A yes Danger mode skipped counts only while Danger mode is still on.
    const c = this.state.confirmation;
    if (c?.auto && !dangerModeOn()) {
      this.state.confirmation = null;
      this.status("payment not started: Danger mode was turned off");
      return { content: [{ type: "text", text: JSON.stringify({ ok: false, error: "Danger mode was turned off. Call request_checkout again; the user now says yes first." }) }] };
    }
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

  // The user's last words if they are recent enough to count, else "".
  private freshWords(): string {
    const w = this.lastUser;
    return w.text && Date.now() - w.at <= USER_WORDS_TTL_MS ? w.text : "";
  }

  // Asks the user one question out loud and waits for the answer. Like
  // request_unlock: a muted turn's question is never asked.
  // Never while another question (a checkout read-back, an unlock) waits,
  // and a yes that names paying or ordering is not a yes to remembering.
  private async askYes(question: string): Promise<{ yes: boolean; why: string }> {
    if (this.muted) return { yes: false, why: "The user interrupted before the question was asked." };
    if (this.awaitingAnswer || this.state.confirmation?.state === "pending") return { yes: false, why: "Another question is waiting for the user's answer. Ask again later." };
    this.say(question);
    const answer = await new Promise<string | null>((resolve) => {
      const done = (t: string | null) => {
        if (this.memoryAsk === done) this.memoryAsk = null;
        resolve(t);
      };
      this.awaitingAnswer = done;
      this.memoryAsk = done;
    });
    if (answer !== null && isExplicitYes(answer) && !/\b(pay|order|buy|checkout|confirm(ed)?)\b/i.test(answer)) return { yes: true, why: "" };
    return { yes: false, why: answer === null ? NO_ANSWER : `The user said: ${JSON.stringify(answer)}` };
  }

  // A checkout read-back or unlock question is about to be asked: a memory
  // question still waiting is declined first, so the two never share a yes.
  private cancelMemoryAsk() {
    const ask = this.memoryAsk;
    if (!ask) return;
    if (this.awaitingAnswer === ask) this.awaitingAnswer = null;
    ask(null);
  }

  // The remember tool. Saves only when the user's own last words asked to
  // remember it and the fact is made of what they said; anything else (the
  // model's idea, or a page's) is asked out loud first and saved only on an
  // explicit yes. The filter (memory.ts) refuses secrets either way.
  async remember({ fact }: { fact: string }): Promise<ToolText> {
    if (!this.mem) return said("Memory is not available here.");
    if (!memoryOn()) return said("Memory is off in the user's Orbi settings, so nothing was saved. They can turn it on there.");
    const text = String(fact ?? "").replace(/\s+/g, " ").trim().replace(/[.!?]+$/, "");
    const why = sensitiveReason(text);
    if (why) {
      this.status("memory: refused a fact");
      return said(`Not saved: ${why}. Orbi never remembers card, password, ID or bank details, or anything that tells it what to do. Tell the user briefly.`);
    }
    // One save per utterance without a question, of a fact made only of
    // the words in it.
    const words = this.freshWords();
    let how = "the user asked";
    if (words && isRememberAsk(words) && factFromUserWords(text, words) && !this.lastUser.spent.has("remember")) {
      this.lastUser.spent.add("remember");
    } else {
      const a = await this.askYes(`Want me to remember that ${text}?`);
      if (!a.yes) {
        this.status("memory: not saved (no yes)");
        return said(`Not saved. ${a.why}`.trim());
      }
      how = "the user confirmed";
    }
    const r = this.mem.add(text);
    if (!r.ok) return said(r.reason);
    this.memSeen = this.memKey();
    this.status(`memory: saved a fact (${how})`);
    return said(r.existed ? `Already saved: ${r.fact.text}` : `Saved: ${r.fact.text}.${how === "the user confirmed" ? " The question was already spoken; do not ask again." : ""}`);
  }

  // The forget tool: one fact, or everything. Direct when the user's last
  // words asked to forget, otherwise asked out loud first.
  async forget({ fact, all }: { fact?: string; all?: boolean }): Promise<ToolText> {
    if (!this.mem) return said("Memory is not available here.");
    const words = this.freshWords();
    const asked = !!words && isForgetAsk(words) && !this.lastUser.spent.has("forget");
    if (all) {
      if (asked && isForgetAllAsk(words)) this.lastUser.spent.add("forget");
      else {
        const a = await this.askYes("Want me to forget everything I remember about you?");
        if (!a.yes) return said(`Nothing was forgotten. ${a.why}`.trim());
      }
      const n = this.mem.clear();
      this.log?.clear();
      this.memSeen = this.memKey();
      this.status("memory: forgot everything");
      return said(`Forgot everything (${n} saved fact${n === 1 ? "" : "s"}).`);
    }
    const hits = this.mem.find(String(fact ?? ""));
    if (!hits.length) return said("Nothing saved matches that. Call recall to see what is saved.");
    if (hits.length > 1) return said(`More than one saved fact matches. Ask the user which one, then call forget with its id:\n${hits.map((f) => `${f.id}: ${f.text}`).join("\n")}`);
    const hit = hits[0];
    if (asked && factNamedBy(hit.text, words)) this.lastUser.spent.add("forget");
    else {
      const a = await this.askYes(`Want me to forget that ${hit.text}?`);
      if (!a.yes) return said(`Nothing was forgotten. ${a.why}`.trim());
    }
    this.mem.remove(hit.id);
    this.memSeen = this.memKey();
    this.status("memory: forgot a fact");
    return said(`Forgot: ${hit.text}.`);
  }

  // The recall tool: what is saved, freshly read.
  recall(): ToolText {
    if (!this.mem) return said("Memory is not available here.");
    if (!memoryOn()) return said("Memory is off in the user's Orbi settings, so nothing saved is used. They can turn it on there.");
    const facts = this.mem.list();
    this.memSeen = this.memKey();
    if (!facts.length) return said("Nothing is saved yet.");
    return said(`Saved facts (read them plainly, never the ids):\n${facts.map((f) => `${f.id}: ${f.text}`).join("\n")}`);
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
      () => this.payNowCall()
    );

    const requestUnlockTool = tool(
      "request_unlock",
      "Press a [locked] or [uncheck only] control the user wants pressed: go to checkout, sign in, sign up, subscribe, save a card. Use it whenever the task needs a locked control or a click comes back Locked, with the ref and label it names; do not give up, retry the click or look for a workaround. If the user's own words just asked for it, it is pressed at once; otherwise this tool asks the user one short question itself and presses only on an explicit yes. Never for Place order, Buy now, Pay or wallet buttons: paying goes through request_checkout and pay_now. Returns what happened.",
      {
        tabId: z.number().int().optional().describe("Tab id of the page with the control. Default: the last tab used."),
        ref: z.string().optional().describe("The control's ref from read_page or find, e.g. ref_12"),
        label: z.string().describe("The control's name as the page shows it, e.g. \"Proceed to checkout\""),
        action: z.string().describe("What pressing it does for the user, in a few words, e.g. \"go to checkout\""),
        reason: z.string().optional().describe("Why, in a few words, e.g. \"the user asked to check out\""),
      },
      (args) => this.requestUnlock(args)
    );

    const rememberTool = tool(
      "remember",
      "Save one fact about the user for later sessions, when they ask you to remember it or after they agree. If their own words did not just ask for it, this tool asks them one short question itself and saves only on a yes, so do not ask first. Refuses card, password, ID and bank details.",
      { fact: z.string().max(200).describe("The fact in a few words, addressed to the user, e.g. \"you wear size medium\" or \"you like to be called Seb\"") },
      (args) => this.remember(args)
    );
    const forgetTool = tool(
      "forget",
      "Forget one saved fact (by its words or its id from recall), or everything with all true. Asks the user first unless their own words just asked to forget it.",
      {
        fact: z.string().max(200).optional().describe("A few words of the saved fact, or its id"),
        all: z.boolean().optional().describe("Forget every saved fact and the recent conversation"),
      },
      (args) => this.forget(args)
    );
    const recallTool = tool("recall", "List the facts saved about the user. Call it when they ask what you remember.", {}, async () => this.recall());

    return createSdkMcpServer({
      name: "clearcart",
      version: "0.1.0",
      tools: [sayTool, requestCheckout, payNowTool, requestUnlockTool, rememberTool, forgetTool, recallTool],
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
        systemPrompt: this.systemPrompt(ext),
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
