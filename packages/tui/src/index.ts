import type { AgentEvent } from "@earendil-works/pi-agent-core";
import {
	CombinedAutocompleteProvider,
	Container,
	Editor,
	Key,
	Markdown,
	ProcessTerminal,
	Spacer,
	TUI,
	Text,
	matchesKey,
} from "@earendil-works/pi-tui";
import { createAgent } from "@pixies/core";
import { c, editorTheme, markdownTheme } from "./theme.ts";
import { AssistantMessageComponent } from "./ui/assistant-message.ts";
import { StatusBar } from "./ui/status-bar.ts";
import { ToolCall } from "./ui/tool-call.ts";

const agent = createAgent();

const WELCOME = `pixies — OSM agent

Ask me anything about places. Try:
  • vegan cafés near camden
  • how many bus stops in manchester
  • nearest 24/7 pharmacy to the eiffel tower

Type / for commands. Ctrl+C to exit.`;

const terminal = new ProcessTerminal();
const tui = new TUI(terminal);

const status = new StatusBar({
	appName: "pixies",
	model: agent.state.model.name,
	location: null,
	status: null,
});
tui.addChild(status);
tui.addChild(new Spacer(1));

const chat = new Container();
chat.addChild(new Text(WELCOME, 1, 0));
chat.addChild(new Spacer(1));
tui.addChild(chat);
tui.addChild(new Spacer(1));

const editor = new Editor(tui, editorTheme);
editor.setAutocompleteProvider(
	new CombinedAutocompleteProvider(
		[
			{ name: "clear", description: "Clear the transcript" },
			{ name: "help", description: "Show example queries" },
			{ name: "model", description: "Show current model" },
			{ name: "location", description: "Show current location" },
		],
		process.cwd(),
	),
);
tui.addChild(editor);
tui.setFocus(editor);

let streamingComponent: AssistantMessageComponent | undefined;
const toolCalls = new Map<string, ToolCall>();

const TOOL_LABELS: Record<string, string> = {
	geocode: "Geocode",
	reverse_geocode: "Reverse geocode",
	query_osm: "Query OSM",
};

function toolLabel(name: string): string {
	const known = TOOL_LABELS[name];
	if (known) return known;
	return name
		.split("_")
		.map((part) => part.charAt(0).toUpperCase() + part.slice(1))
		.join(" ");
}

function summarizeToolCall(toolName: string, details: unknown): string | undefined {
	if (!details || typeof details !== "object") return undefined;
	const d = details as Record<string, unknown>;
	if (toolName === "geocode" && typeof d.top === "string") return d.top;
	if (toolName === "reverse_geocode" && typeof d.name === "string") return d.name;
	if (toolName === "query_osm" && typeof d.count === "number") return `${d.count} elements`;
	return undefined;
}

function addAssistantText(text: string): void {
	chat.addChild(new Text(c.assistant("assistant"), 1, 0));
	chat.addChild(new Markdown(text, 1, 0, markdownTheme));
	chat.addChild(new Spacer(1));
	tui.requestRender();
}

agent.subscribe((event: AgentEvent) => {
	switch (event.type) {
		case "message_start":
			if (event.message.role === "user") {
				chat.addChild(new Text(c.user("you"), 1, 0));
				const content = event.message.content;
				const userText =
					typeof content === "string"
						? content
						: content
								.filter((block): block is { type: "text"; text: string } => block.type === "text")
								.map((block) => block.text)
								.join("");
				chat.addChild(new Markdown(userText, 1, 0, markdownTheme));
				chat.addChild(new Spacer(1));
				tui.requestRender();
			} else if (event.message.role === "assistant") {
				chat.addChild(new Text(c.assistant("assistant"), 1, 0));
				streamingComponent = new AssistantMessageComponent();
				chat.addChild(streamingComponent);
				streamingComponent.updateContent(event.message);
				tui.requestRender();
			}
			break;

		case "message_update":
			if (streamingComponent && event.message.role === "assistant") {
				streamingComponent.updateContent(event.message);
				tui.requestRender();
			}
			break;

		case "message_end":
			if (streamingComponent && event.message.role === "assistant") {
				streamingComponent.updateContent(event.message);
				streamingComponent = undefined;
				chat.addChild(new Spacer(1));
				tui.requestRender();
			}
			break;

		case "tool_execution_start": {
			const toolCall = new ToolCall(tui, {
				tool: event.toolName,
				label: toolLabel(event.toolName),
			});
			toolCall.setArgs(event.args);
			toolCalls.set(event.toolCallId, toolCall);
			chat.addChild(toolCall);
			tui.requestRender();
			break;
		}

		case "tool_execution_update": {
			const toolCall = toolCalls.get(event.toolCallId);
			if (!toolCall) break;
			const queued = (event.partialResult as any)?.details?.queued;
			if (typeof queued === "boolean") toolCall.setQueued(queued);
			break;
		}

		case "tool_execution_end": {
			const toolCall = toolCalls.get(event.toolCallId);
			if (toolCall) {
				const text = (event.result?.content ?? [])
					.filter((block: any) => block.type === "text")
					.map((block: any) => block.text)
					.join("\n");
				toolCall.setResult(text || undefined);
				if (event.isError) {
					const errText = event.result?.content?.[0]?.text;
					toolCall.fail(typeof errText === "string" ? errText : "Error");
				} else {
					toolCall.finish(summarizeToolCall(event.toolName, event.result?.details));
				}
				toolCalls.delete(event.toolCallId);
				tui.requestRender();
			}
			break;
		}
	}
});

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
		addAssistantText(
			`**Example queries**
- vegan cafés near camden
- how many bus stops in manchester
- nearest 24/7 pharmacy to the eiffel tower
- drinking water along the south downs way`,
		);
		return;
	}
	if (trimmed === "/model") {
		addAssistantText(`Current model: \`${agent.state.model.provider}/${agent.state.model.id}\``);
		return;
	}
	if (trimmed === "/location") {
		addAssistantText(
			status.getLocation() ? `Location: ${status.getLocation()}` : "No location set.",
		);
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

tui.addInputListener((data: string) => {
	if (matchesKey(data, Key.ctrl("c"))) {
		if (agent.state.isStreaming) {
			agent.abort();
		} else {
			tui.stop();
			process.exit(0);
		}
		return undefined;
	}
	return undefined;
});

tui.start();
