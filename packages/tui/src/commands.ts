import type { Agent } from "@earendil-works/pi-agent-core";
import type { Container, Editor, TUI } from "@earendil-works/pi-tui";
import { StatusBar } from "./ui/status-bar.ts";

export interface CommandDeps {
	agent: Agent;
	chat: Container;
	tui: TUI;
	editor: Editor;
	status: StatusBar;
	respond: (text: string) => void;
}

export function wireCommands(deps: CommandDeps): void {
	const { agent, chat, tui, editor, status, respond } = deps;

	let busy = false;
	editor.onSubmit = (value: string) => {
		if (busy) return;
		const trimmed = value.trim();
		if (!trimmed) return;

		if (trimmed === "/clear") {
			agent.reset();
			chat.clear();
			tui.requestRender();
			return;
		}
		if (trimmed === "/help") {
			respond(
				`**Example queries**
- vegan cafés near camden
- how many bus stops in manchester
- nearest 24/7 pharmacy to the eiffel tower
- drinking water along the south downs way`,
			);
			return;
		}
		if (trimmed === "/model") {
			respond(`Current model: \`${agent.state.model.provider}/${agent.state.model.id}\``);
			return;
		}
		if (trimmed === "/location") {
			respond(status.getLocation() ? `Location: ${status.getLocation()}` : "No location set.");
			return;
		}

		busy = true;
		editor.disableSubmit = true;
		status.setStatus("thinking");

		agent.prompt(trimmed).finally(() => {
			busy = false;
			editor.disableSubmit = false;
			status.setStatus(null);
		});
	};
}
