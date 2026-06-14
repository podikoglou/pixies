import type { Component, TUI } from "@earendil-works/pi-tui";
import { truncateToWidth } from "@earendil-works/pi-tui";
import { c } from "../theme.ts";

export type ToolCallStatus = "running" | "done" | "error";

export interface ToolCallOptions {
	tool: string;
	label: string;
	summary?: string;
}

const FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
const INTERVAL_MS = 80;
const BODY_INDENT = "        ";
const BODY_INDENT_WIDTH = BODY_INDENT.length;
const MAX_ARG_LINES = 3;
const MAX_RESULT_LINES = 3;
const MAX_VALUE_WIDTH = 60;

export class ToolCall implements Component {
	private readonly ui: TUI | null;
	private readonly tool: string;
	private label: string;
	private summary: string | undefined;
	private status: ToolCallStatus = "running";
	private args: unknown = undefined;
	private resultText: string | undefined = undefined;
	private frame = 0;
	private intervalId: NodeJS.Timeout | null = null;
	private readonly startedAt: number = Date.now();
	private endedAt: number | undefined = undefined;
	private queued = false;

	constructor(ui: TUI | null, opts: ToolCallOptions) {
		this.ui = ui;
		this.tool = opts.tool;
		this.label = opts.label;
		this.summary = opts.summary;
		this.startAnimation();
	}

	setLabel(label: string): void {
		this.label = label;
		this.requestRender();
	}

	setSummary(summary: string | undefined): void {
		this.summary = summary;
		this.requestRender();
	}

	setArgs(args: unknown): void {
		this.args = args;
		this.requestRender();
	}

	setResult(text: string | undefined): void {
		this.resultText = text;
		this.requestRender();
	}

	setQueued(queued: boolean): void {
		this.queued = queued;
		this.requestRender();
	}

	finish(summary?: string): void {
		if (summary !== undefined) this.summary = summary;
		this.setStatus("done");
	}

	fail(message: string): void {
		this.summary = message;
		this.setStatus("error");
	}

	invalidate(): void {
		// state-driven; nothing cached
	}

	handleInput(): void {
		// non-interactive
	}

	render(width: number): string[] {
		const lines: string[] = [this.buildLine(width)];
		const bodyWidth = Math.max(0, width - BODY_INDENT_WIDTH);

		for (const line of this.renderArgs(bodyWidth)) lines.push(line);

		if (this.status !== "running") {
			for (const line of this.renderResult(bodyWidth)) lines.push(line);
		}

		return lines;
	}

	private buildLine(width: number): string {
		const pad = "  ";
		const toolTag = c.muted(this.tool.padEnd(8));

		let indicator: string;
		let rest: string;
		if (this.status === "running") {
			const frame = FRAMES[this.frame] ?? "";
			indicator = c.accent(frame);
			const suffix = this.queued ? c.warning("queued (rate limit)") : c.muted(this.formatElapsed());
			rest = `${toolTag} ${this.label}  ${suffix}`;
		} else if (this.status === "done") {
			indicator = c.success("✓");
			const summary = this.summary ? c.muted(`  (${this.summary})`) : "";
			rest = `${toolTag} ${this.label}${summary}  ${c.muted(this.formatElapsed())}`;
		} else {
			indicator = c.error("✗");
			const err = this.summary ? c.error(`  ${this.summary}`) : "";
			rest = `${toolTag} ${this.label}${err}  ${c.muted(this.formatElapsed())}`;
		}

		return truncateToWidth(`${pad}${indicator} ${rest}`, width, "");
	}

	private renderArgs(bodyWidth: number): string[] {
		const entries = this.argEntries();
		if (entries.length === 0) return [];

		const lines: string[] = [];
		for (const [key, value] of entries.slice(0, MAX_ARG_LINES)) {
			const valueStr = truncateToWidth(this.formatValue(value), MAX_VALUE_WIDTH, "…");
			const line = `${key}: ${valueStr}`;
			lines.push(c.muted(BODY_INDENT + truncateToWidth(line, bodyWidth, "…")));
		}
		const overflow = entries.length - MAX_ARG_LINES;
		if (overflow > 0) {
			lines.push(c.muted(BODY_INDENT + truncateToWidth(`... ${overflow} more`, bodyWidth, "…")));
		}
		return lines;
	}

	private renderResult(bodyWidth: number): string[] {
		if (this.resultText === undefined) return [];

		const allLines = this.resultText.split("\n");
		const lines: string[] = allLines
			.slice(0, MAX_RESULT_LINES)
			.map((line) => c.muted(BODY_INDENT + truncateToWidth(line, bodyWidth, "…")));
		const overflow = allLines.length - MAX_RESULT_LINES;
		if (overflow > 0) {
			lines.push(c.muted(BODY_INDENT + truncateToWidth(`... ${overflow} more`, bodyWidth, "…")));
		}
		return lines;
	}

	private argEntries(): [string, unknown][] {
		if (typeof this.args !== "object" || this.args === null) return [];
		if (Array.isArray(this.args)) return [];
		return Object.entries(this.args as Record<string, unknown>);
	}

	private formatValue(value: unknown): string {
		if (typeof value === "string") return value;
		try {
			return JSON.stringify(value) ?? String(value);
		} catch {
			return String(value);
		}
	}

	private setStatus(status: ToolCallStatus): void {
		this.endedAt = Date.now();
		this.status = status;
		this.stopAnimation();
		this.requestRender();
	}

	private elapsedMs(): number {
		return (this.endedAt ?? Date.now()) - this.startedAt;
	}

	private formatElapsed(): string {
		const s = this.elapsedMs() / 1000;
		if (s < 10) return `${s.toFixed(1)}s`;
		return `${Math.round(s)}s`;
	}

	private startAnimation(): void {
		this.stopAnimation();
		if (FRAMES.length <= 1) return;
		this.intervalId = setInterval(() => {
			this.frame = (this.frame + 1) % FRAMES.length;
			this.requestRender();
		}, INTERVAL_MS);
	}

	private stopAnimation(): void {
		if (this.intervalId) {
			clearInterval(this.intervalId);
			this.intervalId = null;
		}
	}

	private requestRender(): void {
		this.ui?.requestRender();
	}
}
