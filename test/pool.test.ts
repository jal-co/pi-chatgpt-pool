import assert from "node:assert/strict";
import { test } from "node:test";
import { limitCooldown, nextAccountId, pickAccount, RATE_COOLDOWN_MS, USAGE_COOLDOWN_MS } from "../src/pool.ts";

const accounts = [
	{ id: "chatgpt-1", label: "personal" },
	{ id: "chatgpt-2", label: "work" },
	{ id: "chatgpt-5", label: "spare" },
];

test("usage limits cool down longer than rate limits", () => {
	assert.equal(limitCooldown("subscription_sharing_usage_limit_exceeded: try later"), USAGE_COOLDOWN_MS);
	assert.equal(limitCooldown("429 Too Many Requests"), RATE_COOLDOWN_MS);
	assert.equal(limitCooldown("Rate limit reached for requests"), RATE_COOLDOWN_MS);
	assert.equal(limitCooldown("500 internal error"), undefined);
	assert.equal(limitCooldown(undefined), undefined);
});

test("keeps the sticky account while it is usable", () => {
	assert.equal(pickAccount(accounts, () => true, "chatgpt-2")?.id, "chatgpt-2");
});

test("fails over to the first usable account", () => {
	assert.equal(pickAccount(accounts, (id) => id !== "chatgpt-1", "chatgpt-1")?.id, "chatgpt-2");
	assert.equal(pickAccount(accounts, (id) => id === "chatgpt-5", undefined)?.id, "chatgpt-5");
	assert.equal(pickAccount(accounts, () => false, "chatgpt-1"), undefined);
});

test("new account ids never reuse a removed slot", () => {
	assert.equal(nextAccountId(accounts), "chatgpt-6");
	assert.equal(nextAccountId([]), "chatgpt-1");
});
