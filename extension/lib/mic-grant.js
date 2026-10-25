// The one-time microphone grant, shared by the options page and the setup
// page. getUserMedia runs on an extension page, so the offscreen document
// (same origin) inherits the permission; the offscreen document can't ask.

export async function micPermission(permissions = globalThis.navigator?.permissions) {
  try {
    return (await permissions.query({ name: "microphone" })).state;
  } catch {
    return "unknown";
  }
}

export function micStateMessage(state) {
  if (state === "granted") return "Microphone allowed.";
  if (state === "denied") return "Microphone blocked. Allow it in Chrome's site settings for this extension, then try again.";
  return "Microphone not granted yet.";
}

// Opens the mic once (Chrome shows its prompt) and stops it straight away.
export async function grantMic(mediaDevices = globalThis.navigator?.mediaDevices) {
  try {
    const stream = await mediaDevices.getUserMedia({ audio: true });
    for (const t of stream.getTracks()) t.stop();
    return { ok: true, message: "Microphone allowed. You can hold the talk key on any page." };
  } catch (err) {
    return {
      ok: false,
      message: err && err.name === "NotAllowedError"
        ? micStateMessage("denied")
        : `Could not open the microphone: ${err && err.message}`,
    };
  }
}
