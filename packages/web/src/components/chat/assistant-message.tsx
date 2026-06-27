import Markdown, { type Components } from "react-markdown";
import rehypeHighlight from "rehype-highlight";
import remarkGfm from "remark-gfm";
import { Separator } from "@/components/ui/separator";
import {
	Table,
	TableBody,
	TableCell,
	TableHead,
	TableHeader,
	TableRow,
} from "@/components/ui/table";
import { formatTime } from "@/lib/format-time";
import { cn } from "@/lib/utils";

interface AssistantMessageProps {
	text: string;
	streaming?: boolean;
	responseTimeMs?: number;
}

const components: Components = {
	h1: ({ children }) => (
		<h1 className="mt-4 mb-2 first:mt-0 text-balance text-2xl font-semibold">{children}</h1>
	),
	h2: ({ children }) => (
		<h2 className="mt-4 mb-2 first:mt-0 text-balance text-xl font-semibold">{children}</h2>
	),
	h3: ({ children }) => (
		<h3 className="mt-3 mb-2 first:mt-0 text-balance text-lg font-semibold">{children}</h3>
	),
	h4: ({ children }) => (
		<h4 className="mt-3 mb-2 first:mt-0 text-balance text-base font-semibold">{children}</h4>
	),
	p: ({ children }) => <p className="text-pretty mb-3 leading-relaxed last:mb-0">{children}</p>,
	ul: ({ children }) => <ul className="mb-3 ml-6 list-disc space-y-1">{children}</ul>,
	ol: ({ children }) => <ol className="mb-3 ml-6 list-decimal space-y-1">{children}</ol>,
	li: ({ children }) => <li className="mb-1">{children}</li>,
	a: ({ children, href }) => (
		<a href={href} target="_blank" rel="noopener noreferrer" className="text-primary underline">
			{children}
		</a>
	),
	blockquote: ({ children }) => (
		<blockquote className="mb-3 border-border border-l-2 pl-4 italic">{children}</blockquote>
	),
	strong: ({ children }) => <strong className="font-semibold">{children}</strong>,
	em: ({ children }) => <em className="italic">{children}</em>,
	hr: () => <Separator className="my-4" />,
	pre: ({ children }) => (
		<pre className="bg-muted/50 mb-3 overflow-x-auto rounded-lg p-4">{children}</pre>
	),
	code: ({ className, children, node: _node, ...props }) => {
		const isBlock = typeof className === "string" && className.includes("language-");
		if (isBlock)
			return (
				<code className={cn("font-mono text-sm", className)} {...props}>
					{children}
				</code>
			);
		return (
			<code className="bg-muted rounded px-1.5 py-0.5 font-mono text-sm" {...props}>
				{children}
			</code>
		);
	},
	table: ({ children }) => (
		<div className="mb-3">
			<Table>{children}</Table>
		</div>
	),
	thead: ({ children }) => <TableHeader>{children}</TableHeader>,
	tbody: ({ children }) => <TableBody>{children}</TableBody>,
	tr: ({ children }) => <TableRow>{children}</TableRow>,
	th: ({ children }) => <TableHead>{children}</TableHead>,
	td: ({ children }) => <TableCell>{children}</TableCell>,
};

export function AssistantMessage({ text, streaming, responseTimeMs }: AssistantMessageProps) {
	return (
		<div className="text-foreground w-full min-w-0 break-words overflow-hidden text-sm">
			<Markdown
				components={components}
				rehypePlugins={[rehypeHighlight]}
				remarkPlugins={[remarkGfm]}
			>
				{text}
			</Markdown>
			{responseTimeMs !== undefined && (
				<p className="text-muted-foreground mt-1 text-xs">{formatTime(responseTimeMs)}</p>
			)}
			{streaming && (
				<span className="bg-foreground ml-0.5 inline-block h-4 w-2 animate-pulse rounded-sm align-text-bottom" />
			)}
		</div>
	);
}
