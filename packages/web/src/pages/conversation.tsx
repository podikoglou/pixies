import { useEffect } from "react";
import { Link, useParams } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { useChatContext } from "@/contexts/chat-context";
import { ChatView } from "@/components/chat/chat-view";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { getConversation } from "@/api/conversations";
import { transcriptToItems } from "@/state/chat-reducer";
import { ApiError } from "@/sse/client";

export function ConversationPage() {
	const { conversationId } = useParams({ from: "/c/$conversationId", strict: true });
	const { state, loadTranscript } = useChatContext();

	const needsLoad = state.conversationId !== conversationId;

	const { data, error, refetch } = useQuery({
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
				<div className="flex h-dvh items-center justify-center px-4">
					<Card className="w-full max-w-sm">
						<CardHeader>
							<CardTitle>Something went wrong</CardTitle>
							<CardDescription>{error.message}</CardDescription>
						</CardHeader>
						<CardContent>
							<Button variant="default" className="w-full" onClick={() => void refetch()}>
								Retry
							</Button>
						</CardContent>
					</Card>
				</div>
			);
		}
		return (
			<div className="mx-auto flex max-w-3xl flex-col gap-4 px-4 py-6">
				<div className="flex justify-end">
					<Skeleton className="h-10 w-2/3 rounded-2xl sm:w-2/5" />
				</div>
				<div className="flex flex-col gap-2">
					<Skeleton className="h-3 w-16" />
					<Skeleton className="h-4 w-full" />
					<Skeleton className="h-4 w-5/6" />
					<Skeleton className="h-4 w-2/3" />
				</div>
				<Skeleton className="h-16 w-full rounded-xl" />
			</div>
		);
	}

	return <ChatView />;
}
