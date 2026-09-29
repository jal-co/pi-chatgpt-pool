import { randomUUID } from "node:crypto";

const BACKEND = "https://chatgpt.com/backend-api/wham";

type Window = { used_percent: number; limit_window_seconds: number; reset_at: number };
type UsageResponse = {
	rate_limit?: { limit_reached?: boolean; primary_window?: Window | null; secondary_window?: Window | null } | null;
	rate_limit_reset_credits?: { available_count?: number; applicable_available_count?: number } | null;
};
type CreditsResponse = {
	credits: { id: string; status: string; title?: string | null; expires_at?: string | null }[];
};
type ConsumeResponse = { code: "reset" | "nothing_to_reset" | "no_credit" | "already_redeemed" };

export type UsageWindow = { usedPercent: number; windowSeconds: number; resetsAt: number };
export type Usage = {
	limitReached: boolean;
	windows: UsageWindow[];
	banked: number;
	usableNow: number;
	credits: { id: string; title: string; expiresAt?: number }[];
};
export type SpendOutcome = ConsumeResponse["code"];

type TokenClaims = { scope?: string; "https://api.openai.com/auth"?: { chatgpt_account_id?: string } };

function tokenClaims(token: string): TokenClaims | undefined {
	const payload = token.split(".")[1];
	if (!payload) return undefined;
	try {
		return JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
	} catch {
		return undefined;
	}
}

function supportsUsage(token: string): boolean {
	const claims = tokenClaims(token);
	return !(typeof claims?.scope === "string" && claims.scope.split(/\s+/).includes("chatgpt.tokens.use.direct"));
}

async function backend<T>(token: string, path: string, init: RequestInit = {}): Promise<T> {
	if (!supportsUsage(token)) throw new Error("Banked resets are unavailable for ChatGPT subscription-sharing sign-ins.");
	const headers = new Headers({ authorization: `Bearer ${token}`, "content-type": "application/json" });
	const accountId = tokenClaims(token)?.["https://api.openai.com/auth"]?.chatgpt_account_id;
	if (accountId) headers.set("chatgpt-account-id", accountId);
	const response = await fetch(`${BACKEND}/${path}`, { ...init, headers, signal: AbortSignal.timeout(15_000) });
	if (!response.ok) {
		throw new Error(`ChatGPT ${path} failed (${response.status}).`);
	}
	return response.json();
}

function toWindow(window: Window | null | undefined): UsageWindow[] {
	if (!window) return [];
	return [{ usedPercent: window.used_percent, windowSeconds: window.limit_window_seconds, resetsAt: window.reset_at * 1000 }];
}

export async function fetchUsage(token: string): Promise<Usage | undefined> {
	if (!supportsUsage(token)) return undefined;
	const [usage, credits] = await Promise.all([
		backend<UsageResponse>(token, "usage"),
		backend<CreditsResponse>(token, "rate-limit-reset-credits"),
	]);
	const limit = usage.rate_limit;
	return {
		limitReached: limit?.limit_reached === true,
		windows: [...toWindow(limit?.primary_window), ...toWindow(limit?.secondary_window)],
		banked: usage.rate_limit_reset_credits?.available_count ?? 0,
		usableNow: usage.rate_limit_reset_credits?.applicable_available_count ?? 0,
		credits: credits.credits
			.filter((credit) => credit.status === "available")
			.map((credit) => ({
				id: credit.id,
				title: credit.title || "Reset",
				expiresAt: credit.expires_at ? Date.parse(credit.expires_at) : undefined,
			})),
	};
}

export async function spendReset(token: string, creditId: string): Promise<SpendOutcome> {
	const response = await backend<ConsumeResponse>(token, "rate-limit-reset-credits/consume", {
		method: "POST",
		body: JSON.stringify({ redeem_request_id: randomUUID(), credit_id: creditId }),
	});
	return response.code;
}
