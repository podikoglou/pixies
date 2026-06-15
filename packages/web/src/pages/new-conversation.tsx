import { useEffect } from "react";
import { useNavigate } from "@tanstack/react-router";
import { useChatContext } from "@/contexts/chat-context";
import { ChatView } from "@/components/chat/chat-view";

export function NewConversationPage() {
	const { state } = useChatContext();
	const navigate = useNavigate();

	useEffect(() => {
		if (state.conversationId) {
			void navigate({
				to: "/c/$conversationId",
				params: { conversationId: state.conversationId },
			});
		}
	}, [state.conversationId, navigate]);

	return <ChatView />;
}
