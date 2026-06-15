import { useEffect, useRef } from "react";
import { useNavigate } from "@tanstack/react-router";
import { useChatContext } from "@/contexts/chat-context";
import { ChatView } from "@/components/chat/chat-view";

export function NewConversationPage() {
	const { state, reset } = useChatContext();
	const navigate = useNavigate();
	const prevId = useRef(state.conversationId);

	useEffect(() => {
		reset();
	}, [reset]);

	useEffect(() => {
		const id = state.conversationId;
		if (id && prevId.current === null) {
			void navigate({
				to: "/c/$conversationId",
				params: { conversationId: id },
			});
		}
		prevId.current = id;
	}, [state.conversationId, navigate]);

	return <ChatView />;
}
