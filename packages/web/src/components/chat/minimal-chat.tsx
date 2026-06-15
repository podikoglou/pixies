import { useState, type KeyboardEvent } from "react";
import type { ChatState } from "@/state/chat-reducer";

interface MinimalChatProps {
	state: ChatState;
	sendMessage: (message: string) => void;
	abort: () => void;
}

export function MinimalChat({ state, sendMessage, abort }: MinimalChatProps) {
	const [text, setText] = useState("");

	const submit = () => {
		const trimmed = text.trim();
		if (!trimmed || state.isStreaming) return;
		sendMessage(trimmed);
		setText("");
	};

	const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
		if (e.key === "Enter" && !e.shiftKey) {
			e.preventDefault();
			submit();
		}
	};

	return (
		<div style={{ display: "flex", flexDirection: "column", gap: 12, padding: 16 }}>
			<div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
				{state.items.map((item, i) => {
					if (item.kind === "user-message")
						return (
							<div key={i}>
								<strong>you:</strong> {item.text}
							</div>
						);
					if (item.kind === "assistant-message")
						return (
							<div key={i}>
								<strong>assistant:</strong> {item.text}
							</div>
						);
					return (
						<div key={i}>
							<strong>tool:</strong> {item.toolName} — {item.status} {item.summary ?? ""}
						</div>
					);
				})}
				{state.streamingText.length > 0 && (
					<div>
						<strong>assistant:</strong> {state.streamingText}
					</div>
				)}
				{state.error && <div style={{ color: "red" }}>{state.error}</div>}
			</div>
			<div style={{ display: "flex", gap: 8, alignItems: "flex-end" }}>
				<textarea
					value={text}
					onChange={(e) => setText(e.target.value)}
					onKeyDown={onKeyDown}
					disabled={state.isStreaming}
					style={{ flex: 1, minHeight: 64 }}
				/>
				<button type="button" onClick={submit} disabled={state.isStreaming}>
					send
				</button>
				{state.isStreaming && (
					<button type="button" onClick={abort}>
						stop
					</button>
				)}
			</div>
		</div>
	);
}
