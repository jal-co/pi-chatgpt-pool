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

function accountIdFromToken(token: string): string | undefined {
	const payload = token.split(".")[1];
	if (!payload) return undefined;
	try {
		return JSON.parse(Buffer.from(payload, "base64url").toString("utf8"))["https://api.openai.com/auth"]
			?.chatgpt_account_id;
	} catch {
		return undefined;
	}
}

async function backend<T>(token: string, path: string, init: RequestInit = {}): Promise<T> {
	const headers = new Headers({ authorization: `Bearer ${token}`, "content-type": "application/json" });
	const accountId = accountIdFromToken(token);
	if (accountId) headers.set("chatgpt-account-id", accountId);
	const response = await fetch(`${BACKEND}/${path}`, { ...init, headers, signal: AbortSignal.timeout(15_000) });
	if (!response.ok) {
		const body = await response.text().catch(() => "");
		throw new Error(`ChatGPT ${path} failed (${response.status})${body ? `: ${body.slice(0, 200)}` : ""}`);
	}
	return response.json();
}

function toWindow(window: Window | null | undefined): UsageWindow[] {
	if (!window) return [];
	return [{ usedPercent: window.used_percent, windowSeconds: window.limit_window_seconds, resetsAt: window.reset_at * 1000 }];
}

export async function fetchUsage(token: string): Promise<Usage> {
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
