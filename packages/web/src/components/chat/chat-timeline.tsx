import type { ChatState } from "@/state/chat-reducer";
import { AssistantMessage } from "./assistant-message";
import { ToolCallCard } from "./tool-call-card";
import { UserMessage } from "./user-message";

interface ChatTimelineProps {
	state: ChatState;
}

export function ChatTimeline({ state }: ChatTimelineProps) {
	return (
		<div className="mx-auto flex max-w-3xl flex-col gap-4 px-4 py-6">
			{state.items.map((item, i) => {
				if (item.kind === "user-message") return <UserMessage key={i} text={item.text} />;
				if (item.kind === "assistant-message") return <AssistantMessage key={i} text={item.text} />;
				return <ToolCallCard key={i} item={item} />;
			})}
			{state.streamingText.length > 0 && <AssistantMessage text={state.streamingText} streaming />}
		</div>
	);
}
