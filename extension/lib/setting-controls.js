// The talk key and Claude model menus and the speed slider, filled the same
// way on the popup and the options page.
import { CLAUDE_MODELS, HOTKEYS, SPEED_MAX, SPEED_MIN, claudeModelLabel } from "./settings.js";
import { keyName } from "./setup.js";

export function fillSettingControls({ hotkey, model, speed }) {
  for (const value of Object.keys(HOTKEYS)) hotkey.append(new Option(keyName(value), value));
  for (const id of Object.keys(CLAUDE_MODELS)) model.append(new Option(claudeModelLabel(id), id));
  speed.min = String(SPEED_MIN);
  speed.max = String(SPEED_MAX);
}

export const speedLabel = (value) => `${Number(value).toFixed(1)}x`;
