// Open web browsing: the blocked sites check, shared with the extension.
// The code and the suggested list live in extension/lib/blocklist.js (plain
// JS, no imports); this file only gives it types.
//
// In ext mode the extension is the authority: it sends the user's list over
// the bridge (extbridge.ts) and the guard and sweep use that. The OCIC path
// has no extension settings, so it uses SUGGESTED_ENTRIES.

// @ts-ignore: plain JS module outside this tsconfig
import * as shared from "../extension/lib/blocklist.js";

export type BlockEntry = { text: string; keyword?: string; label?: string; host?: string; any?: boolean; path?: string };

export const SUGGESTED_BLOCKLIST: readonly string[] = shared.SUGGESTED_BLOCKLIST;
export const SUGGESTED_ENTRIES: readonly BlockEntry[] = shared.SUGGESTED_ENTRIES;

export const parseBlockLines: (input: string | readonly unknown[]) => { lines: string[]; entries: BlockEntry[]; bad: string[] } =
  shared.parseBlockLines;

// Fixed rules (non-web pages, logins in the address, local addresses other
// than `local`) first, then `entries`.
export const blocklistReason: (href: string | null | undefined, entries?: readonly BlockEntry[], local?: ReadonlySet<string>) => string | null =
  shared.blocklistReason;
