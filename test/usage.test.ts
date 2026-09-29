import assert from "node:assert/strict";
import { test } from "node:test";
import { fetchUsage, spendReset } from "../src/usage.ts";

const token = (scope: string) => `header.${Buffer.from(JSON.stringify({ scope })).toString("base64url")}.signature`;

test("subscription-sharing usage is hidden without network requests or reset spending", async (t) => {
	const network = t.mock.method(globalThis, "fetch", async () => {
		throw new Error("Unexpected network request");
	});
	assert.equal(await fetchUsage(token("openid chatgpt.tokens.use.direct")), undefined);
	await assert.rejects(spendReset(token("chatgpt.tokens.use.direct"), "credit"), {
		message: "Banked resets are unavailable for ChatGPT subscription-sharing sign-ins.",
	});
	assert.equal(network.mock.callCount(), 0);
});

test("usage errors never render raw response bodies", async (t) => {
	t.mock.method(globalThis, "fetch", async () => new Response('secret\nUnauthorized', { status: 401 }));
	await assert.rejects(fetchUsage(token("openid")), { message: "ChatGPT usage failed (401)." });
});
