import { Outlet, createRootRoute, createRoute, createRouter } from "@tanstack/react-router";
import { QueryClientProvider } from "@tanstack/react-query";
import { queryClient } from "@/lib/query-client";
import { ChatProvider } from "@/contexts/chat-context";
import { Toaster } from "@/components/ui/sonner";
import { NewConversationPage } from "@/pages/new-conversation";
import { ConversationPage } from "@/pages/conversation";

const rootRoute = createRootRoute({
	component: () => (
		<QueryClientProvider client={queryClient}>
			<ChatProvider>
				<Outlet />
				<Toaster />
			</ChatProvider>
		</QueryClientProvider>
	),
});

export const newConversationRoute = createRoute({
	getParentRoute: () => rootRoute,
	path: "/",
	component: NewConversationPage,
});

export const conversationRoute = createRoute({
	getParentRoute: () => rootRoute,
	path: "/c/$conversationId",
	component: ConversationPage,
});

const routeTree = rootRoute.addChildren([newConversationRoute, conversationRoute]);

export const router = createRouter({ routeTree });

declare module "@tanstack/react-router" {
	interface Register {
		router: typeof router;
	}
}
