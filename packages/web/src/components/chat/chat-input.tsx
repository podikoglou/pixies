import { type KeyboardEvent } from "react";
import { SendHorizontal, Square } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";

interface ChatInputProps {
	value: string;
	onChange: (text: string) => void;
	onSubmit: () => void;
	isStreaming: boolean;
	onAbort: () => void;
}

export function ChatInput({ value, onChange, onSubmit, isStreaming, onAbort }: ChatInputProps) {
	const canSend = value.trim().length > 0 && !isStreaming;

	const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
		if (e.key === "Enter" && !e.shiftKey) {
			e.preventDefault();
			if (canSend) onSubmit();
		}
	};

	return (
		<div className="border-border bg-background/80 border-t backdrop-blur">
			<div className="mx-auto flex max-w-3xl items-end gap-2 px-4 py-3">
				<Textarea
					value={value}
					onChange={(e) => onChange(e.target.value)}
					onKeyDown={onKeyDown}
					placeholder="Ask about places…"
					rows={1}
					className="max-h-48 min-h-11 resize-none"
				/>
				{isStreaming ? (
					<Button
						variant="outline"
						size="icon"
						onClick={onAbort}
						aria-label="Stop"
						className="shrink-0"
					>
						<Square className="size-4" />
					</Button>
				) : (
					<Button
						variant="default"
						size="icon"
						onClick={onSubmit}
						disabled={!canSend}
						aria-label="Send"
						className="shrink-0"
					>
						<SendHorizontal className="size-4" />
					</Button>
				)}
			</div>
		</div>
	);
}
