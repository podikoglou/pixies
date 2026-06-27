/**
 * Formats a millisecond duration for compact display under chat messages.
 *
 * Three bands: milliseconds under one second, seconds under one minute,
 * and minutes-and-seconds beyond that.
 *
 * @param ms - non-negative duration in milliseconds.
 * @returns a short, human-readable string (e.g. `850ms`, `2.3s`, `1m 30s`).
 */
export function formatTime(ms: number): string {
	if (ms < 1000) return `${Math.round(ms)}ms`;
	if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
	const minutes = Math.floor(ms / 60000);
	const seconds = Math.round((ms % 60000) / 1000);
	return `${minutes}m ${seconds}s`;
}
