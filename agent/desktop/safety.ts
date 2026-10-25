// Orbi Desktop's deterministic safety rules. Every one is enforced here, in
// code, before a request reaches the helper; the prompt only explains them.
// Every check fails closed: if the target cannot be resolved, nothing is
// pressed or typed.
//
//   - Blocked apps: Keychain Access, password managers, banking and
//     crypto apps, System Settings and security prompts, terminals and
//     script runners, and Chrome (the browser tools drive Chrome, with the
//     extension's own button lock). Orbi never reads, clicks, types,
//     presses keys or scrolls in them, and never opens them. The user can
//     add apps in a config file (blockedAppsFile); the built-in list can't
//     be shortened.
//   - The lock: a control is classified by its title and label with the
//     extension's own word lists (extension/content/protect.js), plus
//     desktop classes: send (Mail, Messages, chat apps), delete or move to
//     trash, and install or allow. A locked control is pressed only when
//     the user's own last words asked for it (user-unlock.ts isDirectAsk,
//     isDesktopDirectAsk), else after one spoken question and a clear yes.
//     Order and pay controls always get the question; wallets (Apple Pay)
//     never unlock. Enter, Return and Space press the focused control (or
//     the window's default button), and Enter in a chat app sends, so keys
//     are checked the same way.
//   - A click at a point with no labeled control under it needs a spoken
//     yes. If the hit test fails, the click is refused.
//   - Masking: every title, label and value goes through mask.js's card
//     masking, payment fields and secure fields are masked whole, and
//     API keys, tokens and private keys are masked too.
//   - Typing: never into a secure or payment field, never a card number.
//   - Danger mode lifts the lock and the spoken yes for unlabeled clicks,
//     as in the browser. Blocked apps, masking and the typing rules stay.

import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";

// extbridge.ts before user-unlock.ts: origins.ts and prompt.ts import each
// other through it, and only this order initializes them.
import "../extbridge.ts";
import { isDesktopDirectAsk, isDirectAsk, type DesktopUnlockClass, type UnlockClass } from "../user-unlock.ts";
import { orbiConfigPath } from "../userconfig.ts";

const require = createRequire(import.meta.url);
const CONTENT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "extension", "content");
type ProtectApi = {
  classifyLabel(label: string, opts?: { checkable?: boolean }): string | null;
  normalize(s: string): string;
  isCheckoutNav(label: string): boolean;
  sameLabel(a: string, b: string): boolean;
};
type MaskApi = { maskCardRuns(s: string): string; isPaymentField(el: unknown): boolean; MASK: string };
const Protect: ProtectApi = require(path.join(CONTENT, "protect.js"));
const Mask: MaskApi = require(path.join(CONTENT, "mask.js"));

// ------------------------------------------------------------ elements

export type Frame = { x: number; y: number; w: number; h: number };
export type AXElement = {
  ref: string;
  role?: string;
  subrole?: string;
  title?: string;
  label?: string;
  value?: string;
  frame?: Frame;
  enabled?: boolean;
  secure?: boolean;
};
// What the helper says is at a ref, a point or the focus.
export type Target = { element: AXElement | null; bundleId: string; appName: string; windowTitle: string; defaultButton?: AXElement | null };

// ---------------------------------------------------------- blocked apps

type Block = { id?: RegExp; name?: RegExp; why: string };
const PASSWORDS = "it holds passwords or keys";
const BANK = "it is a banking or money app";
const SYSTEM = "it changes system settings or security";
const SHELL = "it runs commands on the computer";
const OTHER_BROWSER = "Orbi uses the web only in Chrome, where the Orbi extension guards sites, cards and checkout";
export const CHROME_REASON = "Chrome is driven by the browser tools, with the Orbi extension's own button lock. Use them for anything in Chrome.";

const BUILT_IN: Block[] = [
  { id: /^com\.apple\.keychainaccess$/i, why: PASSWORDS },
  { id: /^com\.apple\.Passwords$/i, why: PASSWORDS },
  { id: /^(com\.1password\.|com\.agilebits\.)/i, why: PASSWORDS },
  { id: /^com\.bitwarden\./i, why: PASSWORDS },
  { id: /^(com\.lastpass\.|com\.dashlane\.|org\.keepassxc\.|com\.callpod\.keeper|com\.nordpass\.|com\.siber\.roboform|com\.enpass\.|com\.protonpass\.|me\.proton\.pass)/i, why: PASSWORDS },
  { name: /\b(1password|bitwarden|lastpass|dashlane|keepass\w*|keeper|nordpass|roboform|enpass|proton pass|keychain|passwords?)\b/i, why: PASSWORDS },
  { id: /^(com\.rbc\.|com\.td\.|com\.tdbank|com\.scotiabank|com\.bmo\.|com\.cibc\.|com\.chase|com\.jpmorgan|com\.wellsfargo|com\.bankofamerica|com\.capitalone|com\.americanexpress|com\.desjardins|com\.tangerine|com\.simplii|com\.usbank|com\.citi|com\.hsbc|com\.barclays|com\.schwab|com\.fidelity|com\.vanguard|com\.coinbase|com\.robinhood|com\.wealthsimple|com\.paypal|com\.venmo|com\.squareup\.cash)/i, why: BANK },
  { name: /\b(scotiabank|rbc|td|bmo|cibc|chase|wells fargo|capital one|american express|amex|tangerine|desjardins|simplii|citi|hsbc|barclays|schwab|fidelity|vanguard)\b/i, why: BANK },
  { name: /\b(bank|banking|credit union|wealthsimple|questrade|robinhood|coinbase|kraken|binance|ledger live|exodus|electrum|metamask|trezor|venmo|paypal|cash app|wise|revolut|monzo|interac)\b/i, why: BANK },
  { id: /^(com\.apple\.systempreferences|com\.apple\.Settings|com\.apple\.SecurityAgent|com\.apple\.LocalAuthentication\.UIAgent|com\.apple\.loginwindow|com\.apple\.coreservices\.uiagent|com\.apple\.Passbook)$/i, why: SYSTEM },
  { name: /^(system settings|system preferences|security agent|wallet)$/i, why: SYSTEM },
  { id: /^(com\.apple\.Terminal|com\.googlecode\.iterm2|dev\.warp\.|com\.mitchellh\.ghostty|io\.alacritty|net\.kovidgoyal\.kitty|co\.zeit\.hyper|com\.github\.wez\.wezterm|com\.apple\.ScriptEditor2|com\.apple\.Automator|com\.apple\.shortcuts)/i, why: SHELL },
  { name: /^(terminal|iterm2?|warp|ghostty|alacritty|kitty|hyper|wezterm|script editor|automator|shortcuts)$/i, why: SHELL },
  // Editors and IDEs with a built-in terminal.
  { id: /^(com\.microsoft\.VSCode|com\.todesktop\.|com\.apple\.dt\.Xcode|com\.jetbrains\.|dev\.zed\.|com\.exafunction\.windsurf|com\.barebones\.bbedit|org\.python\.|com\.sublimetext\.|com\.panic\.Nova|com\.vscodium|com\.github\.atom)/i, why: SHELL },
  { name: /^(visual studio code|code|cursor|xcode|zed|windsurf|bbedit|idle|sublime text|nova|vscodium|intellij idea|pycharm|webstorm|goland|clion|rider|android studio)\b/i, why: SHELL },
  { id: /^com\.google\.Chrome(\.|$)/i, why: CHROME_REASON },
  // Other browsers lack the extension's site lock, card guard and read-back.
  { id: /^(com\.apple\.Safari|company\.thebrowser\.|com\.microsoft\.edgemac|com\.brave\.Browser|org\.mozilla\.|com\.operasoftware\.|com\.vivaldi\.|app\.zen-browser|org\.chromium\.|com\.openai\.atlas|ai\.perplexity\.comet)/i, why: OTHER_BROWSER },
  { name: /^(safari|arc|microsoft edge|brave browser|firefox|opera|vivaldi|zen|chromium|dia|comet|chatgpt atlas)$/i, why: OTHER_BROWSER },
  { name: /^google chrome/i, why: CHROME_REASON },
];

// The user's own additions: one bundle id or app name per line, # for a
// comment. Next to the setup config (userconfig.ts), e.g.
// ~/.config/orbi/desktop-blocked-apps.txt; ORBI_DESKTOP_BLOCKED_APPS points
// elsewhere. Read on every check, so an edit counts at once.
export function blockedAppsFile(env: NodeJS.ProcessEnv = process.env): string {
  if (env.ORBI_DESKTOP_BLOCKED_APPS?.trim()) return path.resolve(env.ORBI_DESKTOP_BLOCKED_APPS.trim());
  return path.join(path.dirname(orbiConfigPath(env)), "desktop-blocked-apps.txt");
}

// For the helper's welcome: well known bundle ids of the built-in list
// (the patterns above stay the server's check) plus the user's additions.
export const BUILT_IN_BUNDLE_IDS = [
  "com.apple.keychainaccess", "com.apple.Passwords", "com.1password.1password", "com.agilebits.onepassword7", "com.bitwarden.desktop",
  "com.lastpass.LastPass", "org.keepassxc.keepassxc", "com.apple.systempreferences", "com.apple.SecurityAgent", "com.apple.Terminal",
  "com.googlecode.iterm2", "dev.warp.Warp-Stable", "com.mitchellh.ghostty", "com.apple.ScriptEditor2", "com.apple.Automator",
  "com.microsoft.VSCode", "com.todesktop.230313mzl4w4u92", "com.apple.dt.Xcode", "dev.zed.Zed", "com.google.Chrome", "com.apple.Safari",
];
export function userBlockedApps(): string[] {
  return [...new Set([...BUILT_IN_BUNDLE_IDS, ...userBlocked(blockedAppsFile())])];
}

function userBlocked(file: string): string[] {
  try {
    return fs
      .readFileSync(file, "utf8")
      .split(/\r?\n/)
      .map((l) => l.replace(/#.*$/, "").trim().toLowerCase())
      .filter(Boolean)
      .slice(0, 1000);
  } catch {
    return [];
  }
}

// Why Orbi may not use this app, or null. No bundle id at all (the helper
// could not tell which app) is refused too.
export function appBlockReason(bundleId: string | null | undefined, appName?: string | null, extra: readonly string[] = userBlocked(blockedAppsFile())): string | null {
  const id = String(bundleId ?? "").trim();
  const name = String(appName ?? "").trim();
  if (!id) return "Orbi could not tell which app that is, so it does nothing there.";
  for (const b of BUILT_IN) {
    if ((b.id && b.id.test(id)) || (b.name && name && b.name.test(name))) return b.why === CHROME_REASON ? b.why : `Orbi does not use ${name || id}: ${b.why}. The user can use it themselves.`;
  }
  if (extra.includes(id.toLowerCase()) || (name && extra.includes(name.toLowerCase()))) return `Orbi does not use ${name || id}: the user blocked it in Orbi's settings.`;
  return null;
}

// --------------------------------------------------------------- masking

export const HIDDEN = "[hidden]";
export const SECRET_MASK = "[masked secret]";
const SECRETS = [
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(-----END [A-Z ]*PRIVATE KEY-----|$)/g,
  /\b(sk|pk|rk)[-_](live|test|proj|ant)?[-_]?[A-Za-z0-9_-]{16,}/g,
  /\b(ghp|gho|ghu|ghs|ghr|github_pat)_[A-Za-z0-9_]{20,}/g,
  /\bxox[abprs]-[A-Za-z0-9-]{10,}/g,
  /\bAKIA[0-9A-Z]{16}\b/g,
  /\bAIza[0-9A-Za-z_-]{30,}/g,
  /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g,
  /\b(bearer|token|api[_ -]?key|secret|password|passwd)\s*[:=]\s*\S{6,}/gi,
];

export function maskText(s: unknown): string {
  let t = Mask.maskCardRuns(String(s ?? ""));
  for (const re of SECRETS) t = t.replace(re, SECRET_MASK);
  return t;
}

const TEXT_ROLES = /^AX(TextField|TextArea|ComboBox|SearchField|SecureTextField)$/;

// mask.js decides payment fields from the words around a DOM input; an AX
// element is shown to it as a text input with that label, title and help.
function paymentField(el: AXElement): boolean {
  if (!TEXT_ROLES.test(String(el.role ?? ""))) return false;
  const attrs: Record<string, string> = { "aria-label": String(el.label ?? ""), placeholder: String(el.title ?? ""), name: "", autocomplete: "" };
  const fake = { nodeType: 1, tagName: "INPUT", type: "text", id: "", labels: [], isContentEditable: false, getAttribute: (n: string) => attrs[n] ?? null, ownerDocument: null };
  return Mask.isPaymentField(fake);
}

export function isSecure(el: AXElement | null | undefined): boolean {
  if (!el) return false;
  return el.secure === true || el.role === "AXSecureTextField" || el.subrole === "AXSecureTextField";
}

// What the model may see of an element.
export function maskElement(el: AXElement): AXElement {
  const out: AXElement = { ...el };
  for (const k of ["title", "label"] as const) if (out[k] != null) out[k] = maskText(out[k]);
  if (out.value != null) out.value = isSecure(el) ? HIDDEN : paymentField(el) ? (out.value ? Mask.MASK : "") : maskText(out.value);
  return out;
}

// --------------------------------------------------------------- the lock

export type DesktopClass = UnlockClass | DesktopUnlockClass;
// kind: what the control does. cls: how it unlocks; null never unlocks.
export type DesktopLock = { kind: string; label: string; cls: DesktopClass | null; money?: boolean };

const SEND = / (send|send now|send message|send email|send reply|send later) /;
const DELETE = / (delete|delete forever|delete permanently|permanently delete|move to trash|move to bin|empty trash|empty bin|erase|discard|discard changes) /;
const INSTALL = / (install|install now|install update|allow|always allow|allow once|approve|authorize|authorise|trust|open anyway|grant access|grant) /;
// "Don't Send", "Cancel", "Not Now", "Undo Delete": the way out, not the act.
const DESKTOP_NEGATIVE = / (don t|dont|do not|never|cancel|not now|undo|later|deny|reject) /;
const CHECKABLE = /^AX(CheckBox|RadioButton|Switch)$/;

// Chat and mail apps, where Return (or Cmd+Return) in the message field sends.
const MESSAGING = /^(com\.apple\.MobileSMS|com\.apple\.mail|com\.tinyspeck\.slackmacgap|com\.hnc\.Discord|net\.whatsapp\.WhatsApp|desktop\.WhatsApp|ru\.keepcoder\.Telegram|org\.telegram\.desktop|com\.microsoft\.teams2?|com\.microsoft\.Outlook|us\.zoom\.xos|com\.facebook\.archon|org\.whispersystems\.signal-desktop|com\.readdle\.smartemail-Mac|com\.superhuman\.electron|it\.bloop\.airmail2|com\.google\.Gmail)/i;
export function isMessagingApp(bundleId: string): boolean {
  return MESSAGING.test(bundleId);
}

function labelsOf(el: AXElement): string[] {
  return [el.title, el.label].map((s) => String(s ?? "").trim()).filter(Boolean);
}

function classifyOne(label: string, checkable: boolean): DesktopLock | null {
  const n = Protect.normalize(label);
  const words = n.trim().split(" ").length;
  if (words <= 6 && !DESKTOP_NEGATIVE.test(n)) {
    if (SEND.test(n)) return { kind: "send", label, cls: "send" };
    if (DELETE.test(n)) return { kind: "delete", label, cls: "delete" };
    if (INSTALL.test(n)) return { kind: "install", label, cls: "install" };
  }
  const kind = Protect.classifyLabel(label, { checkable });
  if (!kind) return null;
  switch (kind) {
    case "order":
      return Protect.isCheckoutNav(label) ? { kind, label, cls: "checkout" } : { kind, label, cls: null, money: true };
    case "account":
    case "subscription":
    case "payment-method":
      return { kind, label, cls: kind };
    default:
      // express wallets (Apple Pay, PayPal): only the user presses them.
      return { kind, label, cls: null };
  }
}

// The lock on an element, or null when Orbi may press it.
export function classifyElement(el: AXElement | null | undefined): DesktopLock | null {
  if (!el) return null;
  const checkable = CHECKABLE.test(String(el.role ?? ""));
  for (const label of labelsOf(el)) {
    const lock = classifyOne(label, checkable);
    if (lock) return lock;
  }
  return null;
}

// --------------------------------------------------------------- keys

const ENTER = /^(enter|return|numpadenter|kp_enter|kpenter)$/i;
const SPACE = /^(space|spacebar| )$/i;
const DELETE_KEYS = /^(delete|backspace|forwarddelete|del)$/i;

export type Combo = { key: string; cmd: boolean; shift: boolean; alt: boolean; ctrl: boolean };
export function parseCombo(combo: string): Combo | null {
  const parts = String(combo ?? "").split("+").map((p) => p.trim()).filter((p, i, a) => p || i === a.length - 1);
  if (!parts.length || parts.length > 5) return null;
  const key = parts.pop()!.trim() || " ";
  const mods = parts.map((p) => p.toLowerCase());
  const c: Combo = { key, cmd: false, shift: false, alt: false, ctrl: false };
  for (const m of mods) {
    if (/^(cmd|command|meta|super|⌘)$/.test(m)) c.cmd = true;
    else if (/^(shift|⇧)$/.test(m)) c.shift = true;
    else if (/^(alt|option|opt|⌥)$/.test(m)) c.alt = true;
    else if (/^(ctrl|control|⌃)$/.test(m)) c.ctrl = true;
    else if (m === "fn") continue;
    else return null;
  }
  return c;
}

// What a key press does that needs the lock: none, press the focused
// control (Enter, Return, Space), or a shortcut with its own lock.
export type KeyEffect = { kind: "none" } | { kind: "activate"; enter: boolean } | { kind: "lock"; lock: DesktopLock };
export function keyEffect(c: Combo, bundleId: string, focused?: AXElement | null): KeyEffect {
  // Cmd+Return sends in mail and chat apps, including web ones.
  if (ENTER.test(c.key) && c.cmd) return { kind: "lock", lock: { kind: "send", label: "Send (Cmd+Return)", cls: "send" } };
  if (ENTER.test(c.key)) return { kind: "activate", enter: true };
  if (SPACE.test(c.key) && !c.cmd && !c.ctrl && !c.alt) return { kind: "activate", enter: false };
  // A bare Delete outside a text field deletes the selection (Mail, Photos, Finder).
  if (DELETE_KEYS.test(c.key) && !c.cmd && !isTextTarget(focused)) return { kind: "lock", lock: { kind: "delete", label: "Delete", cls: "delete" } };
  if (DELETE_KEYS.test(c.key) && c.cmd) return { kind: "lock", lock: { kind: "delete", label: c.shift ? "Empty Trash" : "Move to Trash", cls: "delete" } };
  if (/^d$/i.test(c.key) && c.cmd && c.shift && /^com\.apple\.mail$/i.test(bundleId)) return { kind: "lock", lock: { kind: "send", label: "Send", cls: "send" } };
  return { kind: "none" };
}

// The lock on Enter, Return or Space: the focused control, else the
// window's default button on Enter, and Enter in a chat app's message
// field sends.
export function keyLock(effect: { enter: boolean }, t: Target): DesktopLock | null {
  const el = t.element;
  const own = classifyElement(el);
  if (own) return own;
  if (effect.enter) {
    if (isSecure(el)) return { kind: "account", label: "Sign in", cls: "account" };
    if (isMessagingApp(t.bundleId) && (!el || TEXT_ROLES.test(String(el.role ?? "")) || el.role === "AXWebArea")) {
      return { kind: "send", label: `Send (Return in ${t.appName || "this app"})`, cls: "send" };
    }
    const def = classifyElement(t.defaultButton);
    if (def) return def;
  }
  return null;
}

// --------------------------------------------------------------- decide

export type DesktopDecision =
  | { kind: "allow" }
  | { kind: "refuse"; message: string }
  | { kind: "press"; lock: DesktopLock }
  | { kind: "ask"; lock: DesktopLock | null; question: string };

// Unlabeled: no title or label that names it, or a container (a window,
// a group, a web area) whose name says nothing about the spot clicked.
const CONTAINERS = /^AX(Window|Group|WebArea|ScrollArea|Image|Unknown|SplitGroup|Layout(Area|Item)|Canvas|Sheet|Drawer|Application|List|Outline|Table|Browser|TabGroup|Splitter|Matte|Grid)?$/;
export function unlabeled(el: AXElement | null | undefined): boolean {
  return !el || !el.role || !labelsOf(el).length || CONTAINERS.test(String(el.role));
}

// A field text can be typed into.
export function isTextTarget(el: AXElement | null | undefined): boolean {
  return !!el && (TEXT_ROLES.test(String(el.role ?? "")) || el.role === "AXWebArea");
}

function directAsk(userText: string, lock: DesktopLock): boolean {
  if (!lock.cls) return false;
  if (lock.cls === "send" || lock.cls === "delete" || lock.cls === "install") return isDesktopDirectAsk(userText, lock.cls, lock.label);
  return isDirectAsk(userText, lock.cls, lock.label);
}

// What to do about pressing a control (lock from classifyElement or
// keyLock). point: the click was at coordinates, and el is what the hit
// test found there. spent: unlock classes already used directly for these
// words (one press per ask).
export function decidePress(
  lock: DesktopLock | null,
  t: Target,
  opts: { userText: string; spent?: Set<string>; danger: boolean; point?: boolean }
): DesktopDecision {
  const where = t.appName || t.bundleId;
  if (!lock) {
    if (opts.point && unlabeled(t.element) && !opts.danger) {
      return { kind: "ask", lock: null, question: `I can't tell what is at that spot in ${where}. Do you want me to click it?` };
    }
    return { kind: "allow" };
  }
  if (opts.danger) return { kind: "allow" };
  const name = `'${maskText(lock.label)}'`;
  if (!lock.cls && !lock.money) {
    return { kind: "refuse", message: `Locked: ${name} is a one-tap wallet or pay later button, so nothing was pressed. Only the user can press it. Tell them where it is if they want it.` };
  }
  if (lock.money) return { kind: "ask", lock, question: `Do you want me to press ${maskText(lock.label)} in ${where}? It may pay or place an order.` };
  if (!opts.spent?.has(lock.cls!) && directAsk(opts.userText, lock)) return { kind: "press", lock };
  return { kind: "ask", lock, question: `Do you want me to press ${maskText(lock.label)} in ${where}?` };
}

// ---------------------------------------------------------------- grants

// A press decided on (asked for, or a yes) is bound to the app, its window,
// the control and its label: the helper re-resolves the target right
// before the press, and a grant for anything else is refused. Single use,
// short lived, like user-unlock.ts UserUnlockGate.
export const DESKTOP_GRANT_TTL_MS = 60_000;
export type DesktopGrant = { token: string };
export type GrantAt = { bundleId: string; windowTitle: string; ref: string | null; label: string; cls: string | null };

export class DesktopUnlockGate {
  private live = new Map<string, GrantAt & { expires: number }>();
  constructor(private now: () => number = Date.now, private ttlMs = DESKTOP_GRANT_TTL_MS) {}

  issue(at: GrantAt): DesktopGrant {
    for (const [k, l] of this.live) if (l.expires <= this.now()) this.live.delete(k);
    const token = randomBytes(16).toString("hex");
    this.live.set(token, { ...at, expires: this.now() + this.ttlMs });
    return { token };
  }

  consume(grant: DesktopGrant | null | undefined, at: GrantAt): boolean {
    const l = grant && this.live.get(grant.token);
    if (!grant || !l) return false;
    this.live.delete(grant.token);
    const sameLabel = (!l.label && !at.label) || Protect.sameLabel(l.label, at.label);
    return l.bundleId === at.bundleId && l.windowTitle === at.windowTitle && l.ref === at.ref && l.cls === at.cls && sameLabel && l.expires > this.now();
  }
}

export const desktopUnlockGate = new DesktopUnlockGate();

// ---------------------------------------------------------------- typing

export const CARD_TEXT = "Not typed: that looks like a card number. Orbi never types card details; the user types them.";
export const SECURE_TEXT = "Not typed: that is a password or other secure field. Orbi never types or reads passwords; the user types them.";
export const PAYMENT_TEXT = "Not typed: that is a card or payment field. Orbi never types card details; the user types them.";

export function typeRefusal(text: string, el: AXElement | null): string | null {
  if (Mask.maskCardRuns(String(text)) !== String(text)) return CARD_TEXT;
  if (isSecure(el)) return SECURE_TEXT;
  if (el && paymentField(el)) return PAYMENT_TEXT;
  return null;
}
