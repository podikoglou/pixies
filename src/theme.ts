import { Chalk } from "chalk";
import type { EditorTheme, MarkdownTheme, SelectListTheme } from "@earendil-works/pi-tui";

const chalk = new Chalk({ level: 3 });

export const c = {
	accent: (s: string) => chalk.bold.cyan(s),
	muted: (s: string) => chalk.dim.gray(s),
	success: (s: string) => chalk.green(s),
	warning: (s: string) => chalk.yellow(s),
	error: (s: string) => chalk.red(s),
	user: (s: string) => chalk.blue(s),
	assistant: (s: string) => chalk.magenta(s),
	bold: (s: string) => chalk.bold(s),
} as const;

export const markdownTheme: MarkdownTheme = {
	heading: (t) => chalk.bold.cyan(t),
	link: (t) => chalk.blue(t),
	linkUrl: (t) => chalk.dim(t),
	code: (t) => chalk.yellow(t),
	codeBlock: (t) => chalk.green(t),
	codeBlockBorder: (t) => chalk.dim(t),
	quote: (t) => chalk.italic(t),
	quoteBorder: (t) => chalk.dim(t),
	hr: (t) => chalk.dim(t),
	listBullet: (t) => chalk.cyan(t),
	bold: (t) => chalk.bold(t),
	italic: (t) => chalk.italic(t),
	strikethrough: (t) => chalk.strikethrough(t),
	underline: (t) => chalk.underline(t),
};

export const selectListTheme: SelectListTheme = {
	selectedPrefix: (t) => chalk.blue(t),
	selectedText: (t) => chalk.bold(t),
	description: (t) => chalk.dim(t),
	scrollInfo: (t) => chalk.dim(t),
	noMatch: (t) => chalk.dim(t),
};

export const editorTheme: EditorTheme = {
	borderColor: (t) => chalk.dim(t),
	selectList: selectListTheme,
};
