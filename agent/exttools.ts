// Claude's browser tools when CLEARCART_BROWSER=ext: an in-process MCP server
// named "browser" (tools appear as mcp__browser__<name>) whose every tool is
// one or two calls over the extension bridge. Only the TOOLS from
// extension/lib/protocol.js are exposed; INTERNAL methods (fill_payment,
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

// click by ref: ask the page for the element's rect (it scrolls it into view
// first), then click its centre through CDP. If rect/CDP is unavailable, fall
// back to a DOM click on the ref.
export async function clickRef(bridge: Bridge, ref: string, tab?: number): Promise<{ x?: number; y?: number; via: "cdp" | "dom" }> {
  let r: { x: number; y: number; width: number; height: number };
  try {
    r = await bridge.call("rect", clean({ tabId: tab, ref }));
  } catch (e) {
    if (e instanceof ExtError && e.code === ERR.UNKNOWN_METHOD) {
      await bridge.call("click_ref", clean({ tabId: tab, ref }));
      return { via: "dom" };
    }
    throw e;
  }
  if (!r || !(r.width > 0) || !(r.height > 0)) throw new ExtError(ERR.NO_ELEMENT, `${ref} is not visible`);
  const x = Math.round(r.x + r.width / 2);
  const y = Math.round(r.y + r.height / 2);
  try {
    await bridge.call("click", clean({ tabId: tab, x, y }));
    return { x, y, via: "cdp" };
  } catch (e) {
    if (e instanceof ExtError && (e.code === ERR.UNKNOWN_METHOD || e.code === ERR.INTERNAL)) {
      await bridge.call("click_ref", clean({ tabId: tab, ref }));
      return { via: "dom" };
    }
    throw e;
  }
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
      "Open a new tab in the background next to the user's tab, optionally at a URL. The user stays on their tab. Prefer this over navigating away from a page the user had open. Returns { tabId }.",
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
      'Accessibility tree of the page as indented lines like - button "Add to bag" [ref_12]. Use the refs with click and form_input. Lines ending in [locked] are controls you can never press (order, checkout, payment, subscribe, sign in); [uncheck only] boxes may only be turned off.',
      { tabId, filter: z.enum(["interactive", "all"]).optional(), maxNodes: z.number().int().positive().max(2000).optional() },
      pass("read_page")
    ),
    tool(
      "find",
      "Find elements by visible text, role or label. Returns { matches: [{ ref, role, name, locked?, uncheckOnly? }] }.",
      { tabId, query: z.string(), limit: z.number().int().positive().max(100).optional() },
      pass("find")
    ),
    tool(
      "get_page_text",
      "Readable text of the page, main content first. Returns { url, title, text }.",
      { tabId, maxChars: z.number().int().positive().max(100_000).optional() },
      pass("get_page_text")
    ),
    tool(
      "form_input",
      "Set the value of a form field (text, select, checkbox) by ref. Payment fields and locked controls are refused; [uncheck only] boxes may be set to false.",
      { tabId, ref: z.string(), value: z.union([z.string(), z.number(), z.boolean()]) },
      pass("form_input")
    ),
    tool(
      "click",
      "Click an element by ref (preferred), or at viewport coordinates x, y. Clicks on locked controls are refused.",
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
            await bridge.call("click", clean({ tabId: tab, x, y }));
            return text({ ok: true, x, y, via: "cdp" });
          }
          return failure(new ExtError(ERR.BAD_REQUEST, "click needs a ref, or both x and y"));
        } catch (e) {
          return failure(e);
        }
      }
    ),
    tool("type", "Type text into the focused element.", { tabId, text: z.string() }, pass("type")),
    tool(
      "key",
      'Press one key, e.g. "Enter", "Tab", "Escape", "ArrowDown".',
      { tabId, key: z.string() },
      pass("key")
    ),
    tool(
      "scroll",
      "Scroll by dx, dy pixels at viewport point x, y (default: the centre).",
      { tabId, x: z.number().optional(), y: z.number().optional(), dx: z.number().optional(), dy: z.number().optional() },
      pass("scroll")
    ),
    tool("screenshot", "JPEG screenshot of the tab's viewport.", { tabId }, async (args) => {
      try {
        const r = await bridge.call<{ data: string; mimeType?: string }>("screenshot", clean(args));
        if (!r || typeof r.data !== "string") return failure(new ExtError(ERR.INTERNAL, "no screenshot data"));
        return { content: [{ type: "image", data: r.data, mimeType: r.mimeType || "image/jpeg" }] };
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
