import { type FormEvent, type KeyboardEvent } from "react";
import { PauseIcon, SendIcon } from "@/components/icons";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { IconCrossfade } from "@/components/ui/icon-crossfade";

interface SearchBarProps {
	value: string;
	onChange: (text: string) => void;
	onSubmit: () => void;
	isStreaming: boolean;
	onAbort: () => void;
}

/**
 * Single-line search bar that replaces the chat textarea in the map-centric UI.
 * Clears on submit and shows stop/ready state via the submit button.
 */
export function SearchBar({ value, onChange, onSubmit, isStreaming, onAbort }: SearchBarProps) {
	const canSend = value.trim().length > 0 && !isStreaming;

	const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
		if (e.key === "Enter") {
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
				className="flex items-center gap-2 px-4 pb-[max(0.75rem,env(safe-area-inset-bottom))] pt-3"
			>
				<Input
					value={value}
					onChange={(e) => onChange(e.target.value)}
					onKeyDown={onKeyDown}
					placeholder="Search places…"
					aria-label="Search places"
					className="h-11 flex-1 rounded-xl"
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
