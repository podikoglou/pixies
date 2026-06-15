import { useRef } from "react";
import type { ChatState, TimelineItem } from "@/state/chat-reducer";
import type { DisplayMapData } from "@pixies/core";
import { resolveMapMarkers } from "@/lib/resolve-map-markers";
import { ToolCallCard } from "./tool-call-card";
import { MapWidget } from "./map-widget";
import { UserMessage } from "./user-message";

interface ChatTimelineProps {
	state: ChatState;
}

function renderDisplayMap(data: DisplayMapData, items: TimelineItem[]) {
	if (data.queryRef) {
		const markers = resolveMapMarkers(data.queryRef, data.elementIds, items);
		if (markers === null || markers.length === 0) {
			return (
				<div className="text-muted-foreground flex h-[400px] w-full items-center justify-center rounded-md border text-sm">
					No results found for this query.
				</div>
			);
		}
		return <MapWidget markers={markers} bounds={data.bounds} />;
	}
	return <MapWidget markers={data.markers} bounds={data.bounds} />;
}

export function ChatTimeline({ state }: ChatTimelineProps) {
	const initialCountRef = useRef(state.items.length);
	const skipCount = initialCountRef.current;

	return (
		<div className="mx-auto flex max-w-3xl min-w-0 flex-col gap-4 overflow-hidden px-4 py-6">
			{state.items.map((item, i) => {
				const animate = i >= skipCount;
				let content;
				if (item.kind === "user-message") {
					content = <UserMessage text={item.text} />;
				} else if (item.kind === "assistant-message") {
					content = <></>;
				} else if (
					item.toolName === "display_map" &&
					item.status === "done" &&
					item.result.kind === "display_map"
				) {
					content = renderDisplayMap(item.result.data, state.items);
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
