import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { useChatContext } from "@/contexts/chat-context";
import { Toaster } from "@/components/ui/sonner";
import { ChatInput } from "./chat-input";
import { ChatTimeline } from "./chat-timeline";

const WELCOME_EXAMPLES = [
	"vegan cafés near camden",
	"how many bus stops in manchester",
	"nearest 24/7 pharmacy to the eiffel tower",
];

export function ChatView() {
	const { state, sendMessage, abort } = useChatContext();
	const [text, setText] = useState("");
	const scrollRef = useRef<HTMLDivElement>(null);

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

	useEffect(() => {
		const el = scrollRef.current;
		if (el) el.scrollTop = el.scrollHeight;
	}, [state.items.length, state.streamingText]);

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

			<div ref={scrollRef} className="flex-1 overflow-y-auto">
				{isEmpty ? (
					<div className="mx-auto flex max-w-3xl flex-col items-center gap-6 px-4 py-16 text-center">
						<h1 className="text-foreground text-xl font-semibold">pixies</h1>
						<p className="text-muted-foreground text-sm">Ask me anything about places. Try:</p>
						<div className="flex w-full flex-col gap-2">
							{WELCOME_EXAMPLES.map((example) => (
								<button
									key={example}
									type="button"
									onClick={() => setText(example)}
									className="hover:bg-accent text-muted-foreground hover:text-accent-foreground w-full rounded-lg border px-4 py-2.5 text-left text-sm transition-colors"
								>
									{example}
								</button>
							))}
						</div>
					</div>
				) : (
					<ChatTimeline state={state} />
				)}
			</div>

			<ChatInput
				value={text}
				onChange={setText}
				onSubmit={handleSubmit}
				isStreaming={state.isStreaming}
				onAbort={abort}
			/>

			<Toaster />
		</div>
	);
}
