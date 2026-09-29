export function formatWindow(seconds: number): string {
	if (seconds % 604800 === 0) return seconds === 604800 ? "weekly" : `${seconds / 604800}-week`;
	if (seconds % 86400 === 0) return seconds === 86400 ? "daily" : `${seconds / 86400}-day`;
	if (seconds % 3600 === 0) return `${seconds / 3600}h`;
	return `${Math.round(seconds / 60)}m`;
}

export function formatReset(at: number): string {
	const date = new Date(at);
	const time = date.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
	return date.toDateString() === new Date().toDateString()
		? `at ${time}`
		: `${date.toLocaleDateString([], { weekday: "short", month: "short", day: "numeric" })} at ${time}`;
}

export function formatIn(ms: number): string {
	const minutes = Math.max(1, Math.ceil(ms / 60_000));
	const days = Math.floor(minutes / 1440);
	const hours = Math.floor((minutes % 1440) / 60);
	const rest = minutes % 60;
	if (days > 0) return hours > 0 ? `${days}d ${hours}h` : `${days}d`;
	if (hours > 0) return rest > 0 ? `${hours}h ${rest}m` : `${hours}h`;
	return `${rest}m`;
}

export function usageBar(percent: number, width: number) {
	const clamped = Math.min(100, Math.max(0, percent));
	const filled = Math.round((clamped / 100) * width);
	return { filled: "█".repeat(filled), empty: "░".repeat(width - filled) };
}
