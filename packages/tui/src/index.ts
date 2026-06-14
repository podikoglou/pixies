import {
	CombinedAutocompleteProvider,
	Container,
	Editor,
	Key,
	Markdown,
	ProcessTerminal,
	Spacer,
	TUI,
	Text,
	matchesKey,
} from "@earendil-works/pi-tui";
import { createAgent, MisconfigError, readConfigFromEnv } from "@pixies/core";
import { c, editorTheme, markdownTheme } from "./theme.ts";
import { StatusBar } from "./ui/status-bar.ts";
import { createAgentEventHandler } from "./agent-events.ts";
import { wireCommands } from "./commands.ts";

let agent;
try {
	agent = createAgent({ config: readConfigFromEnv() });
} catch (e) {
	if (e instanceof MisconfigError) {
		console.error(`Configuration error: ${e.message}`);
		process.exit(1);
	}
	throw e;
}

const WELCOME = `pixies — OSM agent

Ask me anything about places. Try:
  • vegan cafés near camden
  • how many bus stops in manchester
  • nearest 24/7 pharmacy to the eiffel tower

Type / for commands. Ctrl+C to exit.`;

const terminal = new ProcessTerminal();
const tui = new TUI(terminal);

const status = new StatusBar({
	appName: "pixies",
	model: agent.state.model.name,
	location: null,
	status: null,
});
tui.addChild(status);
tui.addChild(new Spacer(1));

const chat = new Container();
chat.addChild(new Text(WELCOME, 1, 0));
chat.addChild(new Spacer(1));
tui.addChild(chat);
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

function addAssistantText(text: string): void {
	chat.addChild(new Text(c.assistant("assistant"), 1, 0));
	chat.addChild(new Markdown(text, 1, 0, markdownTheme));
	chat.addChild(new Spacer(1));
	tui.requestRender();
}

agent.subscribe(createAgentEventHandler({ chat, tui }));

wireCommands({ agent, chat, tui, editor, status, respond: addAssistantText });

tui.addInputListener((data: string) => {
	if (matchesKey(data, Key.ctrl("c"))) {
		if (agent.state.isStreaming) {
			agent.abort();
		} else {
			tui.stop();
			process.exit(0);
		}
		return undefined;
	}
	return undefined;
});

tui.start();
