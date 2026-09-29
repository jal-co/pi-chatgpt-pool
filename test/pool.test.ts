import assert from "node:assert/strict";
import { test } from "node:test";
import {
	limitCooldown,
	nextAccountId,
	orderAccounts,
	parseResetAt,
	pickAccount,
	RATE_COOLDOWN_MS,
	USAGE_COOLDOWN_MS,
} from "../src/pool.ts";

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

const now = Date.parse("2026-09-29T12:00:00Z");

test("reads resets_at from the error body", () => {
	const resetsAt = Math.floor(now / 1000) + 3 * 3600;
	const body = JSON.stringify({ error: { code: "subscription_sharing_usage_limit_exceeded", resets_at: resetsAt } });
	assert.equal(parseResetAt(new Headers(), body, now), resetsAt * 1000);
	assert.equal(parseResetAt(new Headers(), '{"error":{"resets_in_seconds":90}}', now), now + 90_000);
});

test("reads retry-after as seconds or an HTTP date", () => {
	assert.equal(parseResetAt(new Headers({ "retry-after": "30" }), "", now), now + 30_000);
	assert.equal(
		parseResetAt(new Headers({ "retry-after": "Tue, 29 Sep 2026 14:00:00 GMT" }), "", now),
		Date.parse("2026-09-29T14:00:00Z"),
	);
	assert.equal(parseResetAt(new Headers({ "retry-after-ms": "1500" }), "", now), now + 1500);
});

test("reads OpenAI and Codex rate-limit reset headers", () => {
	assert.equal(parseResetAt(new Headers({ "x-ratelimit-reset-requests": "6m0s" }), "", now), now + 360_000);
	assert.equal(parseResetAt(new Headers({ "x-ratelimit-reset-tokens": "1h2m3.5s" }), "", now), now + 3_723_500);
	assert.equal(parseResetAt(new Headers({ "x-codex-primary-reset-after-seconds": "600" }), "", now), now + 600_000);
	assert.equal(parseResetAt(new Headers({ "x-codex-secondary-reset-at": String(now / 1000 + 86400) }), "", now), now + 86_400_000);
});

test("uses the latest reset when several are reported", () => {
	const headers = new Headers({ "retry-after": "60", "x-codex-secondary-reset-after-seconds": "7200" });
	assert.equal(parseResetAt(headers, "", now), now + 7_200_000);
});

test("ignores missing, past, and malformed resets", () => {
	assert.equal(parseResetAt(new Headers(), "not json", now), undefined);
	assert.equal(parseResetAt(new Headers({ "retry-after": "Mon, 28 Sep 2026 00:00:00 GMT" }), "", now), undefined);
	assert.equal(parseResetAt(new Headers({ "x-ratelimit-reset-requests": "soon" }), "", now), undefined);
});

const three = [
	{ id: "a", label: "a" },
	{ id: "b", label: "b" },
	{ id: "c", label: "c" },
];
const ids = (list: { id: string }[]) => list.map((account) => account.id).join("");

test("fill first keeps the order accounts were added", () => {
	assert.equal(ids(orderAccounts(three, "fill-first", new Map(), 5)), "abc");
});

test("round robin rotates the starting account", () => {
	assert.equal(ids(orderAccounts(three, "round-robin", new Map(), 0)), "abc");
	assert.equal(ids(orderAccounts(three, "round-robin", new Map(), 1)), "bca");
	assert.equal(ids(orderAccounts(three, "round-robin", new Map(), 5)), "cab");
});

test("least used prefers the lowest usage, unknown and exhausted accounts last", () => {
	const usage = new Map([
		["a", { usedPercent: 80, resetsAt: 3 }],
		["b", { usedPercent: 100, resetsAt: 1 }],
		["c", { usedPercent: 10, resetsAt: 2 }],
	]);
	assert.equal(ids(orderAccounts(three, "least-used", usage, 0)), "cab");
	assert.equal(ids(orderAccounts(three, "least-used", new Map([["b", { usedPercent: 5, resetsAt: 1 }]]), 0)), "bac");
});

test("use it or lose it prefers the window that resets soonest", () => {
	const usage = new Map([
		["a", { usedPercent: 20, resetsAt: 300 }],
		["b", { usedPercent: 90, resetsAt: 100 }],
		["c", { usedPercent: 100, resetsAt: 50 }],
	]);
	assert.equal(ids(orderAccounts(three, "use-it-or-lose-it", usage, 0)), "bac");
});
