import { test } from "node:test";
import assert from "node:assert/strict";

import { Speaker, DUCK_LEVEL, DUCK_SECONDS, UNDUCK_SECONDS } from "../../lib/voice/tts.js";

function fakeCtx() {
  const gains = [];
  const ctx = {
    currentTime: 10,
    destination: {},
    createGain() {
      const g = {
        connected: false,
        ramps: [],
        gain: {
          value: 1,
          cancelScheduledValues() {},
          setValueAtTime(v) { this.value = v; },
          linearRampToValueAtTime(v, t) { g.ramps.push([v, t]); },
        },
        connect() { g.connected = true; },
        disconnect() { g.connected = false; },
      };
      gains.push(g);
      return g;
    },
  };
  return { ctx, gains };
}

test("duck fades our speech to near silence in 20 ms; unduck restores it over 80 ms", () => {
  const { ctx, gains } = fakeCtx();
  const sp = new Speaker({ ctx, getToken: async () => "t", getSpeed: () => 1, voiceId: "v", log: () => {} });
  sp.duck();
  assert.deepEqual(gains[0].ramps.at(-1), [DUCK_LEVEL, 10 + DUCK_SECONDS]);
  assert.ok(DUCK_SECONDS <= 0.03);
  sp.unduck();
  assert.deepEqual(gains[0].ramps.at(-1), [1, 10 + UNDUCK_SECONDS]);
});

test("stop mutes and drops the output node, so already-scheduled audio is silent", () => {
  const { ctx, gains } = fakeCtx();
  const sp = new Speaker({ ctx, getToken: async () => "t", getSpeed: () => 1, voiceId: "v", log: () => {} });
  const stopped = [];
  sp.sources.add({ stop() { stopped.push(1); } });
  sp.duck();
  sp.stop();
  assert.equal(stopped.length, 1);
  assert.equal(gains[0].gain.value, 0);
  assert.equal(gains[0].connected, false);
  assert.equal(gains.length, 2);
  assert.equal(sp.out, gains[1]);
  assert.equal(gains[1].connected, true);
  assert.equal(gains[1].gain.value, 1, "the next reply plays at full level");
  assert.equal(sp.sources.size, 0);
});
