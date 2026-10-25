import { test } from "node:test";
import assert from "node:assert/strict";
import { isExplicitYes } from "../session.ts";

test("plain affirmatives are a yes", () => {
  for (const t of ["yes", "Yes.", "yeah", "yep!", "yes please", "Okay, yes.", "confirm", "go ahead", "pay now",
    "yes, place the order", "do it", "yes yes", "Yes, thank you.", "sure, go ahead"]) {
    assert.equal(isExplicitYes(t), true, t);
  }
});

test("hedged, conditional or unrelated answers are not a yes", () => {
  for (const t of ["no", "no, wait", "yes but wait", "yes, but two of them", "do it later", "pay attention, what's that?",
    "confirm the total first", "sure", "okay", "maybe", "yes if it's under ten dollars", "don't pay", "yes no", ""]) {
    assert.equal(isExplicitYes(t), false, t);
  }
});
