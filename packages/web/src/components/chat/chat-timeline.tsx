import { useRef } from "react";
import type { ChatState } from "@/state/chat-reducer";
import { isDisplayMapData } from "@pixies/core";
import { ToolCallCard } from "./tool-call-card";
import { MapWidget } from "./map-widget";
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
						<></>
					) : item.toolName === "display_map" &&
					  item.status === "done" &&
					  isDisplayMapData(item.resultData) ? (
						<MapWidget markers={item.resultData.markers} bounds={item.resultData.bounds} />
					) : (
						<ToolCallCard item={item} />
					);
				return (
					<div key={i} className={animate ? "animate-timeline-enter" : undefined}>
						{content}
					</div>
				);
			})}
		</div>
	);
}
