// The user's Search engine setting (extension/lib/settings.js). "default"
// is Chrome's own engine, which the agent cannot reach, so it uses Google.
// A leaf module: extbridge.ts needs it, and importing prompt.ts there made
// a cycle (origins.ts -> extbridge.ts -> prompt.ts -> origins.ts).
export const SEARCH_ENGINES = ["google", "bing", "duckduckgo", "default"] as const;
export type SearchEngine = (typeof SEARCH_ENGINES)[number];
