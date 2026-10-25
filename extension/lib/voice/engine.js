// Which voice Orbi uses. Cartesia (Sonic and Ink 2) when the agent server
// has a Cartesia key; basic voice when it says it has none: Chrome's own
// voice (chrome.tts) for replies and Chrome's speech recognition for the
// user, or typing in the popup and on the new tab page where recognition
// can't run. Unknown (the server not reached yet, or one from before basic
// voice) keeps Cartesia, as before, and so does voice off on the server
// (CLEARCART_VOICE=false: text only, nothing spoken or heard).
export function chooseVoice({ cartesia = null, voice = null, recognition = false } = {}) {
  if (cartesia !== false || voice === false) return { mode: "cartesia", tts: "sonic", stt: "ink" };
  return { mode: "basic", tts: "chrome", stt: recognition ? "webspeech" : "typed" };
}
