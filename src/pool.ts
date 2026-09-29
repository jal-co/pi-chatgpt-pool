export type Account = { id: string; label: string };

const USAGE_LIMIT = /usage.?limit|subscription_sharing_usage_limit_exceeded|insufficient_quota|quota/i;
const RATE_LIMIT = /rate.?limit|too many requests|\b429\b/i;

export const USAGE_COOLDOWN_MS = 60 * 60 * 1000;
export const RATE_COOLDOWN_MS = 60 * 1000;

export function limitCooldown(errorMessage: string | undefined): number | undefined {
	if (!errorMessage) return undefined;
	if (USAGE_LIMIT.test(errorMessage)) return USAGE_COOLDOWN_MS;
	if (RATE_LIMIT.test(errorMessage)) return RATE_COOLDOWN_MS;
	return undefined;
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
