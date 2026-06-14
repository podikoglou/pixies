import type { AssistantMessage } from "@earendil-works/pi-ai";
import { Container, Markdown, Text } from "@earendil-works/pi-tui";
import { c, markdownTheme } from "../theme.ts";

export class AssistantMessageComponent extends Container {
	private lastMessage?: AssistantMessage;

	constructor(message?: AssistantMessage) {
		super();
		if (message) {
			this.updateContent(message);
		}
	}

	updateContent(message: AssistantMessage): void {
		this.lastMessage = message;
		this.clear();

		for (const block of message.content) {
			if (block.type === "text" && block.text.trim()) {
				this.addChild(new Markdown(block.text.trim(), 1, 0, markdownTheme));
			}
		}

		if (message.stopReason === "aborted") {
			const msg =
				message.errorMessage && message.errorMessage !== "Request was aborted"
					? message.errorMessage
					: "Operation aborted";
			this.addChild(new Text(c.error(msg), 1, 0));
		} else if (message.stopReason === "error") {
			const msg = message.errorMessage || "Unknown error";
			this.addChild(new Text(c.error(`Error: ${msg}`), 1, 0));
		}
	}
}
