import { type ReactNode } from "react";
import {
	Accordion,
	AccordionContent,
	AccordionItem,
	AccordionTrigger,
} from "@/components/ui/accordion";
import { Badge } from "@/components/ui/badge";
import { ScrollArea } from "@/components/ui/scroll-area";
import { formatToolName } from "@/lib/format-tool-name";
import type { TimelineItem } from "@/state/chat-reducer";
import { JsonTree } from "./json-tree";
import { formatTime } from "@/lib/format-time";
import { StatusIcon } from "./status-icon";

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
	const isRunning = item.status === "running";
	const isError = item.status === "error";
	const isWarning = item.status === "warning";
	const entries = argEntries(item.args);
	const hasDetails = entries.length > 0 || item.resultText !== null;

	const parsedResult =
		item.result.kind === "query_osm" || item.result.kind === "geocode"
			? item.result.entries
			: item.result.kind === "reverse_geocode"
				? item.result.entry
				: null;

	const hasParsedResult = parsedResult !== null;

	const header: ReactNode = (
		<div className="flex min-w-0 items-center gap-2">
			<StatusIcon status={item.status} />
			<span className="text-foreground text-sm font-medium">{formatToolName(item.toolName)}</span>
			{isRunning ? (
				item.queued ? (
					<Badge variant="warning">queued</Badge>
				) : (
					<Badge variant="secondary">running</Badge>
				)
			) : isWarning ? (
				<Badge variant="warning">unavailable</Badge>
			) : isError ? (
				<Badge variant="danger">error</Badge>
			) : (
				<Badge variant="success">done</Badge>
			)}
		</div>
	);

	return (
		<div className="rounded-xl shadow-[var(--shadow-border)] transition-[box-shadow] hover:shadow-[var(--shadow-border-hover)]">
			{hasDetails ? (
				<Accordion>
					<AccordionItem value="details" className="border-b-0">
						<AccordionTrigger className="hover:no-underline px-4">{header}</AccordionTrigger>
						<AccordionContent className="px-4">
							<div className="border-border border-t pt-3">
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
									<div className={entries.length > 0 ? "mt-3" : ""}>
										{entries.length > 0 && (
											<div className="text-muted-foreground mb-1 font-mono text-xs">result</div>
										)}
										{hasParsedResult ? (
											<ScrollArea className="max-h-80">
												<JsonTree data={parsedResult} />
											</ScrollArea>
										) : (
											<ScrollArea className="max-h-60">
												<pre className="text-muted-foreground whitespace-pre-wrap font-mono text-xs">
													{item.resultText}
												</pre>
											</ScrollArea>
										)}
									</div>
								)}
							</div>
						</AccordionContent>
					</AccordionItem>
				</Accordion>
			) : (
				<div className="px-4 py-3">{header}</div>
			)}
			{item.responseTimeMs !== undefined && (
				<p className="text-muted-foreground px-4 pb-3 text-xs">{formatTime(item.responseTimeMs)}</p>
			)}
		</div>
	);
}
