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
import { payNow, STORE_ORIGIN, type PayState } from "./pay.ts";
import { SYSTEM_PROMPT } from "./prompt.ts";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const MODEL = process.env.CLEARCART_MODEL || "claude-sonnet-5-5";
const BROWSER_SERVER =
  process.env.OCIC_SERVER || "/Users/sebastianarellano-rubach/code/open-claude-in-chrome/host/mcp-server.js";

// CLEARCART_ALLOWED_ORIGINS: comma-separated origins navigate and the tab
// sweep accept (default: the store only). pay_now stays store-only.
const ALLOWED_ORIGINS = new Set(
  [STORE_ORIGIN, ...(process.env.CLEARCART_ALLOWED_ORIGINS || "").split(",")]
    .map((o) => o.trim())
    .filter(Boolean)
    .map((o) => {
      try {
        return new URL(o).origin;
      } catch {
        return null;
      }
    })
    .filter((o): o is string => !!o && o !== "null")
);
const EXTRA_SITES = [...ALLOWED_ORIGINS].filter((o) => o !== STORE_ORIGIN);

function allowedSite(href: string | null | undefined): boolean {
  if (!href) return false;
  try {
    return ALLOWED_ORIGINS.has(new URL(href).origin);
  } catch {
    return false;
  }
}

const SITES_PROMPT = EXTRA_SITES.length
  ? `\n\nOther sites\n- You may also browse ${EXTRA_SITES.join(", ")}. On those sites stop once the item is in the cart and the cart page is open: never start checkout, never log in or create an account, never enter an address, card or other personal details, and decline marketing sign-ups and non-essential cookies. If a CAPTCHA, bot check or access-denied page appears, do not try to get around it; tell the user.`
  : "";

const B = "mcp__browser__";
const C = "mcp__clearcart__";

// Tools Claude never gets. execute_code is the big one: its sandbox can call
// every browser tool from inside one call, which would step around the
// per-tool guard below.
const DISALLOWED_BROWSER = [
  "execute_code",
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

const ALLOWED = [
  "tabs_context_mcp",
  "tabs_create_mcp",
  "tabs_close_mcp",
  "navigate",
  "computer",
  "find",
  "form_input",
  "get_page_text",
  "read_page",
  "javascript_tool",
  "read_console_messages",
  "set_tab_focus",
].map((t) => B + t).concat([C + "request_checkout", C + "pay_now"]);

// Blocked while card values sit in the checkout form: anything that can read
// or screenshot the page, or change it.
const BLOCKED_WHILE_CARD_LIVE = new Set(
  ["computer", "read_page", "get_page_text", "find", "form_input", "javascript_tool", "read_console_messages"].map((t) => B + t)
);

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
      if (this.state.cardFieldsLive && BLOCKED_WHILE_CARD_LIVE.has(name)) {
        return deny("Blocked: card details are in the checkout form. Wait for pay_now to finish.");
      }
      if (name === B + "navigate" && !process.env.CLEARCART_ALLOW_ANY_SITE) {
        const url = String(args.url || "");
        if (url !== "back" && url !== "forward" && !allowedSite(url)) {
          return deny(`Blocked: Clearcart only browses ${[...ALLOWED_ORIGINS].join(", ")}.`);
        }
      }
      if (typeof args.tabId === "number") this.state.lastTabId = args.tabId;
      else if (typeof args.tabId === "string" && /^\d+$/.test(args.tabId)) this.state.lastTabId = Number(args.tabId);
    }
    return {};
  };

  // After every browser call, any MCP-group tab that left the store (a clicked
  // link, a redirect, history) is sent back to the store home page.
  private sweep: HookCallback = async (input) => {
    if (input.hook_event_name !== "PostToolUse" || !input.tool_name.startsWith(B)) return {};
    if (process.env.CLEARCART_ALLOW_ANY_SITE) return {};
    let tabs: Array<{ tabId: number; url?: string }> = [];
    try {
      tabs = JSON.parse(resultText(await callBrowserTool("tabs_context_mcp", {})).split("\n")[0]).availableTabs || [];
    } catch {
      return {};
    }
    const strays = tabs.filter((t) => t.url && !allowedSite(t.url) && !/^(about:blank|chrome:\/\/newtab)/.test(t.url));
    for (const t of strays) {
      await callBrowserTool("navigate", { url: STORE_ORIGIN + "/", tabId: t.tabId }).catch(() => {});
    }
    if (!strays.length) return {};
    this.status(`returned ${strays.length} tab(s) to the store`);
    return {
      hookSpecificOutput: {
        hookEventName: "PostToolUse" as const,
        additionalContext: `A tab left the allowed sites and was sent back to the store home page. Only browse ${[...ALLOWED_ORIGINS].join(", ")}.`,
      },
    };
  };

  private tools() {
    const requestCheckout = tool(
      "request_checkout",
      "Read the order back to the user and wait for their spoken answer. Call this on the checkout page with the exact item, quantity and the order total shown on the page. Returns 'confirmed' only on an explicit yes, otherwise 'declined' with what the user said.",
      {
        item: z.string().describe("Product name and size or count, as the user would say it"),
        quantity: z.number().int().positive(),
        total: z.string().describe("Order total from the page, e.g. $14.27"),
      },
      async ({ item, quantity, total }) => {
        this.state.confirmation = { item, quantity, total, state: "pending" };
        this.say(`You're buying ${quantity} ${item} for ${total}. Say yes to pay, or no to change it.`);
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
      tools: [requestCheckout, payNowTool],
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
    const q = (this.q = query({
      prompt: this.input,
      options: {
        model: MODEL,
        systemPrompt: SYSTEM_PROMPT + SITES_PROMPT,
        cwd: HERE,
        tools: [],
        settingSources: [],
        strictMcpConfig: true,
        persistSession: false,
        abortController: this.abort,
        mcpServers: {
          browser: { type: "stdio", command: process.execPath, args: [BROWSER_SERVER], alwaysLoad: true, timeout: 90_000 },
          clearcart: this.tools(),
        },
        allowedTools: ALLOWED,
        disallowedTools: DISALLOWED_BROWSER,
        // Anything not in allowedTools is denied without prompting; the
        // PreToolUse guard gates the allowed ones per call.
        permissionMode: "dontAsk",
        hooks: { PreToolUse: [{ hooks: [this.guard] }], PostToolUse: [{ hooks: [this.sweep] }] },
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
          for (const block of m.message.content as any[]) {
            if (block.type === "text" && block.text?.trim()) this.say(block.text.trim());
            else if (block.type === "tool_use") this.status(toolLabel(block.name, block.input));
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
