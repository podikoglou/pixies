import { MAX_CONTENT_LINES } from "./limits.ts";

type TextToolContent = { content: [{ type: "text"; text: string }] };

/**
 * Build the single-text-block content every tool result emits. Centralises the
 * `{ type: "text" }` literal so the `as const` noise lives in one place.
 */
export function textResult(text: string): TextToolContent {
	return { content: [{ type: "text" as const, text }] };
}

/**
 * Footer line appended to truncated content: "…and N more result(s)." The
 * singular/plural grammar lives here so it cannot drift across tools.
 */
export function moreResultsPhrase(rest: number): string {
	return `…and ${rest} more result${rest !== 1 ? "s" : ""}.`;
}

/**
 * Format a list of rows into model-facing content text, truncating to
 * {@link MAX_CONTENT_LINES} lines and appending a footer when truncated. Owns
 * the threshold check, slice, and join; per-tool divergence is just the row
 * formatter and (optionally) the footer copy.
 */
export function formatContentLines<T>(
	rows: T[],
	format: (row: T) => string,
	footer: (rest: number) => string = moreResultsPhrase,
): string {
	const truncated = rows.length > MAX_CONTENT_LINES;
	const shown = truncated ? rows.slice(0, MAX_CONTENT_LINES) : rows;
	const lines = shown.map(format);
	if (truncated) lines.push(footer(rows.length - MAX_CONTENT_LINES));
	return lines.join("\n");
}
