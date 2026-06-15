import { useMemo, useState } from "react";
import { Check, ChevronRight, Loader2, X } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Card } from "@/components/ui/card";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { formatToolName } from "@/lib/format-tool-name";
import { parseToolResult } from "@/lib/parse-tool-result";
import { cn } from "@/lib/utils";
import type { TimelineItem } from "@/state/chat-reducer";
import { JsonTree } from "./json-tree";

type ToolCallItem = Extract<TimelineItem, { kind: "tool-call" }>;

interface ToolCallCardProps {
	item: ToolCallItem;
}

function argEntries(args: unknown): [string, unknown][] {
	if (typeof args !== "object" || args === null || Array.isArray(args)) return [];
	return Object.entries(args as Record<string, unknown>);
}

function formatValue(value: unknown): string {
	if (typeof value === "string") return value;
	try {
		return JSON.stringify(value) ?? String(value);
	} catch {
		return String(value);
	}
}

function isLongValue(value: unknown): boolean {
	return typeof value === "string" && value.length > 80;
}

export function ToolCallCard({ item }: ToolCallCardProps) {
	const [open, setOpen] = useState(false);
	const isRunning = item.status === "running";
	const isError = item.status === "error";
	const entries = argEntries(item.args);
	const hasDetails = entries.length > 0 || item.resultText !== null;

	const parsedResult = useMemo(() => {
		if (!item.resultText || isError) return undefined;
		return parseToolResult(item.toolName, item.resultText);
	}, [item.resultText, item.toolName, isError]);

	const hasParsedResult =
		parsedResult !== null && parsedResult !== undefined && parsedResult !== item.resultText;

	return (
		<Card className="gap-0 py-0 shadow-none">
			<Collapsible open={open} onOpenChange={setOpen}>
				<div className="flex items-center gap-2 px-4 py-3">
					<StatusIcon status={item.status} />
					<span className="text-foreground text-sm font-medium">
						{formatToolName(item.toolName)}
					</span>
					{isRunning ? (
						item.queued ? (
							<Badge variant="warning">queued</Badge>
						) : (
							<Badge variant="secondary">running</Badge>
						)
					) : isError ? (
						<Badge variant="danger">error</Badge>
					) : (
						<Badge variant="success">done</Badge>
					)}
					{!isRunning && item.summary && (
						<span className="text-muted-foreground truncate text-xs">{item.summary}</span>
					)}
					{hasDetails && (
						<CollapsibleTrigger
							className={cn(
								"text-muted-foreground hover:text-foreground ml-auto inline-flex items-center gap-1 text-xs transition-colors",
							)}
						>
							<ChevronRight className={cn("size-3.5 transition-transform", open && "rotate-90")} />
							details
						</CollapsibleTrigger>
					)}
				</div>
				{hasDetails && (
					<CollapsibleContent>
						<div className="border-border border-t px-4 py-3">
							{entries.length > 0 && (
								<dl className="space-y-1.5">
									{entries.map(([key, value]) => (
										<div key={key} className="font-mono text-xs">
											<dt className="text-muted-foreground inline">{key}: </dt>
											{isLongValue(value) ? (
												<dd className="text-foreground/80 mt-1 block overflow-x-auto whitespace-pre-wrap break-all rounded bg-muted/40 p-2">
													{formatValue(value)}
												</dd>
											) : (
												<dd className="text-foreground/80 inline break-all">
													{formatValue(value)}
												</dd>
											)}
										</div>
									))}
								</dl>
							)}
							{item.resultText && (
								<div className={cn(entries.length > 0 && "mt-3")}>
									{entries.length > 0 && (
										<div className="text-muted-foreground mb-1 font-mono text-xs">result</div>
									)}
									{hasParsedResult ? (
										<div className="max-h-80 overflow-auto py-0.5">
											<JsonTree data={parsedResult} />
										</div>
									) : (
										<pre className="text-muted-foreground max-h-60 overflow-auto whitespace-pre-wrap font-mono text-xs">
											{item.resultText}
										</pre>
									)}
								</div>
							)}
						</div>
					</CollapsibleContent>
				)}
			</Collapsible>
		</Card>
	);
}

function StatusIcon({ status }: { status: "running" | "done" | "error" }) {
	if (status === "running")
		return <Loader2 className="text-muted-foreground size-4 animate-spin" />;
	if (status === "error") return <X className="text-destructive size-4" />;
	return <Check className="text-success-foreground size-4" />;
}
