import { useEffect } from "react";
import { useNavigate } from "@tanstack/react-router";
import { useMapContext } from "@/contexts/map-context";
import { MapView } from "@/components/map/map-view";

export function NewConversationPage() {
	const { reset } = useMapContext();
	const navigate = useNavigate();

	useEffect(() => {
		reset();
	}, [reset]);

	return (
		<MapView
			onConversationCreated={(id) =>
				void navigate({ to: "/c/$conversationId", params: { conversationId: id } })
			}
		/>
	);
}
