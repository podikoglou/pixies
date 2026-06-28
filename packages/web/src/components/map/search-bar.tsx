import { type FormEvent, type KeyboardEvent } from "react";
import { PauseIcon, SendIcon } from "@/components/icons";
import { Button } from "@/components/ui/button";
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
 * Clears on submit, shows stop/ready state, no multi-line support.
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
				className="mx-auto flex items-end gap-2 px-4 pb-[max(0.75rem,env(safe-area-inset-bottom))] pt-3"
			>
				<input
					value={value}
					onChange={(e) => onChange(e.target.value)}
					onKeyDown={onKeyDown}
					placeholder="Search places…"
					aria-label="Search places"
					className="border-input bg-background ring-offset-background placeholder:text-muted-foreground flex h-11 w-full flex-1 rounded-xl border px-3 py-2 text-sm file:border-0 file:bg-transparent file:text-sm file:font-medium focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50"
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
