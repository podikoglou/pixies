import { useCallback, useEffect, useRef, useState } from "react";
import { useNavigate } from "@tanstack/react-router";
import { toast } from "sonner";
import { useChatContext } from "@/contexts/chat-context";
import { useAnalytics } from "@/hooks/use-analytics";
import { ScrollArea } from "@/components/ui/scroll-area";
import { ChatInput } from "./chat-input";
import { ChatTimeline } from "./chat-timeline";
import { OsmDisclaimer } from "./osm-disclaimer";
import { WelcomeScreen } from "./welcome-screen";

const PIN_THRESHOLD = 100;

interface ChatViewProps {
	/** Fired when a `conversation_created` SSE event arrives, with the new id.
	 * Used by `NewConversationPage` to navigate to `/c/$id` from the event
	 * source rather than a state-watching effect (issue #51). Optional —
	 * `ConversationPage` (already on the URL) does not supply it. */
	onConversationCreated?: (id: string) => void;
}

export function ChatView({ onConversationCreated }: ChatViewProps = {}) {
	const { state, sendMessage, abort, reset } = useChatContext();
	const navigate = useNavigate();
	const analytics = useAnalytics();
	const [text, setText] = useState("");
	const rootRef = useRef<HTMLDivElement>(null);
	const isPinnedRef = useRef(true);

	const isEmpty =
		state.items.length === 0 &&
		state.streamingText.length === 0 &&
		!state.isStreaming &&
		state.conversationId === null;

	const handleSubmit = () => {
		const trimmed = text.trim();
		if (!trimmed || state.isStreaming) return;
		analytics.capture("message_sent", { is_new_conversation: state.conversationId === null });
		sendMessage(trimmed, {
			onConversationCreated,
			onToolError: (toolName) => analytics.capture("tool_error", { tool_name: toolName }),
			onToolEmpty: (props) => analytics.capture("tool_empty", props),
		});
		setText("");
	};

	const getViewport = useCallback(
		() =>
			rootRef.current?.querySelector<HTMLDivElement>("[data-slot='scroll-area-viewport']") ?? null,
		[],
	);

	const handleScroll = useCallback(() => {
		const el = getViewport();
		if (!el) return;
		const distanceFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
		isPinnedRef.current = distanceFromBottom <= PIN_THRESHOLD;
	}, [getViewport]);

	useEffect(() => {
		const el = getViewport();
		if (!el) return;
		el.addEventListener("scroll", handleScroll, { passive: true });
		return () => el.removeEventListener("scroll", handleScroll);
	}, [getViewport, handleScroll]);

	useEffect(() => {
		const el = getViewport();
		if (!el || !isPinnedRef.current) return;
		el.scrollTo({ top: el.scrollHeight, behavior: "auto" });
	}, [state.items.length, state.streamingText, getViewport]);

	useEffect(() => {
		if (state.error) toast.error(state.error);
	}, [state.error]);

	return (
		<div className="flex h-dvh flex-col">
			<header className="border-border border-b">
				<div className="mx-auto max-w-3xl px-4 py-2.5">
					<button
						type="button"
						onClick={() => {
							reset();
							navigate({ to: "/" });
						}}
						className="text-muted-foreground text-sm font-medium tracking-tight"
					>
						pixies
					</button>
				</div>
			</header>

			<ScrollArea ref={rootRef} className="min-h-0 flex-1">
				{isEmpty ? <WelcomeScreen onExampleClick={setText} /> : <ChatTimeline state={state} />}
			</ScrollArea>

			<OsmDisclaimer />

			<ChatInput
				value={text}
				onChange={setText}
				onSubmit={handleSubmit}
				isStreaming={state.isStreaming}
				onAbort={abort}
			/>
		</div>
	);
}
