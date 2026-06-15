import Markdown, { type Components } from "react-markdown";
import rehypeHighlight from "rehype-highlight";
import { cn } from "@/lib/utils";

interface AssistantMessageProps {
	text: string;
	streaming?: boolean;
}

const components: Components = {
	h1: ({ children }) => <h1 className="mt-4 mb-2 text-2xl font-semibold">{children}</h1>,
	h2: ({ children }) => <h2 className="mt-4 mb-2 text-xl font-semibold">{children}</h2>,
	h3: ({ children }) => <h3 className="mt-3 mb-2 text-lg font-semibold">{children}</h3>,
	h4: ({ children }) => <h4 className="mt-3 mb-2 text-base font-semibold">{children}</h4>,
	p: ({ children }) => <p className="mb-3 leading-relaxed last:mb-0">{children}</p>,
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
	hr: () => <hr className="border-border my-4" />,
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
		<div className="mb-3 overflow-x-auto">
			<table className="border-border w-full border-collapse text-sm">{children}</table>
		</div>
	),
	thead: ({ children }) => <thead className="bg-muted">{children}</thead>,
	th: ({ children }) => (
		<th className="border-border border px-3 py-1.5 text-left font-semibold">{children}</th>
	),
	td: ({ children }) => <td className="border-border border px-3 py-1.5">{children}</td>,
};

export function AssistantMessage({ text, streaming }: AssistantMessageProps) {
	return (
		<div className="text-foreground w-full text-sm">
			<Markdown components={components} rehypePlugins={[rehypeHighlight]}>
				{text}
			</Markdown>
			{streaming && (
				<span className="bg-foreground ml-0.5 inline-block h-4 w-2 animate-pulse rounded-sm align-text-bottom" />
			)}
		</div>
	);
}
