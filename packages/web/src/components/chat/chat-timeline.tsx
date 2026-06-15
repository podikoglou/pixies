import { useRef } from "react";
import type { ChatState } from "@/state/chat-reducer";
import { AssistantMessage } from "./assistant-message";
import { ToolCallCard } from "./tool-call-card";
import { UserMessage } from "./user-message";

interface ChatTimelineProps {
	state: ChatState;
}

export function ChatTimeline({ state }: ChatTimelineProps) {
	const initialCountRef = useRef(state.items.length);
	const skipCount = initialCountRef.current;

	return (
		<div className="mx-auto flex max-w-3xl min-w-0 flex-col gap-4 overflow-hidden px-4 py-6">
			{state.items.map((item, i) => {
				const animate = i >= skipCount;
				const content =
					item.kind === "user-message" ? (
						<UserMessage text={item.text} />
					) : item.kind === "assistant-message" ? (
						<AssistantMessage text={item.text} />
					) : (
						<ToolCallCard item={item} />
					);
				return (
					<div key={i} className={animate ? "animate-timeline-enter" : undefined}>
						{content}
					</div>
				);
			})}
			{state.streamingText.length > 0 && (
				<div className="animate-timeline-enter">
					<AssistantMessage text={state.streamingText} streaming />
				</div>
			)}
		</div>
	);
}
