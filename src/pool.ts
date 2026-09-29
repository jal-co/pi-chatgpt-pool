export type Account = { id: string; label: string; name?: string; resetsAt?: number };

export function loginName(account: Account): string {
	return account.name || `ChatGPT (${account.label})`;
}

const USAGE_LIMIT = /usage.?limit|subscription_sharing_usage_limit_exceeded|insufficient_quota|quota/i;
const RATE_LIMIT = /rate.?limit|too many requests|\b429\b/i;

export function failoverMessage(label: string): string {
	return `ChatGPT account "${label}" hit its rate limit; switching to another account in the pool.`;
}

export const USAGE_COOLDOWN_MS = 60 * 60 * 1000;
export const RATE_COOLDOWN_MS = 60 * 1000;

export function limitCooldown(errorMessage: string | undefined): number | undefined {
	if (!errorMessage) return undefined;
	if (USAGE_LIMIT.test(errorMessage)) return USAGE_COOLDOWN_MS;
	if (RATE_LIMIT.test(errorMessage)) return RATE_COOLDOWN_MS;
	return undefined;
}

const DURATION_PART = /(\d+(?:\.\d+)?)(ms|h|m|s)/g;
const DURATION_MS = new Map([
	["h", 3_600_000],
	["m", 60_000],
	["s", 1000],
	["ms", 1],
]);

function parseDurationMs(value: string): number | undefined {
	if (/^\d+(\.\d+)?$/.test(value)) return Number(value) * 1000;
	let total = 0;
	let matched = "";
	for (const [part, amount, unit] of value.matchAll(DURATION_PART)) {
		total += Number(amount) * (DURATION_MS.get(unit) ?? 0);
		matched += part;
	}
	return matched === value ? total : undefined;
}

function secondsOrMs(value: number): number {
	return value < 1e12 ? value * 1000 : value;
}

export function parseResetAt(headers: Headers, body: string, now: number): number | undefined {
	const candidates: number[] = [];
	const addIn = (ms: number | undefined) => {
		if (ms !== undefined && Number.isFinite(ms) && ms > 0) candidates.push(now + ms);
	};
	const addAt = (at: number) => {
		if (Number.isFinite(at) && at > now) candidates.push(at);
	};

	const retryAfterMs = headers.get("retry-after-ms");
	if (retryAfterMs) addIn(Number(retryAfterMs));

	const retryAfter = headers.get("retry-after")?.trim();
	if (retryAfter) {
		if (/^\d+(\.\d+)?$/.test(retryAfter)) addIn(Number(retryAfter) * 1000);
		else addAt(Date.parse(retryAfter));
	}

	for (const [name, value] of headers) {
		if (name.startsWith("x-ratelimit-reset") || /^x-codex-.*reset-after-seconds$/.test(name)) {
			addIn(parseDurationMs(value.trim()));
		} else if (/^x-codex-.*reset-at$/.test(name)) {
			addAt(secondsOrMs(Number(value)));
		}
	}

	const match = body.match(/"resets_at"\s*:\s*(\d+(?:\.\d+)?)/);
	if (match) addAt(secondsOrMs(Number(match[1])));
	const inSeconds = body.match(/"resets_in_seconds"\s*:\s*(\d+(?:\.\d+)?)/);
	if (inSeconds) addIn(Number(inSeconds[1]) * 1000);

	return candidates.length > 0 ? Math.max(...candidates) : undefined;
}

export function pickAccount(
	accounts: readonly Account[],
	isUsable: (id: string) => boolean,
	sticky: string | undefined,
): Account | undefined {
	const usable = accounts.filter((account) => isUsable(account.id));
	return usable.find((account) => account.id === sticky) ?? usable[0];
}

export function nextAccountId(accounts: readonly Account[]): string {
	const highest = Math.max(0, ...accounts.map((account) => Number(account.id.split("-").pop()) || 0));
	return `chatgpt-${highest + 1}`;
}

export const STRATEGIES = {
	"fill-first": "Fill first: use accounts in order, save the later ones for when the first runs out",
	"round-robin": "Round robin: start each new conversation on the next account",
	"least-used": "Least used: start new conversations on the account with the lowest usage",
	"use-it-or-lose-it": "Use it or lose it: prefer the account whose usage window resets soonest",
};
export type Strategy = keyof typeof STRATEGIES;
export type UsageSnapshot = { usedPercent: number; resetsAt: number };

export function isStrategy(value: string): value is Strategy {
	return Object.hasOwn(STRATEGIES, value);
}

export function orderAccounts(
	accounts: readonly Account[],
	strategy: Strategy,
	usage: ReadonlyMap<string, UsageSnapshot>,
	rotation: number,
): Account[] {
	if (strategy === "fill-first" || accounts.length === 0) return [...accounts];
	if (strategy === "round-robin") {
		const start = rotation % accounts.length;
		return [...accounts.slice(start), ...accounts.slice(0, start)];
	}
	const known = accounts.filter((account) => usage.has(account.id) && (usage.get(account.id)?.usedPercent ?? 100) < 100);
	const rest = accounts.filter((account) => !known.includes(account));
	const key = (account: Account) => {
		const snapshot = usage.get(account.id);
		return strategy === "least-used" ? (snapshot?.usedPercent ?? 100) : (snapshot?.resetsAt ?? Number.POSITIVE_INFINITY);
	};
	return [...known.sort((a, b) => key(a) - key(b)), ...rest];
}
