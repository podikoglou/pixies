import { useEffect } from "react";
import { Link, useParams } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { useChatContext } from "@/contexts/chat-context";
import { ChatView } from "@/components/chat/chat-view";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { getConversation } from "@/api/conversations";
import { transcriptToItems } from "@/state/chat-reducer";
import { ApiError } from "@/sse/client";

export function ConversationPage() {
	const { conversationId } = useParams({ from: "/c/$conversationId", strict: true });
	const { state, loadTranscript } = useChatContext();

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
			if (error instanceof ApiError && error.status === 404) {
				return (
					<div className="flex h-dvh items-center justify-center px-4">
						<Card className="w-full max-w-sm">
							<CardHeader>
								<CardTitle>Conversation not found</CardTitle>
								<CardDescription>
									This conversation doesn't exist or has been deleted.
								</CardDescription>
							</CardHeader>
							<CardContent>
								<Link to="/">
									<Button variant="default" className="w-full">
										Start a new conversation
									</Button>
								</Link>
							</CardContent>
						</Card>
					</div>
				);
			}
			return (
				<div className="text-destructive flex h-dvh items-center justify-center px-4 text-sm">
					{error.message}
				</div>
			);
		}
		return (
			<div className="text-muted-foreground flex h-dvh items-center justify-center text-sm">
				Loading…
			</div>
		);
	}

	return <ChatView />;
}
