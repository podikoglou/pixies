import { useEffect } from "react";
import { useNavigate } from "@tanstack/react-router";
import { useChatContext } from "@/contexts/chat-context";
import { ChatView } from "@/components/chat/chat-view";

export function NewConversationPage() {
	const { reset } = useChatContext();
	const navigate = useNavigate();

	useEffect(() => {
		reset();
	}, [reset]);

	return (
		<ChatView
			onConversationCreated={(id) =>
				void navigate({ to: "/c/$conversationId", params: { conversationId: id } })
			}
		/>
	);
}
