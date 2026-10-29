// Claude's browser tools when CLEARCART_BROWSER=ext: an in-process MCP server
// named "browser" (tools appear as mcp__browser__<name>) whose every tool is
// one or two calls over the extension bridge. Only the TOOLS from
// extension/lib/protocol.js are exposed; INTERNAL methods (fill_card,
// lock_arm, press_protected and friends) stay reachable from our own code
// only. Clicks, keys and form_input on protected controls are refused by the
// extension itself (button lock), whatever arguments Claude sends.

import { createSdkMcpServer, tool, type SdkMcpToolDefinition } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";

import { ERR, ExtError, extBridge, type ExtBridge } from "./extbridge.ts";

type Bridge = Pick<ExtBridge, "call">;
type ToolResult = { content: Array<{ type: "text"; text: string } | { type: "image"; data: string; mimeType: string }>; isError?: boolean };

const tabId = z.number().int().optional().describe("Tab id from tabs_context. Default: the tab you used last, else the user's active tab.");

function text(value: unknown): ToolResult {
  return { content: [{ type: "text", text: typeof value === "string" ? value : JSON.stringify(value) }] };
}

function failure(e: unknown): ToolResult {
  const code = e instanceof ExtError ? e.code : ERR.INTERNAL;
  const message = e instanceof Error ? e.message : String(e);
  // Button lock refusals already read as a sentence for Claude.
  if (code === ERR.LOCKED) return { content: [{ type: "text", text: message }], isError: true };
  return { content: [{ type: "text", text: `Error (${code}): ${message}` }], isError: true };
}

// Drops undefined keys so the extension sees only what Claude passed.
function clean<T extends Record<string, unknown>>(o: T): Partial<T> {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as Partial<T>;
}

// click by ref: the extension's own ref path (router.js clickAt) reads the
// element's rect after the debugger attaches, checks what covers it
// (guard_ref), re-reads it right before the press when paced, and falls back
// to a DOM click itself only when no press reached the page. The extension
// answers via plus where the tab is once the page settled (Settled).
export type Settled = { navigated?: boolean; url?: string; title?: string };

function settledOf(r: unknown): Settled {
  const o = (r && typeof r === "object" ? r : {}) as Record<string, unknown>;
  const out: Settled = {};
  if (typeof o.navigated === "boolean") out.navigated = o.navigated;
  if (typeof o.url === "string") out.url = o.url;
  if (typeof o.title === "string") out.title = o.title;
  return out;
}

export async function clickRef(bridge: Bridge, ref: string, tab?: number): Promise<{ via: "cdp" | "dom" } & Settled> {
  const done = await bridge.call<{ via?: string }>("click", clean({ tabId: tab, ref }));
  return { via: done?.via === "dom" ? "dom" : "cdp", ...settledOf(done) };
}

export function extToolDefinitions(bridge: Bridge = extBridge): SdkMcpToolDefinition<any>[] {
  const pass =
    (method: string) =>
    async (args: Record<string, unknown>): Promise<ToolResult> => {
      try {
        return text(await bridge.call(method, clean(args)));
      } catch (e) {
        return failure(e);
      }
    };

  return [
    tool(
      "tabs_context",
      "List the user's open tabs you may use: { tabs: [{ tabId, title, url, active, openedByClearcart }] }. url is the origin and path only. active is the tab the user is looking at. Tabs on blocked sites are not listed. Call this first.",
      {},
      pass("tabs_context")
    ),
    tool(
      "tabs_create",
      "Open a new tab next to the user's tab, optionally at a URL. Orbi brings the user to it unless they turned that off. Prefer this over navigating away from a page the user had open. Returns { tabId }.",
      { url: z.string().optional() },
      pass("tabs_create")
    ),
    tool(
      "tabs_close",
      "Close a tab you opened (openedByClearcart true). The user's own tabs cannot be closed.",
      { tabId: z.number().int() },
      pass("tabs_close")
    ),
    tool(
      "tabs_activate",
      "Bring a tab to the front. Only when the user asks to see it.",
      { tabId: z.number().int() },
      pass("tabs_activate")
    ),
    tool(
      "navigate",
      'Load a URL in a tab and wait for it to finish. url may also be "back" or "forward". Returns { tabId, url, title }.',
      { tabId, url: z.string() },
      pass("navigate")
    ),
    tool(
      "read_page",
      'Accessibility tree of the page as indented lines like - button "Add to bag" [ref_12]. Use the refs with click and form_input. Lines ending in [locked] are controls your click tools cannot press (checkout, sign in, sign up, subscribe, order, pay, wallets): if the user wants one, call request_unlock with its ref and label, never for Place order, Buy now, Pay or wallets. [uncheck only] boxes you may turn off; turning one on also goes through request_unlock.',
      { tabId, filter: z.enum(["interactive", "all"]).optional(), maxNodes: z.number().int().positive().max(2000).optional() },
      pass("read_page")
    ),
    tool(
      "find",
      "Find elements by visible text, role or label. Returns { matches: [{ ref, role, name, locked?, uncheckOnly? }] }. locked and uncheckOnly mean the same as [locked] and [uncheck only] in read_page: use request_unlock with the ref if the user wants it.",
      { tabId, query: z.string(), limit: z.number().int().positive().max(100).optional() },
      pass("find")
    ),
    tool(
      "get_page_text",
      "Readable text of the page, main content first. Returns { url, title, text, locked? }. locked lists the page's locked controls as [{ ref, name, uncheckOnly?, userOnly? }], the same as [locked] in read_page; userOnly ones (Place order, Buy now, Pay, wallets) never go through request_unlock. On Google Docs, Sheets and Slides, text is the file's own text and note says how to edit it.",
      { tabId, maxChars: z.number().int().positive().max(100_000).optional() },
      pass("get_page_text")
    ),
    tool(
      "form_input",
      "Set the value of a form field (text, select, checkbox) by ref. Payment and password fields are refused. Locked controls are refused with a message naming the ref and the next step; [uncheck only] boxes may be set to false.",
      { tabId, ref: z.string(), value: z.union([z.string(), z.number(), z.boolean()]) },
      pass("form_input")
    ),
    tool(
      "click",
      "Click an element by ref (preferred), or at viewport coordinates x, y in CSS pixels, the same space as the screenshot image (its size is given with it). A point outside the viewport is refused. A click that would press a locked control is refused with a message starting Locked: that names the control and its ref and says the next step (usually request_unlock with that ref if the user wants it). Nothing is pressed then; do not retry it. Returns { ok, navigated, url, title }: where the tab is once a page the click opened has loaded.",
      {
        tabId,
        ref: z.string().optional().describe("Element ref from read_page or find, e.g. ref_12"),
        x: z.number().optional(),
        y: z.number().optional(),
      },
      async ({ tabId: tab, ref, x, y }) => {
        try {
          if (ref) {
            const r = await clickRef(bridge, ref, tab);
            return text({ ok: true, ...r });
          }
          if (typeof x === "number" && typeof y === "number") {
            const done = await bridge.call("click", clean({ tabId: tab, x, y }));
            return text({ ok: true, x, y, via: "cdp", ...settledOf(done) });
          }
          return failure(new ExtError(ERR.BAD_REQUEST, "click needs a ref, or both x and y"));
        } catch (e) {
          return failure(e);
        }
      }
    ),
    tool("type", "Type text into the focused element. A newline that would submit a locked form is refused like a locked click.", { tabId, text: z.string() }, pass("type")),
    tool(
      "key",
      'Press one key, e.g. "Enter", "Tab", "Escape", "ArrowDown". Enter or Space that would press or submit a locked control is refused like a locked click. Returns { ok, navigated, url, title }: where the tab is once a page the key opened has loaded.',
      { tabId, key: z.string() },
      pass("key")
    ),
    tool(
      "scroll",
      "Scroll by dx, dy pixels at viewport point x, y in CSS pixels, as in the screenshot (default: the centre).",
      { tabId, x: z.number().optional(), y: z.number().optional(), dx: z.number().optional(), dy: z.number().optional() },
      pass("scroll")
    ),
    tool(
      "dismiss_overlay",
      "Close the marketing pop-up covering the page (email or SMS sign-up, discount offer, newsletter, app promo). It tries the pop-up's close or no thanks button, Escape, and a click on the backdrop, then hides it. Returns { dismissed, via, name }. Sign-in, checkout, payment, verification and cookie dialogs are refused; for a cookie banner, choose reject or necessary only in it.",
      { tabId },
      pass("dismiss_overlay")
    ),
    tool("screenshot", "JPEG screenshot of the tab's viewport, sized in CSS pixels: a point read off the image is the x, y to click or scroll at.", { tabId }, async (args) => {
      try {
        const r = await bridge.call<{ data: string; mimeType?: string; width?: number; height?: number; scale?: number }>("screenshot", clean(args));
        if (!r || typeof r.data !== "string") return failure(new ExtError(ERR.INTERNAL, "no screenshot data"));
        const content: ToolResult["content"] = [{ type: "image", data: r.data, mimeType: r.mimeType || "image/jpeg" }];
        if (r.width && r.height) {
          const scale = r.scale && r.scale !== 1 ? r.scale : 1;
          content.push({
            type: "text",
            text:
              scale === 1
                ? `Viewport ${r.width}x${r.height} CSS px; image pixels are click coordinates.`
                : `Viewport ${r.width}x${r.height} CSS px; this image is ${scale}x larger, so divide image coordinates by ${scale} before clicking.`,
          });
        }
        return { content };
      } catch (e) {
        return failure(e);
      }
    }),
  ];
}

export function createExtToolsServer(bridge: Bridge = extBridge) {
  return createSdkMcpServer({
    name: "browser",
    version: "0.1.0",
    tools: extToolDefinitions(bridge),
    alwaysLoad: true,
    timeout: 90_000,
  });
}
