import type { PixiesErrorTag } from "@pixies/core";

/**
 * Pick friendly toast copy for an SSE `"error"` event.
 *
 * The server forwards a {@link PixiesErrorTag} string in `errorTag` (and a
 * `toJSON()` snapshot in `details`) when the agent rejects with a TaggedError;
 * otherwise `errorTag` is absent and we fall back to the raw `message`
 * (issue #109). The switch is exhaustive over the known tag union, so adding a
 * new TaggedError forces a copy arm here; the `default` covers the
 * wire-trust boundary (a server may send an unknown tag string).
 */
export interface ErrorCopyArgs {
	tag: PixiesErrorTag | undefined;
	defaultMessage: string;
	details: unknown;
}

export function errorToToastCopy({ tag, defaultMessage, details }: ErrorCopyArgs): string {
	switch (tag) {
		case "OsmBusy":
			return "OpenStreetMap's servers are busy. Try again in a moment.";
		case "OsmHttp":
		case "OsmParse":
		case "OsmRemark":
			return "We couldn't reach OpenStreetMap just now. Try again.";
		case "ToolAborted":
			return defaultMessage || "Stopped.";
		case "BudgetExceeded": {
			const d = details as { used?: number; budget?: number } | undefined;
			return d?.budget
				? `This conversation hit its token budget (${d.used}/${d.budget}). Start a new conversation.`
				: "This conversation hit its token budget. Start a new conversation.";
		}
		case "PromptConflict":
			return "This conversation is already responding. Wait for it to finish.";
		case "ConversationNotFound":
			return "This conversation no longer exists.";
		case undefined:
		default:
			return defaultMessage;
	}
}
