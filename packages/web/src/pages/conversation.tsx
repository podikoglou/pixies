import { useEffect } from "react";
import { useParams } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { useChatContext } from "@/contexts/chat-context";
import { MinimalChat } from "@/components/chat/minimal-chat";
import { getConversation } from "@/api/conversations";
import { transcriptToItems } from "@/state/chat-reducer";
import { ApiError } from "@/sse/client";

export function ConversationPage() {
	const { conversationId } = useParams({ from: "/c/$conversationId", strict: true });
	const { state, sendMessage, abort, loadTranscript } = useChatContext();

	const needsLoad = state.conversationId !== conversationId;

	const { data, error } = useQuery({
		queryKey: ["conversation", conversationId],
		queryFn: () => getConversation(conversationId),
		enabled: needsLoad,
		retry: false,
	});

	useEffect(() => {
		if (data && state.conversationId !== conversationId) {
			loadTranscript(conversationId, transcriptToItems(data));
		}
	}, [data, conversationId, state.conversationId, loadTranscript]);

	if (needsLoad) {
		if (error) {
			if (error instanceof ApiError && error.status === 404)
				return <div>conversation not found</div>;
			return <div style={{ color: "red" }}>{error.message}</div>;
		}
		return <div>loading…</div>;
	}

	return <MinimalChat state={state} sendMessage={sendMessage} abort={abort} />;
}
