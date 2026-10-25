// "Type to Orbi": the box in the popup and on the new tab page for basic
// voice (no Cartesia key), where Chrome's speech recognition may not work.
// The words go to the worker (TYPED_TEXT), which sends them on as one turn,
// like a spoken one (lib/voice/relay.js, controller.typed).
import { RT } from "./protocol.js";

export const BASIC_VOICE_NOTE = "Basic voice (no Cartesia key)";

// form holds an <input> and a submit button. Returns { show(on) }.
export function mountTypeBox(form, { chromeApi = globalThis.chrome } = {}) {
  const input = form.querySelector("input");
  form.addEventListener("submit", (e) => {
    e.preventDefault();
    const text = input.value.replace(/\s+/g, " ").trim();
    if (!text) return;
    try { chromeApi.runtime.sendMessage({ type: RT.TYPED_TEXT, text })?.catch?.(() => {}); } catch {}
    input.value = "";
  });
  return { show: (on) => { form.hidden = !on; } };
}
