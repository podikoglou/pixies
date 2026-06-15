import type { AgentEvent } from "@earendil-works/pi-agent-core";
import { Container, Markdown, Spacer, TUI, Text } from "@earendil-works/pi-tui";
import { isToolProgress, toolLabel, summarizeToolDetails } from "@pixies/core";
import type { ToolName } from "@pixies/core";
import { c, markdownTheme } from "./theme.ts";
import { AssistantMessageComponent } from "./ui/assistant-message.ts";
import { ToolCall } from "./ui/tool-call.ts";

export interface AgentEventDeps {
	chat: Container;
	tui: TUI;
}

export function createAgentEventHandler(deps: AgentEventDeps): (event: AgentEvent) => void {
	const { chat, tui } = deps;

	let streamingComponent: AssistantMessageComponent | undefined;
	const toolCalls = new Map<string, ToolCall>();

	return (event: AgentEvent) => {
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
				const progress = event.partialResult?.details;
				if (isToolProgress(progress)) toolCall.setQueued(progress.type === "queued");
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
						toolCall.finish(
							summarizeToolDetails(event.toolName as ToolName, event.result?.details),
						);
					}
					toolCalls.delete(event.toolCallId);
					tui.requestRender();
				}
				break;
			}
		}
	};
}
