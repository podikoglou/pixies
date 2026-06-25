import type { PixiesErrorTag } from "@pixies/core";

/**
 * Pick friendly toast copy for an SSE `"error"` event.
 *
 * The read boundary in `use-chat.ts` parses the raw `errorTag` string through
 * `PixiesErrorTagSchema`, so this function only ever receives a known
 * {@link PixiesErrorTag} or `undefined` (absent on the wire, or rejected by
 * the schema). The switch is exhaustive over the known tag union, so adding a
 * new TaggedError forces a copy arm here; the `undefined`/`default` arm is the
 * fallback for a missing tag.
 */
export interface ErrorCopyArgs {
	tag: PixiesErrorTag | undefined;
	defaultMessage: string;
	details: unknown;
}

export function errorToToastCopy({ tag, defaultMessage, details }: ErrorCopyArgs): string {
	switch (tag) {
		case "NominatimBusy":
		case "OverpassBusy":
			return "OpenStreetMap's servers are busy. Try again in a moment.";
		case "NominatimHttp":
		case "NominatimParse":
		case "OverpassHttp":
		case "OverpassParse":
		case "OverpassRemark":
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
