import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { getSupportedThinkingLevels, type Api, type Model, type Provider } from "@earendil-works/pi-ai";
import { builtinProviders } from "@earendil-works/pi-ai/providers/all";
import { type ExtensionAPI, type ExtensionContext, getAgentDir } from "@earendil-works/pi-coding-agent";
import { chatgptOAuth } from "./chatgpt-oauth.ts";
import { type Account, limitCooldown, nextAccountId, parseResetAt, pickAccount } from "./pool.ts";
import { fetchUsage, spendReset, type Usage } from "./usage.ts";

const POOL_PROVIDER = "chatgpt";
const CHATGPT_COMPAT = {
	supportsLongCacheRetention: false,
	supportsExplicitPromptCacheMode: false,
	supportsMaxOutputTokens: false,
};

function configPath(): string {
	return join(getAgentDir(), "chatgpt-pool.json");
}

function loadAccounts(): Account[] {
	if (!existsSync(configPath())) return [];
	return JSON.parse(readFileSync(configPath(), "utf8")).accounts ?? [];
}

function saveAccounts(accounts: readonly Account[]): void {
	mkdirSync(dirname(configPath()), { recursive: true });
	writeFileSync(configPath(), `${JSON.stringify({ accounts }, null, 2)}\n`);
}

type ResetListener = (accountId: string, resetsAt: number) => void;

function limitAwareFetch(accountId: string, onReset: ResetListener, base: typeof fetch = fetch): typeof fetch {
	return async (input, init) => {
		const response = await base(input, init);
		if (response.status === 429) {
			const resetsAt = parseResetAt(response.headers, await response.clone().text(), Date.now());
			if (resetsAt !== undefined) onReset(accountId, resetsAt);
		}
		return response;
	};
}

function accountProvider(openai: Provider, account: Account, onReset: ResetListener): Provider {
	const name = `ChatGPT (${account.label})`;
	const models: Model<Api>[] = openai
		.getModels()
		.map((model) => ({ ...model, provider: account.id, compat: { ...model.compat, ...CHATGPT_COMPAT } }));
	return {
		id: account.id,
		name,
		baseUrl: openai.baseUrl,
		auth: { oauth: chatgptOAuth(name) },
		getModels: () => models,
		stream: (model, context, options) => openai.stream(model, context, options),
		streamSimple: (model, context, options) =>
			openai.streamSimple(model, context, { ...options, fetch: limitAwareFetch(account.id, onReset, options?.fetch) }),
	};
}

function formatWindow(seconds: number): string {
	if (seconds % 604800 === 0) return seconds === 604800 ? "weekly" : `${seconds / 604800}-week`;
	if (seconds % 3600 === 0) return `${seconds / 3600}h`;
	return `${Math.round(seconds / 60)}m`;
}

function formatReset(at: number): string {
	const date = new Date(at);
	const time = date.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
	return date.toDateString() === new Date().toDateString()
		? `at ${time}`
		: `${date.toLocaleDateString([], { weekday: "short", month: "short", day: "numeric" })} at ${time}`;
}

export default function chatgptPool(pi: ExtensionAPI) {
	const openai = builtinProviders().find((provider) => provider.id === "openai");
	if (!openai) throw new Error("pi-chatgpt-pool needs pi's built-in openai provider");

	let accounts = loadAccounts();
	const reportedResets = new Map<string, number>();
	const onReset: ResetListener = (accountId, resetsAt) => reportedResets.set(accountId, resetsAt);

	const setResetsAt = (accountId: string, resetsAt: number | undefined) => {
		accounts = accounts.map((account) => (account.id === accountId ? { ...account, resetsAt } : account));
		saveAccounts(accounts);
	};

	const isUsable = (ctx: ExtensionContext, accountId: string, modelId: string) => {
		const account = accounts.find((candidate) => candidate.id === accountId);
		const model = ctx.modelRegistry.find(accountId, modelId);
		return (account?.resetsAt ?? 0) <= Date.now() && !!model && ctx.modelRegistry.hasConfiguredAuth(model);
	};

	for (const account of accounts) pi.registerProvider(accountProvider(openai, account, onReset));

	for (const model of openai.getModels()) {
		pi.registerVirtualModel({
			provider: POOL_PROVIDER,
			id: model.id,
			name: `${model.name} (ChatGPT pool)`,
			thinkingLevels: getSupportedThinkingLevels(model),
			contextWindow: model.contextWindow,
			maxTokens: model.maxTokens,
			input: model.input,
			route(request, ctx) {
				const sticky = (request.failed ?? request.previous)?.model.provider;
				const account = pickAccount(accounts, (id) => isUsable(ctx, id, model.id), sticky);
				const routed = account && ctx.modelRegistry.find(account.id, model.id);
				if (!routed) {
					throw new Error(
						accounts.length === 0
							? "No ChatGPT accounts in the pool. Run /chatgpt-pool add <label>, then /login."
							: "Every ChatGPT account in the pool is signed out or limited. Run /chatgpt-pool to see reset times and banked resets.",
					);
				}
				return { model: routed, thinkingLevel: request.thinkingLevel };
			},
		});
	}

	pi.on("message_end", (event, ctx) => {
		const message = event.message;
		if (message.role !== "assistant" || message.stopReason !== "error") return;
		const account = accounts.find((candidate) => candidate.id === message.provider);
		const reported = account && reportedResets.get(account.id);
		if (account) reportedResets.delete(account.id);
		const cooldown = limitCooldown(message.errorMessage);
		if (!account || (cooldown === undefined && reported === undefined)) return;
		setResetsAt(account.id, reported ?? Date.now() + (cooldown ?? 0));
		if (ctx.model?.provider !== POOL_PROVIDER) return;
		if (!pickAccount(accounts, (id) => isUsable(ctx, id, message.model), undefined)) return;
		return {
			message: {
				...message,
				errorMessage: `ChatGPT account "${account.label}" is rate limited; switching to another account in the pool.`,
			},
		};
	});

	pi.registerCommand("chatgpt-pool", {
		description: "Show usage and banked resets, or add <label> / remove <label> / spend <label> / reset",
		async handler(args, ctx) {
			const [action, ...rest] = args.trim().split(/\s+/);
			const label = rest.join(" ");

			if (action === "add") {
				if (!label) return ctx.ui.notify("Usage: /chatgpt-pool add <label>", "warning");
				const account = { id: nextAccountId(accounts), label };
				accounts = [...accounts, account];
				saveAccounts(accounts);
				pi.registerProvider(accountProvider(openai, account, onReset));
				return ctx.ui.notify(`Added ChatGPT (${label}). Run /login and choose it to sign in.`, "info");
			}

			if (action === "remove") {
				const account = accounts.find((candidate) => candidate.label === label || candidate.id === label);
				if (!account) return ctx.ui.notify(`No pooled account named "${label}"`, "warning");
				accounts = accounts.filter((candidate) => candidate !== account);
				saveAccounts(accounts);
				pi.unregisterProvider(account.id);
				return ctx.ui.notify(
					`Removed ChatGPT (${account.label}). Its token stays in auth.json under ${account.id} until you remove it.`,
					"info",
				);
			}

			if (action === "reset") {
				accounts = accounts.map(({ id, label }) => ({ id, label }));
				saveAccounts(accounts);
				return ctx.ui.notify("Cleared ChatGPT pool limits. Every signed-in account is ready again.", "info");
			}

			if (action === "spend") {
				const account = accounts.find((candidate) => candidate.label === label || candidate.id === label);
				if (!account) return ctx.ui.notify("Usage: /chatgpt-pool spend <label>", "warning");
				const token = await ctx.modelRegistry.getApiKeyForProvider(account.id);
				if (!token) return ctx.ui.notify(`ChatGPT (${account.label}) is not signed in.`, "warning");
				const usage = await fetchUsage(token);
				const credit = [...usage.credits].sort(
					(a, b) => (a.expiresAt ?? Number.POSITIVE_INFINITY) - (b.expiresAt ?? Number.POSITIVE_INFINITY),
				)[0];
				if (!credit) return ctx.ui.notify(`ChatGPT (${account.label}) has no banked resets.`, "info");
				const warning =
					usage.usableNow === 0 ? " ChatGPT reports nothing to reset right now, so this may not change anything." : "";
				const confirmed = await ctx.ui.confirm(
					`Spend a banked reset on ${account.label}?`,
					`Uses "${credit.title}"${credit.expiresAt ? `, expiring ${formatReset(credit.expiresAt)}` : ""}. ${usage.banked} banked in total.${warning}`,
				);
				if (!confirmed) return ctx.ui.notify("No reset spent.", "info");
				const outcome = await spendReset(token, credit.id);
				if (outcome === "reset") setResetsAt(account.id, undefined);
				return ctx.ui.notify(
					{
						reset: `Spent a banked reset. ChatGPT (${account.label}) is ready again.`,
						nothing_to_reset: `ChatGPT (${account.label}) had nothing to reset, so no reset was spent.`,
						no_credit: `ChatGPT (${account.label}) has no banked resets left.`,
						already_redeemed: "That reset was already spent.",
					}[outcome],
					outcome === "reset" ? "info" : "warning",
				);
			}

			if (accounts.length === 0) {
				return ctx.ui.notify("No ChatGPT accounts yet. Run /chatgpt-pool add <label>.", "info");
			}
			const lines = await Promise.all(
				accounts.map(async (account) => {
					const token = await ctx.modelRegistry.getApiKeyForProvider(account.id).catch(() => undefined);
					if (!token) return `${account.label}: not signed in`;
					const usage: Usage | Error = await fetchUsage(token).catch((error: Error) => error);
					if (usage instanceof Error) {
						const until = account.resetsAt ?? 0;
						const state = until > Date.now() ? `limited, resets ${formatReset(until)}` : "ready";
						return `${account.label}: ${state} (usage unavailable: ${usage.message})`;
					}
					const limitedUntil = usage.limitReached ? Math.max(...usage.windows.map((w) => w.resetsAt)) : undefined;
					if (limitedUntil !== account.resetsAt && (usage.limitReached || (account.resetsAt ?? 0) > Date.now())) {
						setResetsAt(account.id, limitedUntil);
					}
					const windows = usage.windows
						.map((w) => `${formatWindow(w.windowSeconds)} ${Math.round(w.usedPercent)}% used, resets ${formatReset(w.resetsAt)}`)
						.join("; ");
					const banked =
						usage.banked === 0
							? "no banked resets"
							: `${usage.banked} banked reset${usage.banked === 1 ? "" : "s"}${usage.usableNow > 0 ? ` (${usage.usableNow} usable now)` : ""}`;
					return `${account.label}: ${usage.limitReached ? "LIMITED" : "ready"}. ${windows || "no usage windows"}. ${banked}`;
				}),
			);
			ctx.ui.notify(`${lines.join("\n")}\n\nSpend a banked reset with /chatgpt-pool spend <label>.`, "info");
		},
	});
}
