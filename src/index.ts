import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { getSupportedThinkingLevels, type Api, type Model, type Provider } from "@earendil-works/pi-ai";
import { builtinProviders } from "@earendil-works/pi-ai/providers/all";
import { type ExtensionAPI, type ExtensionContext, getAgentDir } from "@earendil-works/pi-coding-agent";
import { chatgptOAuth } from "./chatgpt-oauth.ts";
import { type Account, limitCooldown, nextAccountId, pickAccount } from "./pool.ts";

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

function accountProvider(openai: Provider, account: Account): Provider {
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
		streamSimple: (model, context, options) => openai.streamSimple(model, context, options),
	};
}

export default function chatgptPool(pi: ExtensionAPI) {
	const openai = builtinProviders().find((provider) => provider.id === "openai");
	if (!openai) throw new Error("pi-chatgpt-pool needs pi's built-in openai provider");

	let accounts = loadAccounts();
	const cooldowns = new Map<string, number>();

	const isUsable = (ctx: ExtensionContext, accountId: string, modelId: string) => {
		const model = ctx.modelRegistry.find(accountId, modelId);
		return (cooldowns.get(accountId) ?? 0) <= Date.now() && !!model && ctx.modelRegistry.hasConfiguredAuth(model);
	};

	for (const account of accounts) pi.registerProvider(accountProvider(openai, account));

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
							: "Every ChatGPT account in the pool is signed out or rate limited. Run /chatgpt-pool to check.",
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
		const cooldown = limitCooldown(message.errorMessage);
		if (!account || cooldown === undefined) return;
		cooldowns.set(account.id, Date.now() + cooldown);
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
		description: "List pooled ChatGPT accounts, or add <label> / remove <label> / reset cooldowns",
		async handler(args, ctx) {
			const [action, ...rest] = args.trim().split(/\s+/);
			const label = rest.join(" ");

			if (action === "add") {
				if (!label) return ctx.ui.notify("Usage: /chatgpt-pool add <label>", "warning");
				const account = { id: nextAccountId(accounts), label };
				accounts = [...accounts, account];
				saveAccounts(accounts);
				pi.registerProvider(accountProvider(openai, account));
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
				cooldowns.clear();
				return ctx.ui.notify("Cleared ChatGPT pool cooldowns.", "info");
			}

			if (accounts.length === 0) {
				return ctx.ui.notify("No ChatGPT accounts yet. Run /chatgpt-pool add <label>.", "info");
			}
			const lines = accounts.map((account) => {
				const until = cooldowns.get(account.id) ?? 0;
				const status = !ctx.modelRegistry.getProviderAuthStatus(account.id).configured
					? "not signed in"
					: until > Date.now()
						? `cooling down until ${new Date(until).toLocaleTimeString()}`
						: "ready";
				return `${account.label} (${account.id}): ${status}`;
			});
			ctx.ui.notify(lines.join("\n"), "info");
		},
	});
}
