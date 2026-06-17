import { type FormEvent, type KeyboardEvent } from "react";
import { PauseIcon, SendIcon } from "@/components/icons";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { IconCrossfade } from "@/components/ui/icon-crossfade";

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

	const handleSubmit = (e: FormEvent<HTMLFormElement>) => {
		e.preventDefault();
		if (canSend) onSubmit();
	};

	return (
		<div className="border-border bg-background/80 border-t backdrop-blur">
			<form
				onSubmit={handleSubmit}
				className="mx-auto flex max-w-3xl items-end gap-2 px-4 pb-[max(0.75rem,env(safe-area-inset-bottom))] pt-3"
			>
				<Textarea
					value={value}
					onChange={(e) => onChange(e.target.value)}
					onKeyDown={onKeyDown}
					placeholder="Ask about places…"
					rows={1}
					aria-label="Message pixies"
					className="max-h-48 min-h-11 resize-none py-3 leading-5"
				/>
				<Tooltip>
					<TooltipTrigger
						render={
							<Button
								variant={isStreaming ? "outline" : "default"}
								size="icon"
								type={isStreaming ? "button" : "submit"}
								onClick={isStreaming ? onAbort : undefined}
								disabled={isStreaming ? false : !canSend}
								aria-label={isStreaming ? "Stop" : "Send"}
								className="shrink-0"
							>
								<IconCrossfade
									activeIndex={isStreaming ? 1 : 0}
									slotClassNames={[
										isStreaming ? "blur-sm" : "blur-0",
										isStreaming ? "blur-0" : "blur-sm",
									]}
								>
									<SendIcon size={16} />
									<PauseIcon size={16} />
								</IconCrossfade>
							</Button>
						}
					/>
					<TooltipContent>{isStreaming ? "Stop" : "Send"}</TooltipContent>
				</Tooltip>
			</form>
		</div>
	);
}
