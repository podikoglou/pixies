/// <reference types="bun" />
import { test, expect } from "bun:test";
import { matchError, TaggedError } from "better-result";
import {
	BudgetExceededError,
	ConfigError,
	ConversationNotFoundError,
	DisplayMapValidationError,
	InvalidJsonError,
	InvalidTranscriptError,
	OsmBusyError,
	OsmHttpError,
	OsmParseError,
	OsmRemarkError,
	PromptConflictError,
	ToolAbortedError,
	ValidationError,
	type PixiesError,
} from "./errors.ts";

// --- OSM layer --------------------------------------------------------------

test("OsmBusyError carries status, optional service, and computed message", () => {
	const e = new OsmBusyError({ status: 429, service: "Overpass" });
	expect(e._tag).toBe("OsmBusy");
	expect(e.status).toBe(429);
	expect(e.service).toBe("Overpass");
	// Message text matches the historical busy-error string.
	expect(e.message).toBe("Overpass: OSM server busy (HTTP 429)");
	expect(e).toBeInstanceOf(Error);
	// TaggedError base sets `name` to the _tag (not the class name).
	expect(e.name).toBe("OsmBusy");
});

test("OsmBusyError message omits the service prefix when service is absent", () => {
	const e = new OsmBusyError({ status: 503 });
	expect(e.message).toBe("OSM server busy (HTTP 503)");
	expect(e.service).toBeUndefined();
});

test("OsmHttpError accepts status/body/service/message/cause", () => {
	const cause = new Error("upstream");
	const e = new OsmHttpError({
		status: 500,
		body: "err",
		service: "Nominatim",
		message: "m",
		cause,
	});
	expect(e._tag).toBe("OsmHttp");
	expect(e.status).toBe(500);
	expect(e.body).toBe("err");
	expect(e.service).toBe("Nominatim");
	expect(e.message).toBe("m");
	expect(e.cause).toBe(cause);
});

test("OsmParseError carries service + message + cause", () => {
	const cause = new Error("schema");
	const e = new OsmParseError({ service: "Overpass", message: "invalid shape", cause });
	expect(e._tag).toBe("OsmParse");
	expect(e.service).toBe("Overpass");
	expect(e.message).toBe("invalid shape");
	expect(e.cause).toBe(cause);
});

test("OsmRemarkError derives its message from the remark (byte-identical to old throw)", () => {
	const e = new OsmRemarkError({ remark: "runtime error" });
	expect(e._tag).toBe("OsmRemark");
	expect(e.remark).toBe("runtime error");
	expect(e.message).toBe("Overpass: runtime error");
});

// --- Tool layer -------------------------------------------------------------

test("ToolAbortedError carries message and optional cause", () => {
	const e = new ToolAbortedError({ message: "Operation aborted" });
	expect(e._tag).toBe("ToolAborted");
	expect(e.message).toBe("Operation aborted");
	const withCause = new ToolAbortedError({ message: "x", cause: new Error("sig") });
	expect(withCause.cause).toBeInstanceOf(Error);
});

test("DisplayMapValidationError carries reason + message", () => {
	const both = new DisplayMapValidationError({
		reason: "both",
		message: "Provide either ... not both.",
	});
	expect(both._tag).toBe("DisplayMapValidation");
	expect(both.reason).toBe("both");
	expect(both.message).toContain("not both");
});

// --- Conversation store / server -------------------------------------------

test("ConversationNotFoundError / PromptConflictError carry id + message", () => {
	const nf = new ConversationNotFoundError({ id: "abc", message: "conversation not found: abc" });
	expect(nf._tag).toBe("ConversationNotFound");
	expect(nf.id).toBe("abc");
	const pc = new PromptConflictError({ id: "abc", message: "in-flight prompt" });
	expect(pc._tag).toBe("PromptConflict");
	expect(pc.id).toBe("abc");
});

test("BudgetExceededError derives its message (byte-identical to old server string)", () => {
	const e = new BudgetExceededError({ used: 2, budget: 2 });
	expect(e._tag).toBe("BudgetExceeded");
	expect(e.used).toBe(2);
	expect(e.budget).toBe(2);
	expect(e.message).toBe("conversation token budget (2) exceeded: used 2");
});

// --- parsing / config / web ------------------------------------------------

test("InvalidJsonError / ValidationError / ConfigError / InvalidTranscriptError carry message", () => {
	expect(new InvalidJsonError({ message: "bad json" })._tag).toBe("InvalidJson");
	expect(new ValidationError({ message: "bad field" })._tag).toBe("Validation");
	expect(new ConfigError({ message: "bad config" })._tag).toBe("Config");
	expect(new InvalidTranscriptError({ message: "bad transcript" })._tag).toBe("InvalidTranscript");
});

// --- generic TaggedError contract ------------------------------------------

test("toJSON() returns a plain object with _tag/name/message and serialized cause", () => {
	const cause = new Error("upstream");
	const e = new OsmHttpError({ status: 500, message: "fail", cause });
	const json = e.toJSON() as Record<string, unknown>;
	expect(json._tag).toBe("OsmHttp");
	expect(json.name).toBe("OsmHttp");
	expect(json.message).toBe("fail");
	// cause is serialized to { name, message, stack }, not the live Error.
	expect(json.cause).toEqual(expect.objectContaining({ name: "Error", message: "upstream" }));
	// JSON.stringify must not throw (no circular-ref blowups through cause).
	expect(() => JSON.stringify(e)).not.toThrow();
});

test("TaggedError.is narrows to any tagged error and class-level .is narrows further", () => {
	const e = new OsmBusyError({ status: 429 });
	expect(TaggedError.is(e)).toBe(true);
	expect(OsmBusyError.is(e)).toBe(true);
	expect(OsmHttpError.is(e)).toBe(false);
	const plain = new Error("plain");
	expect(TaggedError.is(plain)).toBe(false);
});

// --- exhaustiveness: a matchError switch over the full union must type-check ---

test("matchError over PixiesError compiles exhaustively (type-level guarantee)", () => {
	const exhaustive = ((e: PixiesError): string =>
		matchError(e, {
			OsmBusy: () => "busy",
			OsmHttp: () => "http",
			OsmParse: () => "parse",
			OsmRemark: () => "remark",
			ToolAborted: () => "aborted",
			DisplayMapValidation: () => "display",
			ConversationNotFound: () => "nf",
			PromptConflict: () => "conflict",
			BudgetExceeded: () => "budget",
			InvalidJson: () => "json",
			Validation: () => "validation",
			Config: () => "config",
			InvalidTranscript: () => "transcript",
		})) satisfies (e: PixiesError) => string;
	// Smoke-check one branch dispatches correctly.
	expect(exhaustive(new BudgetExceededError({ used: 1, budget: 2 }))).toBe("budget");
	expect(exhaustive(new OsmBusyError({ status: 429 }))).toBe("busy");
});
