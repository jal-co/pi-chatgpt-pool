import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { getSupportedThinkingLevels, type Api, type Model, type Provider } from "@earendil-works/pi-ai";
import { builtinProviders } from "@earendil-works/pi-ai/providers/all";
import { BorderedLoader, type ExtensionAPI, type ExtensionContext, getAgentDir } from "@earendil-works/pi-coding-agent";
import {
	type Account,
	isStrategy,
	failoverMessage,
	limitCooldown,
	nextAccountId,
	orderAccounts,
	parseResetAt,
	pickAccount,
	STRATEGIES,
	type Strategy,
	type UsageSnapshot,
} from "./pool.ts";
import { formatIn, formatReset, formatWindow } from "./format.ts";
import { type AccountStatus, type PanelAction, PoolPanel } from "./panel.ts";
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

type PoolConfig = { strategy: Strategy; rotation: number; accounts: Account[] };
const USAGE_TTL_MS = 5 * 60 * 1000;

function loadConfig(): PoolConfig {
	if (!existsSync(configPath())) return { strategy: "fill-first", rotation: 0, accounts: [] };
	const raw = JSON.parse(readFileSync(configPath(), "utf8"));
	return {
		strategy: isStrategy(raw.strategy ?? "") ? raw.strategy : "fill-first",
		rotation: Number.isInteger(raw.rotation) ? raw.rotation : 0,
		accounts: raw.accounts ?? [],
	};
}

function saveConfig(config: PoolConfig): void {
	mkdirSync(dirname(configPath()), { recursive: true });
	writeFileSync(configPath(), `${JSON.stringify(config, null, 2)}\n`);
}

function snapshotOf(usage: Usage): UsageSnapshot | undefined {
	if (usage.windows.length === 0) return undefined;
	return {
		usedPercent: usage.limitReached ? 100 : Math.max(...usage.windows.map((w) => w.usedPercent)),
		resetsAt: Math.min(...usage.windows.map((w) => w.resetsAt)),
	};
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

function subscriptionModels(providers: readonly Provider[]): Model<Api>[] {
	const openai = providers.find((provider) => provider.id === "openai");
	if (!openai) throw new Error("pi-chatgpt-pool needs pi's built-in openai provider");
	const codex = new Set(providers.find((provider) => provider.id === "openai-codex")?.getModels().map((model) => model.id));
	return openai.getModels().filter((model) => codex.has(model.id));
}

function accountProvider(openai: Provider, account: Account, onReset: ResetListener): Provider {
	const name = `ChatGPT (${account.label})`;
	const signIn = openai.auth.oauth;
	if (!signIn) throw new Error("pi's openai provider has no Sign in with ChatGPT flow; update pi to 0.99.1 or later");
	const models: Model<Api>[] = subscriptionModels(builtinProviders()).map((model) => ({
		...model,
		provider: account.id,
		compat: { ...model.compat, ...CHATGPT_COMPAT },
	}));
	return {
		id: account.id,
		name,
		baseUrl: openai.baseUrl,
		auth: { oauth: { ...signIn, name } },
		getModels: () => models,
		stream: (model, context, options) => openai.stream(model, context, options),
		streamSimple: (model, context, options) =>
			openai.streamSimple(model, context, { ...options, fetch: limitAwareFetch(account.id, onReset, options?.fetch) }),
	};
}

export default function chatgptPool(pi: ExtensionAPI) {
	const providers = builtinProviders();
	const openai = providers.find((provider) => provider.id === "openai");
	if (!openai) throw new Error("pi-chatgpt-pool needs pi's built-in openai provider");

	let { strategy, accounts } = loadConfig();
	const update = (change: (config: PoolConfig) => PoolConfig) => {
		const next = change(loadConfig());
		saveConfig(next);
		({ strategy, accounts } = next);
		return next;
	};
	const usageCache = new Map<string, { snapshot: UsageSnapshot; at: number }>();

	const rememberUsage = (accountId: string, usage: Usage) => {
		const snapshot = snapshotOf(usage);
		if (snapshot) usageCache.set(accountId, { snapshot, at: Date.now() });
	};

	const freshUsage = async (ctx: ExtensionContext, signal?: AbortSignal) => {
		if (strategy !== "least-used" && strategy !== "use-it-or-lose-it") return new Map<string, UsageSnapshot>();
		await Promise.all(
			accounts.map(async (account) => {
				const cached = usageCache.get(account.id);
				if (cached && Date.now() - cached.at < USAGE_TTL_MS) return;
				const token = await ctx.modelRegistry.getApiKeyForProvider(account.id).catch(() => undefined);
				if (!token || signal?.aborted) return;
				await fetchUsage(token).then((usage) => rememberUsage(account.id, usage), () => undefined);
			}),
		);
		return new Map([...usageCache].map(([id, entry]) => [id, entry.snapshot]));
	};
	const refreshUsage = async (ctx: ExtensionContext, accountId: string) => {
		const cached = usageCache.get(accountId);
		if (cached && Date.now() - cached.at < USAGE_TTL_MS) return;
		const token = await ctx.modelRegistry.getApiKeyForProvider(accountId).catch(() => undefined);
		if (!token) return;
		await fetchUsage(token).then((usage) => rememberUsage(accountId, usage), () => undefined);
	};

	const reportedResets = new Map<string, number>();
	const onReset: ResetListener = (accountId, resetsAt) => reportedResets.set(accountId, resetsAt);

	const setResetsAt = (accountId: string, resetsAt: number | undefined) => {
		update((config) => ({
			...config,
			accounts: config.accounts.map((account) => (account.id === accountId ? { ...account, resetsAt } : account)),
		}));
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
		const snapshot = active && usageCache.get(active.id)?.snapshot;
		const limited = accounts.filter((account) => (account.resetsAt ?? 0) > now);
		const parts = [`chatgpt: ${active?.label ?? "pool"}`];
		if (snapshot) {
			parts[0] += ` ${Math.round(snapshot.usedPercent)}%`;
			parts.push(`resets in ${formatIn(snapshot.resetsAt - now)}`);
		}
		if (limited.length > 0) {
			const next = Math.min(...limited.map((account) => account.resetsAt ?? now));
			parts.push(`${limited.length} limited, next back in ${formatIn(next - now)}`);
		}
		ctx.ui.setStatus(STATUS_KEY, parts.join(" · "));
	};

	pi.on("session_start", (_event, ctx) => updateStatus(ctx));
	pi.on("model_select", (event, ctx) => updateStatus(ctx, event.model.provider));

	let pooledModelsRegistered = false;
	const registerPooledModels = () => {
		if (pooledModelsRegistered || accounts.length === 0) return;
		pooledModelsRegistered = true;
		for (const model of subscriptionModels(providers)) registerPooledModel(model);
	};

	const registerPooledModel = (model: Model<Api>) =>
		pi.registerVirtualModel({
			provider: POOL_PROVIDER,
			id: model.id,
			name: `${model.name} (ChatGPT pool)`,
			thinkingLevels: getSupportedThinkingLevels(model),
			contextWindow: model.contextWindow,
			maxTokens: model.maxTokens,
			input: model.input,
			async route(request, ctx) {
				const sticky = (request.failed ?? request.previous)?.model.provider;
				const usable = (id: string) => isUsable(ctx, id, model.id);
				const keepSticky = sticky !== undefined && usable(sticky);
				const usage = keepSticky ? new Map<string, UsageSnapshot>() : await freshUsage(ctx, request.signal);
				const rotation =
					!keepSticky && sticky === undefined && strategy === "round-robin"
						? update((config) => ({ ...config, rotation: config.rotation + 1 })).rotation - 1
						: 0;
				const ordered = keepSticky ? accounts : orderAccounts(accounts, strategy, usage, rotation);
				const account = pickAccount(ordered, usable, sticky);
				const routed = account && ctx.modelRegistry.find(account.id, model.id);
				if (!routed) {
					throw new Error(
						accounts.length === 0
							? "No ChatGPT accounts in the pool. Run /chatgpt-pool to add one, then /login."
							: "Every ChatGPT account in the pool is signed out or limited. Run /chatgpt-pool to see reset times and banked resets.",
					);
				}
				if (sticky !== undefined && sticky !== routed.provider && ctx.hasUI) {
					const from = accounts.find((candidate) => candidate.id === sticky);
					const until = from?.resetsAt && from.resetsAt > Date.now() ? ` (back in ${formatIn(from.resetsAt - Date.now())})` : "";
					ctx.ui.notify(`ChatGPT pool: ${from?.label ?? sticky} is limited${until}, switched to ${account.label}.`, "info");
				}
				if (lastRouted !== routed.provider) {
					lastRouted = routed.provider;
					updateStatus(ctx);
				}
				refreshUsage(ctx, routed.provider)
					.then(() => updateStatus(ctx, POOL_PROVIDER))
					.catch(() => undefined);
				return { model: routed, thinkingLevel: request.thinkingLevel };
			},
		});

	registerPooledModels();

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
				errorMessage: failoverMessage(account.label),
			},
		};
	});

	const loadStatuses = (ctx: ExtensionContext, signal?: AbortSignal): Promise<AccountStatus[]> =>
		Promise.all(
			accounts.map(async (account): Promise<AccountStatus> => {
				const token = await ctx.modelRegistry.getApiKeyForProvider(account.id).catch(() => undefined);
				if (!token || signal?.aborted) return { account, signedIn: !!token };
				try {
					const usage = await fetchUsage(token);
					rememberUsage(account.id, usage);
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
		const account = { id: nextAccountId(loadConfig().accounts), label };
		update((config) => ({ ...config, accounts: [...config.accounts, account] }));
		registerPooledModels();
		pi.registerProvider(accountProvider(openai, account, onReset));
		ctx.ui.notify(`Added ChatGPT (${label}). Run /login and pick it to sign in.`, "info");
	};

	const removeAccount = (ctx: ExtensionContext, account: Account) => {
		update((config) => ({ ...config, accounts: config.accounts.filter((candidate) => candidate.id !== account.id) }));
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

	const setStrategy = (ctx: ExtensionContext, next: Strategy) => {
		update((config) => ({ ...config, strategy: next }));
		ctx.ui.notify(`${STRATEGIES[next]}.`, "info");
	};

	const chooseStrategy = async (ctx: ExtensionContext) => {
		const labels = Object.values(STRATEGIES).map((text) => (text === STRATEGIES[strategy] ? `${text} (current)` : text));
		const picked = await ctx.ui.select("Routing strategy for new conversations", labels);
		const next = Object.keys(STRATEGIES).find((_key, index) => labels[index] === picked);
		if (next && isStrategy(next)) setStrategy(ctx, next);
	};

	const runPanel = async (ctx: ExtensionContext) => {
		let statuses = await withLoader(ctx, "Checking ChatGPT accounts...", (signal) => loadStatuses(ctx, signal));
		while (statuses) {
			updateStatus(ctx);
			const current = statuses.map((status) => ({
				...status,
				account: accounts.find((account) => account.id === status.account.id) ?? status.account,
			}));
			const strategyName = STRATEGIES[strategy].split(":")[0];
			const action = await ctx.ui.custom<PanelAction>(
				(tui, theme, _keybindings, done) => new PoolPanel(tui, theme, current, strategyName, lastRouted, done),
			);
			if (!action || action.type === "close") return;
			const status = "accountId" in action ? current.find((entry) => entry.account.id === action.accountId) : undefined;
			let reload = false;
			if (action.type === "refresh") {
				reload = true;
			} else if (action.type === "add") {
				const label = (await ctx.ui.input("Label for the new ChatGPT account", "work"))?.trim();
				if (label) addAccount(ctx, label);
				reload = !!label;
			} else if (action.type === "strategy") {
				await chooseStrategy(ctx);
			} else if (status && action.type === "spend") {
				await spend(ctx, status.account, status.usage);
				reload = true;
			} else if (status && action.type === "clear") {
				setResetsAt(status.account.id, undefined);
				ctx.ui.notify(`ChatGPT (${status.account.label}) is back in rotation.`, "info");
			} else if (status && action.type === "remove") {
				if (await ctx.ui.confirm(`Remove ${status.account.label}?`, "It will no longer be used by the pool.")) {
					removeAccount(ctx, status.account);
					statuses = statuses.filter((entry) => entry.account.id !== status.account.id);
				}
			}
			if (reload) {
				usageCache.clear();
				statuses = await withLoader(ctx, "Checking ChatGPT accounts...", (signal) => loadStatuses(ctx, signal));
			}
		}
	};

	const openPool = async (ctx: ExtensionContext) => {
		if (ctx.mode === "tui") return runPanel(ctx);
		const statuses = await withLoader(ctx, "Checking ChatGPT accounts...", (signal) => loadStatuses(ctx, signal));
		if (!statuses) return;
		updateStatus(ctx);
		const addOption = "+ Add account";
		const strategyOption = `Strategy: ${STRATEGIES[strategy].split(":")[0]}`;
		const options = [...statuses.map(describe), addOption, strategyOption];
		const picked = await ctx.ui.select("ChatGPT pool", options);
		if (!picked) return;
		if (picked === strategyOption) return chooseStrategy(ctx);
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
		{ value: "strategy", label: "strategy", description: "Choose how new conversations pick an account" },
	];

	pi.registerCommand("chatgpt-pool", {
		description: "Manage pooled ChatGPT accounts: usage, banked resets, strategy, add, remove, spend, reset",
		getArgumentCompletions(prefix) {
			const [action, ...rest] = prefix.split(" ");
			if (rest.length === 0) return SUBCOMMANDS.filter((item) => item.value.startsWith(action));
			if (action === "strategy") {
				return Object.entries(STRATEGIES)
					.filter(([name]) => name.startsWith(rest.join(" ")))
					.map(([name, description]) => ({ value: `strategy ${name}`, label: name, description }));
			}
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
				update((config) => ({ ...config, accounts: config.accounts.map(({ id, label }) => ({ id, label })) }));
				updateStatus(ctx);
				return ctx.ui.notify("Cleared recorded limits. Every signed-in account is back in rotation.", "info");
			}

			if (action === "strategy") {
				if (isStrategy(label)) return setStrategy(ctx, label);
				if (label || !ctx.hasUI) {
					return ctx.ui.notify(`Usage: /chatgpt-pool strategy <${Object.keys(STRATEGIES).join(" | ")}>`, "warning");
				}
				return chooseStrategy(ctx);
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

			if (action) return ctx.ui.notify(`Unknown action "${action}". Use add, remove, spend, reset, or strategy.`, "warning");
			if (accounts.length === 0) {
				const label = (await ctx.ui.input("No ChatGPT accounts yet. Label for the first one", "personal"))?.trim();
				if (label) addAccount(ctx, label);
				return;
			}
			await openPool(ctx);
		},
	});
}
