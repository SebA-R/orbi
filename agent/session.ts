// One voice session = one Claude Agent SDK conversation.
//
// User turns stream into a single long-lived query() as SDKUserMessages, so
// the conversation keeps its context across turns. While request_checkout is
// waiting, the next user_text is routed to it instead of to Claude.

import path from "node:path";
import { fileURLToPath } from "node:url";
import { createSdkMcpServer, query, tool, type HookCallback, type Query, type SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";

import { callBrowserTool, resultText } from "./bridge.ts";
import { extBridge, extMode, TOOLS as EXT_TOOLS } from "./extbridge.ts";
import { createExtToolsServer } from "./exttools.ts";
import { ocicLockNote, ocicLockReason } from "./ocic-lock.ts";
import { isCheckoutUrl, originOf, SITE_POLICY, siteBlockReason, STORE_ORIGIN, type SitePolicy } from "./origins.ts";
import { payNow, type PayState } from "./pay.ts";
import { SITES_PROMPT, SYSTEM_PROMPT } from "./prompt.ts";

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
].map((t) => B + t).concat([C + "say", C + "request_checkout", C + "pay_now"]);

// Blocked while card values sit in the checkout form: anything that can read
// or screenshot the page, or change it.
const BLOCKED_WHILE_CARD_LIVE = new Set(
  ["computer", "read_page", "get_page_text", "find", "form_input", "javascript_tool", "read_console_messages"].map((t) => B + t)
);

// CLEARCART_BROWSER=ext: Claude's browser tools are the Clearcart extension's
// TOOLS (exttools.ts), same mcp__browser__ prefix. Screenshot, click, type,
// key and scroll stand in for "computer" in the card-live block list.
const EXT_ALLOWED = EXT_TOOLS.map((t) => B + t).concat([C + "say", C + "request_checkout", C + "pay_now"]);
const EXT_BLOCKED_WHILE_CARD_LIVE = new Set(
  ["screenshot", "click", "type", "key", "scroll", "read_page", "get_page_text", "find", "form_input"].map((t) => B + t)
);

function extPrompt(prompt: string): string {
  return prompt.replace("calling tabs_context_mcp with createIfEmpty true", "calling tabs_context, and tabs_create if the group has no tabs");
}

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
  const strays = tabs.filter((t) => t.url && !BLANK.test(t.url) && siteBlockReason(t.url, policy));
  for (const t of strays) {
    if (policy.mode === "open") {
      const at = await nav(t.tabId, "back").catch(() => null);
      if (at && (BLANK.test(at) || !siteBlockReason(at, policy))) continue;
    }
    await nav(t.tabId, STORE_ORIGIN + "/").catch(() => null);
  }
  return strays.length;
}

export function sweepNote(n: number, policy: SitePolicy = sitePolicy()): string {
  return policy.mode === "open"
    ? `A tab opened a blocked site and was sent back${n > 1 ? " (" + n + " tabs)" : ""}. Never open sites on the user's blocked list; tell the user instead.`
    : `A tab left the allowed sites and was sent back to the store home page. Only browse ${[...policy.allowed].join(", ")}.`;
}

// Button lock for navigation: checkout and payment pages are off limits on
// every site except the store, where pay_now runs. Both browser paths.
export function navigateLockReason(url: string): string | null {
  if (url === "back" || url === "forward") return null;
  if (isCheckoutUrl(url) && originOf(url) !== STORE_ORIGIN) {
    return "Locked: Clearcart does not open checkout or payment pages on this site. Stop at the cart and tell the user.";
  }
  return null;
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
  | { type: "receipt"; item: string; total: string; last4: string };

const NEGATIVE = /\b(no|nope|not|don'?t|do not|stop|wait|cancel|change|hold on|never mind|nevermind)\b/i;
const AFFIRMATIVE = /^(yes|yeah|yep|yup|yes please|confirm|confirmed|go ahead|pay|pay now|do it|place the order)\b/i;

export function isExplicitYes(text: string): boolean {
  const t = text.trim().toLowerCase().replace(/[^\w\s']/g, " ").replace(/\s+/g, " ").trim();
  return AFFIRMATIVE.test(t) && !NEGATIVE.test(t);
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

export class Session {
  private input = new InputQueue();
  private abort = new AbortController();
  private awaitingAnswer: ((text: string | null) => void) | null = null;
  private state: PayState = { lastTabId: null, confirmation: null, cardFieldsLive: false };
  private closed = false;
  private q: Query | null = null;

  constructor(private send: (m: ServerMessage) => void) {}

  userText(text: string) {
    if (this.closed || !text.trim()) return;
    if (this.awaitingAnswer) {
      const resolve = this.awaitingAnswer;
      this.awaitingAnswer = null;
      resolve(text);
      return;
    }
    this.input.push(text);
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    this.awaitingAnswer?.(null);
    this.awaitingAnswer = null;
    this.input.close();
    this.abort.abort();
  }

  private say(text: string) {
    this.send({ type: "agent_text", text });
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
      if (this.state.cardFieldsLive && (extMode() ? EXT_BLOCKED_WHILE_CARD_LIVE : BLOCKED_WHILE_CARD_LIVE).has(name)) {
        return deny("Blocked: card details are in the checkout form. Wait for pay_now to finish.");
      }
      const opens = name === B + "navigate" || ((name === B + "tabs_create" || name === B + "tabs_create_mcp") && args.url != null);
      if (opens && !process.env.CLEARCART_ALLOW_ANY_SITE) {
        const blocked = browseDenyReason(String(args.url || ""));
        if (blocked) return deny(blocked);
      }
      if (name === B + "navigate") {
        const locked = navigateLockReason(String(args.url || ""));
        if (locked) return deny(locked);
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
      if (typeof args.tabId === "number") this.state.lastTabId = args.tabId;
      else if (typeof args.tabId === "string" && /^\d+$/.test(args.tabId)) this.state.lastTabId = Number(args.tabId);
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

  // After every browser call, send back any MCP-group tab that landed on a
  // site it may not be on (returnStrays).
  private sweep: HookCallback = async (input) => {
    if (input.hook_event_name !== "PostToolUse" || !input.tool_name.startsWith(B)) return {};
    if (process.env.CLEARCART_ALLOW_ANY_SITE) return {};
    const ext = extMode();
    type Tab = { tabId: number; url?: string };
    const list = async (): Promise<Tab[]> =>
      ext
        ? (await extBridge.call<{ tabs?: Tab[] }>("tabs_context", {}, 10_000))?.tabs || []
        : JSON.parse(resultText(await callBrowserTool("tabs_context_mcp", {})).split("\n")[0]).availableTabs || [];
    // Our extension's navigate reports where the tab ended up (and refuses a
    // landing it does not allow). The OCIC one does not, so list again.
    const nav = async (tabId: number, url: string): Promise<string | null> => {
      if (ext) return (await extBridge.call<{ url?: string }>("navigate", { url, tabId }))?.url ?? null;
      await callBrowserTool("navigate", { url, tabId });
      return (await list()).find((t) => t.tabId === tabId)?.url ?? null;
    };
    let tabs: Tab[];
    try {
      tabs = await list();
    } catch {
      return {};
    }
    const n = await returnStrays(tabs, nav);
    if (!n) return {};
    this.status(`returned ${n} tab(s) from blocked sites`);
    return { hookSpecificOutput: { hookEventName: "PostToolUse" as const, additionalContext: sweepNote(n) } };
  };

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
      async ({ item, quantity, total, changes }) => {
        this.state.confirmation = { item, quantity, total, state: "pending" };
        const note = changes?.trim() ? ` ${changes.trim().replace(/([^.!?])$/, "$1.")}` : "";
        this.say(`You're buying ${quantity} ${item} for ${total}.${note} Say yes to pay, or no to change it.`);
        const answer = await new Promise<string | null>((resolve) => {
          this.awaitingAnswer = resolve;
        });
        if (answer !== null && isExplicitYes(answer)) {
          this.state.confirmation.state = "confirmed";
          this.status("checkout confirmed");
          return { content: [{ type: "text", text: "confirmed" }] };
        }
        this.state.confirmation.state = "declined";
        this.status("checkout declined");
        return { content: [{ type: "text", text: `declined. The user said: ${JSON.stringify(answer ?? "")}` }] };
      }
    );

    // Progress notes go through this tool. Free text written alongside tool
    // calls is reasoning, not speech, so it is never spoken (see the loop).
    const sayTool = tool(
      "say",
      "Speak one short progress note to the user right now, for example \"Searching the store now.\" Use it only before a slow step. Never for reasoning, page details or ids.",
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
          this.status("order placed");
          return { content: [{ type: "text", text: JSON.stringify({ ok: true, last4: r.last4, total: r.receipt.total }) }] };
        }
        this.status(`payment not completed: ${r.error}`);
        return { content: [{ type: "text", text: JSON.stringify({ ok: false, error: r.error }) }] };
      }
    );

    return createSdkMcpServer({
      name: "clearcart",
      version: "0.1.0",
      tools: [sayTool, requestCheckout, payNowTool],
      alwaysLoad: true,
      // request_checkout waits on a person; give it room.
      timeout: 10 * 60_000,
    });
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
        systemPrompt: (ext ? extPrompt(SYSTEM_PROMPT) : SYSTEM_PROMPT) + SITES_PROMPT,
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
      for await (const m of q) {
        if (m.type === "system" && m.subtype === "init") {
          const servers = (m as any).mcp_servers as Array<{ name: string; status: string }> | undefined;
          this.status(`agent ready (${(servers || []).map((s) => `${s.name}: ${s.status}`).join(", ")})`);
        } else if (m.type === "assistant" && !m.parent_tool_use_id) {
          const blocks = m.message.content as any[];
          // Only a message with no tool calls is a reply to the user. Text next
          // to tool calls is the model thinking aloud: log it, never speak it.
          const working = blocks.some((b) => b.type === "tool_use");
          for (const block of blocks) {
            if (block.type === "text" && block.text?.trim()) {
              if (working) this.status(`(not spoken) ${block.text.trim().slice(0, 120)}`);
              else this.say(block.text.trim());
            } else if (block.type === "tool_use") this.status(toolLabel(block.name, block.input));
          }
        } else if (m.type === "result") {
          if (m.subtype !== "success") this.status(`turn ended: ${m.subtype}`);
        }
      }
    } catch (e) {
      if (!this.closed) {
        this.status(`agent error: ${(e as Error).message}`);
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
