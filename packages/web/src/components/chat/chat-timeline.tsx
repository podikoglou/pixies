import { useRef } from "react";
import type { ChatState } from "@/state/chat-reducer";
import {
	displaysToMarkers,
	displaysToPolylines,
	displaysToBounds,
} from "@/lib/resolve-map-markers";
import { ToolCallCard } from "./tool-call-card";
import { MapWidget } from "./map-widget";
import { UserMessage } from "./user-message";
import { AssistantMessage } from "./assistant-message";

interface ChatTimelineProps {
	state: ChatState;
}

export function ChatTimeline({ state }: ChatTimelineProps) {
	// Items present on first mount skip enter animation; only newly
	// streamed-in items animate.
	const initialCountRef = useRef(state.items.length);
	const skipCount = initialCountRef.current;

	return (
		<div className="mx-auto flex max-w-3xl min-w-0 flex-col gap-4 overflow-hidden px-4 py-6">
			{state.items.map((item, i) => {
				const animate = i >= skipCount;
				let content;
				if (item.kind === "user-message") {
					content = <UserMessage text={item.text} responseTimeMs={item.responseTimeMs} />;
				} else if (item.kind === "assistant-message") {
					content = <AssistantMessage text={item.text} responseTimeMs={item.responseTimeMs} />;
				} else if (
					// execute_code results with map-renderable data render as
					// MapWidget instead of ToolCallCard.
					item.toolName === "execute_code" &&
					item.status === "done" &&
					item.result.kind === "execute_code"
				) {
					const { displays } = item.result;
					const markers = displaysToMarkers(displays);
					const polylines = displaysToPolylines(displays);
					if (markers.length > 0 || polylines.length > 0) {
						content = (
							<MapWidget
								markers={markers}
								polylines={polylines}
								bounds={displaysToBounds(displays) ?? undefined}
							/>
						);
					} else {
						content = <ToolCallCard item={item} />;
					}
				} else {
					content = <ToolCallCard item={item} />;
				}
				return (
					<div key={i} className={animate ? "animate-timeline-enter" : undefined}>
						{content}
					</div>
				);
			})}
		</div>
	);
}
