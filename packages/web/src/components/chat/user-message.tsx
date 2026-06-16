import { formatTime } from "./assistant-message";

interface UserMessageProps {
	text: string;
	responseTimeMs?: number;
}

export function UserMessage({ text, responseTimeMs }: UserMessageProps) {
	return (
		<div className="flex flex-col items-end gap-1">
			<div className="bg-primary text-primary-foreground max-w-[80%] rounded-2xl rounded-br-sm px-4 py-2.5 whitespace-pre-wrap break-words sm:max-w-[60%]">
				{text}
			</div>
			{responseTimeMs !== undefined && (
				<p className="text-muted-foreground text-xs">{formatTime(responseTimeMs)}</p>
			)}
		</div>
	);
}
