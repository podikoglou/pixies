import type { Component } from "@earendil-works/pi-tui";
import { truncateToWidth } from "@earendil-works/pi-tui";
import { c } from "../theme.ts";

export interface StatusBarState {
	appName: string;
	model: string;
	location: string | null;
	status: string | null;
}

export class StatusBar implements Component {
	private state: StatusBarState;
	private cachedWidth?: number;
	private cachedLine?: string;

	constructor(state: StatusBarState) {
		this.state = state;
	}

	setModel(model: string): void {
		this.state.model = model;
		this.invalidate();
	}

	setLocation(location: string | null): void {
		this.state.location = location;
		this.invalidate();
	}

	setStatus(status: string | null): void {
		this.state.status = status;
		this.invalidate();
	}

	invalidate(): void {
		this.cachedWidth = undefined;
		this.cachedLine = undefined;
	}

	render(width: number): string[] {
		if (this.cachedLine !== undefined && this.cachedWidth === width) {
			return [this.cachedLine];
		}

		const parts: string[] = [];
		parts.push(c.accent(this.state.appName));
		parts.push(c.muted(" · "));
		parts.push(c.muted("model "));
		parts.push(this.state.model);
		if (this.state.location) {
			parts.push(c.muted(" · "));
			parts.push(c.muted("📍 "));
			parts.push(this.state.location);
		}
		if (this.state.status) {
			parts.push(c.muted(" · "));
			parts.push(c.warning(this.state.status));
		}

		const line = truncateToWidth(parts.join(""), width, "");
		this.cachedWidth = width;
		this.cachedLine = line;
		return [line];
	}
}
