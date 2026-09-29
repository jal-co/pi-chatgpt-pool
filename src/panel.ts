import type { Theme } from "@earendil-works/pi-coding-agent";
import { type Component, Key, matchesKey, truncateToWidth, type TUI, visibleWidth } from "@earendil-works/pi-tui";
import { formatIn, formatWindow, usageBar } from "./format.ts";
import type { Account } from "./pool.ts";
import type { Usage } from "./usage.ts";

export type AccountStatus = { account: Account; signedIn: boolean; usage?: Usage; error?: string };

export type PanelAction =
	| { type: "close" }
	| { type: "refresh" }
	| { type: "add" }
	| { type: "strategy" }
	| { type: "spend" | "clear" | "remove" | "name" | "login"; accountId: string };

const ACCOUNT_KEYS = new Map<string, "spend" | "clear" | "remove" | "name">([
	["s", "spend"],
	["c", "clear"],
	["d", "remove"],
	["n", "name"],
]);
const POOL_KEYS = new Map<string, "refresh" | "add" | "strategy">([
	["r", "refresh"],
	["a", "add"],
	["t", "strategy"],
]);
const BAR_WIDTH = 16;
const HINTS = [
	"↑↓ select · enter sign in · s spend reset · c clear limit · n login name · d remove · a add · t strategy · r refresh · esc close",
	"↑↓ · enter sign in · s spend · c clear · n name · d remove · a add · t strategy · esc",
	"enter sign in · s spend · n name · d del · a add · esc",
];

export class PoolPanel implements Component {
	private selected = 0;

	constructor(
		private readonly tui: TUI,
		private readonly theme: Theme,
		private readonly statuses: readonly AccountStatus[],
		private readonly strategyName: string,
		private readonly activeId: string | undefined,
		private readonly done: (action: PanelAction) => void,
	) {}

	handleInput(data: string): void {
		if (matchesKey(data, Key.escape) || data === "q") return this.done({ type: "close" });
		if (matchesKey(data, Key.up) || data === "k") return this.move(-1);
		if (matchesKey(data, Key.down) || data === "j") return this.move(1);
		if (matchesKey(data, Key.enter)) {
			const account = this.statuses[this.selected]?.account;
			return account ? this.done({ type: "login", accountId: account.id }) : undefined;
		}
		const poolAction = POOL_KEYS.get(data);
		const accountAction = ACCOUNT_KEYS.get(data);
		const account = this.statuses[this.selected]?.account;
		if (poolAction) this.done({ type: poolAction });
		else if (accountAction && account) this.done({ type: accountAction, accountId: account.id });
	}

	invalidate(): void {}

	render(width: number): string[] {
		const { theme } = this;
		const rule = theme.fg("borderAccent", "─".repeat(width));
		const lines = [
			rule,
			`${theme.fg("accent", theme.bold("ChatGPT pool"))}  ${theme.fg("muted", `strategy: ${this.strategyName}`)}`,
			"",
		];
		if (this.statuses.length === 0) lines.push(theme.fg("muted", "No accounts yet. Press a to add one."), "");
		this.statuses.forEach((status, index) => lines.push(...this.renderAccount(status, index === this.selected), ""));
		const hint = HINTS.find((text) => visibleWidth(text) <= width) ?? HINTS[HINTS.length - 1];
		lines.push(theme.fg("dim", hint), rule);
		return lines.map((line) => truncateToWidth(line, width));
	}

	private move(delta: number): void {
		if (this.statuses.length === 0) return;
		this.selected = (this.selected + delta + this.statuses.length) % this.statuses.length;
		this.tui.requestRender();
	}

	private renderAccount({ account, signedIn, usage, error }: AccountStatus, selected: boolean): string[] {
		const { theme } = this;
		const now = Date.now();
		const pointer = selected ? theme.fg("accent", "› ") : "  ";
		const name = selected ? theme.fg("accent", theme.bold(account.label)) : theme.bold(account.label);
		const active = account.id === this.activeId ? theme.fg("muted", " (in use)") : "";
		const limitedUntil = account.resetsAt && account.resetsAt > now ? account.resetsAt : undefined;
		const state = !signedIn
			? theme.fg("muted", "not signed in")
			: limitedUntil
				? theme.fg("warning", `limited · back in ${formatIn(limitedUntil - now)}`)
				: theme.fg("success", "ready");
		const banked =
			usage && usage.banked > 0
				? theme.fg("accent", `  ${usage.banked} banked reset${usage.banked === 1 ? "" : "s"}`) +
					(usage.usableNow > 0 ? theme.fg("success", ` (${usage.usableNow} usable now)`) : "")
				: "";
		const header = `${pointer}${name}${active}  ${state}${banked}`;

		if (!signedIn) return [header, theme.fg("dim", "    press enter to sign in")];
		if (!usage) return [header, theme.fg("dim", `    usage unavailable${error ? `: ${error}` : ""}`)];
		return [
			header,
			...usage.windows.map((window) => {
				const bar = usageBar(window.usedPercent, BAR_WIDTH);
				const color = window.usedPercent >= 90 ? "error" : window.usedPercent >= 70 ? "warning" : "success";
				const label = formatWindow(window.windowSeconds).padEnd(7);
				const percent = `${Math.round(window.usedPercent)}%`.padStart(4);
				return `    ${theme.fg("muted", label)} ${theme.fg(color, bar.filled)}${theme.fg("dim", bar.empty)} ${percent}  ${theme.fg("muted", `resets in ${formatIn(window.resetsAt - now)}`)}`;
			}),
		];
	}
}
