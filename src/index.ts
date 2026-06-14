import {
	CombinedAutocompleteProvider,
	Editor,
	Key,
	Markdown,
	ProcessTerminal,
	Spacer,
	TUI,
	Text,
	matchesKey,
} from "@earendil-works/pi-tui";
import { c, editorTheme, markdownTheme } from "./theme.ts";
import { StatusBar } from "./ui/status-bar.ts";
import { ToolCall } from "./ui/tool-call.ts";

const WELCOME = `pixies — OSM agent

Ask me anything about places. Try:
  • vegan cafés near camden
  • how many bus stops in manchester
  • nearest 24/7 pharmacy to the eiffel tower

Type / for commands. Ctrl+C to exit.`;

const delay = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

const terminal = new ProcessTerminal();
const tui = new TUI(terminal);

const status = new StatusBar({
	appName: "pixies",
	model: "claude-sonnet",
	location: null,
	status: null,
});
tui.addChild(status);
tui.addChild(new Spacer(1));
tui.addChild(new Text(WELCOME, 1, 0));
tui.addChild(new Spacer(1));

const editor = new Editor(tui, editorTheme);
editor.setAutocompleteProvider(
	new CombinedAutocompleteProvider(
		[
			{ name: "clear", description: "Clear the transcript" },
			{ name: "help", description: "Show example queries" },
			{ name: "model", description: "Show current model" },
			{ name: "location", description: "Show current location" },
		],
		process.cwd(),
	),
);
tui.addChild(editor);
tui.setFocus(editor);

function insertAboveEditor(...components: (Text | Markdown | Spacer | ToolCall)[]): void {
	const children = tui.children;
	children.splice(children.length - 1, 0, ...components);
	tui.requestRender();
}

function addUserMessage(text: string): void {
	insertAboveEditor(
		new Text(c.user("you"), 1, 0),
		new Markdown(text, 1, 0, markdownTheme),
		new Spacer(1),
	);
}

function addAssistantMessage(text: string): void {
	insertAboveEditor(
		new Text(c.assistant("assistant"), 1, 0),
		new Markdown(text, 1, 0, markdownTheme),
		new Spacer(1),
	);
}

function addToolCall(tc: ToolCall): void {
	insertAboveEditor(tc);
}

function clearTranscript(): void {
	const children = tui.children;
	// keep: [0]=status, [1]=spacer, [last]=editor
	children.splice(2, children.length - 3);
	tui.requestRender();
}

function pickPlace(prompt: string): string {
	const m = prompt.match(/(?:near|in|to(?:\s+the)?)\s+([a-z][a-z\s'-]+)/i);
	return m?.[1]?.trim() ?? "the area";
}

async function mockRespond(prompt: string): Promise<void> {
	const place = pickPlace(prompt);

	await delay(300);
	const geocode = new ToolCall(tui, { tool: "geocode", label: place });
	addToolCall(geocode);
	await delay(700);
	geocode.finish("51.5290, -0.1425");

	const tags = /cafe|coffee|café/i.test(prompt)
		? "amenity=cafe, diet:vegan"
		: /pharmacy|chemist/i.test(prompt)
			? "amenity=pharmacy, opening_hours:24/7"
			: "amenity=bus_stop";
	const overpass = new ToolCall(tui, { tool: "overpass", label: tags });
	addToolCall(overpass);
	await delay(900);
	const count = 4 + Math.floor(Math.random() * 15);
	overpass.finish(`${count} results`);

	await delay(200);
	addAssistantMessage(
		`Found **${count} matches** near **${place}**.

| Name | Type | Distance |
|------|------|----------|
| The Green Bean | cafe · vegan | 0.4 km |
| Hazelnut Haus | cafe · vegetarian | 0.7 km |
| Root & Stem | restaurant · vegan | 1.1 km |

[OpenStreetMap permalink](https://www.openstreetmap.org/?mlat=51.5290&mlon=-0.1425#map=15/51.5290/-0.1425)`,
	);
}

let busy = false;
editor.onSubmit = (value: string) => {
	if (busy) return;
	const trimmed = value.trim();
	if (!trimmed) return;

	if (trimmed === "/clear") {
		clearTranscript();
		return;
	}
	if (trimmed === "/help") {
		addAssistantMessage(
			`**Example queries**
- vegan cafés near camden
- how many bus stops in manchester
- nearest 24/7 pharmacy to the eiffel tower
- drinking water along the south downs way`,
		);
		return;
	}
	if (trimmed === "/model") {
		addAssistantMessage(`Current model: \`${status.getModel()}\``);
		return;
	}
	if (trimmed === "/location") {
		addAssistantMessage(status.getLocation() ? `Location: ${status.getLocation()}` : "No location set.");
		return;
	}

	busy = true;
	editor.disableSubmit = true;
	status.setStatus("thinking");
	addUserMessage(trimmed);

	mockRespond(trimmed).finally(() => {
		busy = false;
		editor.disableSubmit = false;
		status.setStatus(null);
	});
};

tui.addInputListener((data: string) => {
	if (matchesKey(data, Key.ctrl("c"))) {
		tui.stop();
		process.exit(0);
	}
	return undefined;
});

tui.start();
