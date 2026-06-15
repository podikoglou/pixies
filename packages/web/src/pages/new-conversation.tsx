import { useEffect } from "react";
import { useNavigate } from "@tanstack/react-router";
import { useChatContext } from "@/contexts/chat-context";
import { MinimalChat } from "@/components/chat/minimal-chat";

export function NewConversationPage() {
	const { state, sendMessage, abort } = useChatContext();
	const navigate = useNavigate();

	useEffect(() => {
		if (state.conversationId) {
			void navigate({
				to: "/c/$conversationId",
				params: { conversationId: state.conversationId },
			});
		}
	}, [state.conversationId, navigate]);

	return <MinimalChat state={state} sendMessage={sendMessage} abort={abort} />;
}
