import assert from "node:assert/strict";
import { test } from "node:test";
import { formatIn, formatWindow, usageBar } from "../src/format.ts";

test("countdowns use the two largest units", () => {
	assert.equal(formatIn(30_000), "1m");
	assert.equal(formatIn(45 * 60_000), "45m");
	assert.equal(formatIn(2 * 3_600_000), "2h");
	assert.equal(formatIn(2 * 3_600_000 + 5 * 60_000), "2h 5m");
	assert.equal(formatIn(3 * 86_400_000 + 4 * 3_600_000), "3d 4h");
	assert.equal(formatIn(-5), "1m");
});

test("window names", () => {
	assert.equal(formatWindow(604800), "weekly");
	assert.equal(formatWindow(86400), "daily");
	assert.equal(formatWindow(18000), "5h");
	assert.equal(formatWindow(900), "15m");
});

test("usage bars fill proportionally and stay in bounds", () => {
	assert.deepEqual(usageBar(50, 10), { filled: "█████", empty: "░░░░░" });
	assert.equal(usageBar(150, 8).filled.length, 8);
	assert.equal(usageBar(-3, 8).empty.length, 8);
});
