interface UserMessageProps {
	text: string;
}

export function UserMessage({ text }: UserMessageProps) {
	return (
		<div className="flex justify-end">
			<div className="bg-primary text-primary-foreground max-w-[80%] rounded-2xl rounded-br-sm px-4 py-2.5 whitespace-pre-wrap break-words sm:max-w-[60%]">
				{text}
			</div>
		</div>
	);
}
