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

export class ToolCall implements Component {
	private readonly ui: TUI | null;
	private readonly tool: string;
	private label: string;
	private summary: string | undefined;
	private status: ToolCallStatus = "running";
	private frame = 0;
	private intervalId: NodeJS.Timeout | null = null;

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
		const line = this.buildLine(width);
		return [line];
	}

	private buildLine(width: number): string {
		const pad = "  ";
		const toolTag = c.muted(this.tool.padEnd(8));

		let indicator: string;
		let rest: string;
		if (this.status === "running") {
			const frame = FRAMES[this.frame] ?? "";
			indicator = c.accent(frame);
			rest = `${toolTag} ${this.label}`;
		} else if (this.status === "done") {
			indicator = c.success("✓");
			rest = `${toolTag} ${this.label}${this.summary ? c.muted(`  (${this.summary})`) : ""}`;
		} else {
			indicator = c.error("✗");
			rest = `${toolTag} ${this.label}${this.summary ? c.error(`  ${this.summary}`) : ""}`;
		}

		return truncateToWidth(`${pad}${indicator} ${rest}`, width, "");
	}

	private setStatus(status: ToolCallStatus): void {
		this.status = status;
		this.stopAnimation();
		this.requestRender();
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
