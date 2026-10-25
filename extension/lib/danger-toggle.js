// The Danger mode switch, shared by the popup and the options page. Turning
// it on takes two presses: checking the box only shows a confirm button,
// and the setting is saved on only when that button is pressed. Turning it
// off saves at once. Never uses alert() or confirm().
//
// els: { box, confirm, yes, no, chip? } where box is the checkbox, confirm
// the hidden element holding the yes and no buttons, and chip an optional
// header indicator shown while it is on. save(patch) resolves to the saved
// settings (lib/settings.js saveSettings). localNote, optional, is shown
// while Danger mode is on and the agent runs on a local model, which keeps
// every lock (the worker and the agent server both ignore Danger mode then).
export const DANGER_LOCAL_NOTE = "Danger mode is off while using a local model. Locks and the spoken yes stay on.";
export function bindDangerToggle(els, save) {
  const { box, confirm, yes, no, chip, localNote } = els;
  let provider = "claude";
  const show = (on) => {
    box.checked = on === true;
    confirm.hidden = true;
    if (chip) chip.hidden = on !== true;
    if (localNote) {
      localNote.textContent = DANGER_LOCAL_NOTE;
      localNote.hidden = !(on === true && provider === "local");
    }
  };
  box.addEventListener("change", async () => {
    if (box.checked) {
      // First press: ask, do not save.
      box.checked = false;
      confirm.hidden = false;
      yes.focus();
      return;
    }
    show((await save({ dangerMode: false })).dangerMode);
  });
  yes.addEventListener("click", async () => {
    show((await save({ dangerMode: true })).dangerMode);
    box.focus();
  });
  no.addEventListener("click", () => {
    confirm.hidden = true;
    box.focus();
  });
  return {
    fill: (settings) => {
      provider = settings.provider;
      show(settings.dangerMode);
    },
  };
}
