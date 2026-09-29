import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { getSupportedThinkingLevels, type Api, type Model, type Provider } from "@earendil-works/pi-ai";
import { builtinProviders } from "@earendil-works/pi-ai/providers/all";
import { BorderedLoader, type ExtensionAPI, type ExtensionContext, getAgentDir } from "@earendil-works/pi-coding-agent";
import { chatgptOAuth } from "./chatgpt-oauth.ts";
import { type Account, limitCooldown, nextAccountId, parseResetAt, pickAccount } from "./pool.ts";
import { fetchUsage, spendReset, type Usage } from "./usage.ts";

const POOL_PROVIDER = "chatgpt";
const STATUS_KEY = "chatgpt-pool";
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

	let lastRouted: string | undefined;
	const updateStatus = (ctx: ExtensionContext, provider = ctx.model?.provider) => {
		if (provider !== POOL_PROVIDER) return ctx.ui.setStatus(STATUS_KEY, undefined);
		const now = Date.now();
		const active = accounts.find((account) => account.id === lastRouted);
		const limited = accounts.filter((account) => (account.resetsAt ?? 0) > now);
		const parts = [`chatgpt: ${active?.label ?? "pool"}`];
		if (limited.length > 0) {
			const next = Math.min(...limited.map((account) => account.resetsAt ?? now));
			parts.push(`${limited.length} limited, next back ${formatReset(next)}`);
		}
		ctx.ui.setStatus(STATUS_KEY, parts.join(" · "));
	};

	pi.on("session_start", (_event, ctx) => updateStatus(ctx));
	pi.on("model_select", (event, ctx) => updateStatus(ctx, event.model.provider));

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
							? "No ChatGPT accounts in the pool. Run /chatgpt-pool to add one, then /login."
							: "Every ChatGPT account in the pool is signed out or limited. Run /chatgpt-pool to see reset times and banked resets.",
					);
				}
				if (lastRouted !== routed.provider) {
					lastRouted = routed.provider;
					updateStatus(ctx);
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
		updateStatus(ctx);
		if (ctx.model?.provider !== POOL_PROVIDER) return;
		if (!pickAccount(accounts, (id) => isUsable(ctx, id, message.model), undefined)) return;
		return {
			message: {
				...message,
				errorMessage: `ChatGPT account "${account.label}" is rate limited; switching to another account in the pool.`,
			},
		};
	});

	type AccountStatus = { account: Account; signedIn: boolean; usage?: Usage; error?: string };

	const loadStatuses = (ctx: ExtensionContext, signal?: AbortSignal): Promise<AccountStatus[]> =>
		Promise.all(
			accounts.map(async (account): Promise<AccountStatus> => {
				const token = await ctx.modelRegistry.getApiKeyForProvider(account.id).catch(() => undefined);
				if (!token || signal?.aborted) return { account, signedIn: !!token };
				try {
					const usage = await fetchUsage(token);
					const limitedUntil = usage.limitReached ? Math.max(...usage.windows.map((w) => w.resetsAt)) : undefined;
					if (limitedUntil !== account.resetsAt && (usage.limitReached || (account.resetsAt ?? 0) > Date.now())) {
						setResetsAt(account.id, limitedUntil);
					}
					return { account, signedIn: true, usage };
				} catch (error) {
					return { account, signedIn: true, error: error instanceof Error ? error.message : String(error) };
				}
			}),
		);

	const withLoader = <T>(ctx: ExtensionContext, message: string, work: (signal?: AbortSignal) => Promise<T>) => {
		if (ctx.mode !== "tui") return work();
		return ctx.ui.custom<T | undefined>((tui, theme, _keybindings, done) => {
			const loader = new BorderedLoader(tui, theme, message);
			loader.onAbort = () => done(undefined);
			work(loader.signal).then(done, () => done(undefined));
			return loader;
		});
	};

	const describe = ({ account, signedIn, usage, error }: AccountStatus): string => {
		const limitedUntil = account.resetsAt && account.resetsAt > Date.now() ? account.resetsAt : undefined;
		if (!signedIn) return `${account.label}  ·  not signed in, run /login and pick ChatGPT (${account.label})`;
		const state = limitedUntil ? `limited until ${formatReset(limitedUntil)}` : "ready";
		if (!usage) return `${account.label}  ·  ${state}  ·  usage unavailable${error ? ` (${error})` : ""}`;
		const windows = usage.windows.map(
			(w) => `${formatWindow(w.windowSeconds)} ${Math.round(w.usedPercent)}%, resets ${formatReset(w.resetsAt)}`,
		);
		const banked =
			usage.banked === 0
				? "no banked resets"
				: `${usage.banked} banked${usage.usableNow > 0 ? `, ${usage.usableNow} usable now` : ""}`;
		return [account.label, state, ...windows, banked].join("  ·  ");
	};

	const findAccount = (label: string) =>
		accounts.find((candidate) => candidate.label === label || candidate.id === label);

	const addAccount = (ctx: ExtensionContext, label: string) => {
		if (findAccount(label)) return ctx.ui.notify(`There is already an account named "${label}".`, "warning");
		const account = { id: nextAccountId(accounts), label };
		accounts = [...accounts, account];
		saveAccounts(accounts);
		pi.registerProvider(accountProvider(openai, account, onReset));
		ctx.ui.notify(`Added ChatGPT (${label}). Run /login and pick it to sign in.`, "info");
	};

	const removeAccount = (ctx: ExtensionContext, account: Account) => {
		accounts = accounts.filter((candidate) => candidate.id !== account.id);
		saveAccounts(accounts);
		pi.unregisterProvider(account.id);
		updateStatus(ctx);
		ctx.ui.notify(
			`Removed ChatGPT (${account.label}). Its token stays in auth.json under ${account.id} until you remove it.`,
			"info",
		);
	};

	const spend = async (ctx: ExtensionContext, account: Account, known?: Usage) => {
		const token = await ctx.modelRegistry.getApiKeyForProvider(account.id);
		if (!token) return ctx.ui.notify(`ChatGPT (${account.label}) is not signed in.`, "warning");
		const usage = known ?? (await withLoader(ctx, `Checking ${account.label}...`, () => fetchUsage(token)));
		if (!usage) return;
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
		updateStatus(ctx);
		ctx.ui.notify(
			{
				reset: `Spent a banked reset. ChatGPT (${account.label}) is ready again.`,
				nothing_to_reset: `ChatGPT (${account.label}) had nothing to reset, so no reset was spent.`,
				no_credit: `ChatGPT (${account.label}) has no banked resets left.`,
				already_redeemed: "That reset was already spent.",
			}[outcome],
			outcome === "reset" ? "info" : "warning",
		);
	};

	const openPool = async (ctx: ExtensionContext) => {
		const statuses = await withLoader(ctx, "Checking ChatGPT accounts...", (signal) => loadStatuses(ctx, signal));
		if (!statuses) return;
		updateStatus(ctx);
		const addOption = "+ Add account";
		const options = [...statuses.map(describe), addOption];
		const picked = await ctx.ui.select("ChatGPT pool", options);
		if (!picked) return;
		if (picked === addOption) {
			const label = (await ctx.ui.input("Label for the new ChatGPT account", "work"))?.trim();
			if (label) addAccount(ctx, label);
			return;
		}
		const status = statuses[options.indexOf(picked)];
		const actions = [
			...(status.usage && status.usage.banked > 0 ? [`Spend a banked reset (${status.usage.banked} banked)`] : []),
			...(status.account.resetsAt && status.account.resetsAt > Date.now() ? ["Clear recorded limit"] : []),
			"Remove from pool",
		];
		const action = await ctx.ui.select(`ChatGPT (${status.account.label})`, actions);
		if (!action) return;
		if (action.startsWith("Spend")) return spend(ctx, status.account, status.usage);
		if (action === "Clear recorded limit") {
			setResetsAt(status.account.id, undefined);
			updateStatus(ctx);
			return ctx.ui.notify(`ChatGPT (${status.account.label}) is back in rotation.`, "info");
		}
		if (await ctx.ui.confirm(`Remove ${status.account.label}?`, "It will no longer be used by the pool.")) {
			removeAccount(ctx, status.account);
		}
	};

	const SUBCOMMANDS = [
		{ value: "add", label: "add", description: "Add an account slot" },
		{ value: "remove", label: "remove", description: "Remove an account" },
		{ value: "spend", label: "spend", description: "Spend a banked reset, after confirming" },
		{ value: "reset", label: "reset", description: "Forget recorded limits" },
	];

	pi.registerCommand("chatgpt-pool", {
		description: "Manage pooled ChatGPT accounts: usage, banked resets, add, remove, spend, reset",
		getArgumentCompletions(prefix) {
			const [action, ...rest] = prefix.split(" ");
			if (rest.length === 0) return SUBCOMMANDS.filter((item) => item.value.startsWith(action));
			if (action !== "remove" && action !== "spend") return null;
			const partial = rest.join(" ");
			return accounts
				.filter((account) => account.label.startsWith(partial))
				.map((account) => ({ value: `${action} ${account.label}`, label: account.label, description: account.id }));
		},
		async handler(args, ctx) {
			const [action = "", ...rest] = args.trim().split(/\s+/);
			const label = rest.join(" ");

			if (action === "add") {
				if (!label) return ctx.ui.notify("Usage: /chatgpt-pool add <label>", "warning");
				return addAccount(ctx, label);
			}

			if (action === "remove") {
				const account = findAccount(label);
				if (!account) return ctx.ui.notify(`No pooled account named "${label}"`, "warning");
				return removeAccount(ctx, account);
			}

			if (action === "reset") {
				accounts = accounts.map(({ id, label }) => ({ id, label }));
				saveAccounts(accounts);
				updateStatus(ctx);
				return ctx.ui.notify("Cleared recorded limits. Every signed-in account is back in rotation.", "info");
			}

			if (!ctx.hasUI) {
				throw new Error(
					"/chatgpt-pool needs the interactive UI to show usage or spend a banked reset. Use `pi auth check --provider chatgpt-1` to check an account from a script.",
				);
			}

			if (action === "spend") {
				const account = findAccount(label);
				if (!account) return ctx.ui.notify("Usage: /chatgpt-pool spend <label>", "warning");
				return spend(ctx, account);
			}

			if (action) return ctx.ui.notify(`Unknown action "${action}". Use add, remove, spend, or reset.`, "warning");
			if (accounts.length === 0) {
				const label = (await ctx.ui.input("No ChatGPT accounts yet. Label for the first one", "personal"))?.trim();
				if (label) addAccount(ctx, label);
				return;
			}
			await openPool(ctx);
		},
	});
}
