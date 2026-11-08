import assert from "node:assert/strict";
import { test } from "node:test";
import { parseRequestPlan } from "./request.ts";

const emptyAction = {
  name: null,
  channelType: null,
  category: null,
  position: null,
  channel: null,
  memberId: null,
  role: null,
  content: null,
};

function serializedPlan(actions: Record<string, unknown>[], status = "ready"): string {
  return JSON.stringify({ status, summary: "Requested changes", actions });
}

test("parses a multi-step plan and preserves message content", () => {
  const plan = parseRequestPlan(serializedPlan([
    { ...emptyAction, kind: "channel_create", name: "guide", channelType: "text", position: 0 },
    { ...emptyAction, kind: "message_send", channel: "guide", content: "  Translator Bot guide  " },
  ]));

  assert.deepEqual(plan.actions, [
    { kind: "channel_create", name: "guide", channelType: "text", category: null, position: 0 },
    { kind: "message_send", channel: "guide", content: "  Translator Bot guide  " },
  ]);
});

test("requires empty action lists for clarification and unsupported plans", () => {
  assert.equal(parseRequestPlan(serializedPlan([], "clarification")).status, "clarification");
  assert.throws(() => parseRequestPlan(serializedPlan([
    { ...emptyAction, kind: "channel_move", channel: "guide", position: 0 },
  ], "unsupported")), /inconsistent action plan/);
});

test("rejects unknown, malformed, and unsafe actions before execution", () => {
  assert.throws(() => parseRequestPlan(serializedPlan([
    { ...emptyAction, kind: "channel_delete", channel: "guide" },
  ])), /Unsupported action/);
  assert.throws(() => parseRequestPlan(serializedPlan([
    { ...emptyAction, kind: "role_assign", role: "Admin", memberId: "not-a-discord-id" },
  ])), /Invalid member ID/);
  assert.throws(() => parseRequestPlan(serializedPlan([
    { ...emptyAction, kind: "channel_move", channel: "guide", position: -1 },
  ])), /Invalid channel position/);
  assert.throws(() => parseRequestPlan(serializedPlan([
    { ...emptyAction, kind: "message_send", channel: "guide", content: "Hi", role: "@everyone" },
  ])), /Unexpected role/);
  assert.throws(() => parseRequestPlan(JSON.stringify({
    status: "ready",
    summary: "Requested changes",
    actions: [{ ...emptyAction, kind: "message_send", channel: "guide", content: "Hi", delete_all: true }],
  })), /Malformed action/);
});

test("rejects plans with too many actions or inconsistent fields", () => {
  const move = { ...emptyAction, kind: "channel_move", channel: "guide", position: 0 };
  assert.equal(parseRequestPlan(serializedPlan(Array.from({ length: 8 }, () => move))).actions.length, 8);
  assert.throws(() => parseRequestPlan(serializedPlan(Array.from({ length: 9 }, () => move))), /invalid action plan/);
  assert.throws(() => parseRequestPlan(serializedPlan([
    { ...emptyAction, kind: "channel_create", name: "nested", channelType: "category", category: "Public" },
  ])), /cannot be created inside another category/);
});

test("enforces size and position limits independently of the model schema", () => {
  const message = { ...emptyAction, kind: "message_send", channel: "guide", content: "x".repeat(2000) };
  assert.equal(parseRequestPlan(serializedPlan([message])).actions.length, 1);
  assert.throws(() => parseRequestPlan(serializedPlan([
    { ...message, content: "x".repeat(2001) },
  ])), /Invalid message content/);
  assert.throws(() => parseRequestPlan(serializedPlan([
    { ...message, channel: "x".repeat(101) },
  ])), /Invalid channel/);
  assert.throws(() => parseRequestPlan(serializedPlan([
    { ...emptyAction, kind: "channel_move", channel: "guide", position: 501 },
  ])), /Invalid channel position/);
  assert.throws(() => parseRequestPlan(JSON.stringify({
    status: "ready", summary: "x".repeat(501), actions: [message],
  })), /invalid action plan/);
});
