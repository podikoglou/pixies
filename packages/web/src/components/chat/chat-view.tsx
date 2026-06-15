import { useCallback, useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { useChatContext } from "@/contexts/chat-context";
import { SparklesIcon } from "@/components/icons";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import { ChatInput } from "./chat-input";
import { ChatTimeline } from "./chat-timeline";
import { OsmDisclaimer } from "./osm-disclaimer";

const WELCOME_EXAMPLES = [
	"vegan cafés near camden",
	"how many bus stops in manchester",
	"nearest 24/7 pharmacy to the eiffel tower",
];

const PIN_THRESHOLD = 100;

export function ChatView() {
	const { state, sendMessage, abort } = useChatContext();
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
		sendMessage(trimmed);
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
					<span className="text-muted-foreground text-sm font-medium tracking-tight">pixies</span>
				</div>
			</header>

			<ScrollArea ref={rootRef} className="min-h-0 flex-1">
				{isEmpty ? (
					<div className="mx-auto flex max-w-3xl flex-col items-center gap-6 px-4 py-16 text-center">
						<SparklesIcon size={32} className="text-muted-foreground" />
						<p className="text-muted-foreground text-pretty text-sm">
							Ask me anything about places. Try:
						</p>
						<div className="flex w-full flex-col gap-2">
							{WELCOME_EXAMPLES.map((example) => (
								<Button
									key={example}
									variant="outline"
									type="button"
									onClick={() => setText(example)}
									className="w-full justify-start font-normal"
								>
									{example}
								</Button>
							))}
						</div>
					</div>
				) : (
					<ChatTimeline state={state} />
				)}
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
