import { useState } from "react";
import { ChevronRight } from "lucide-react";
import { cn } from "@/lib/utils";

interface JsonTreeProps {
	data: unknown;
	label?: string;
	maxPreviewLength?: number;
}

function typeOf(value: unknown): "object" | "array" | "string" | "number" | "boolean" | "null" {
	if (value === null) return "null";
	if (Array.isArray(value)) return "array";
	return typeof value as "object" | "string" | "number" | "boolean";
}

function valuePreview(value: unknown, maxLen: number): string {
	switch (typeOf(value)) {
		case "string":
			const str = value as string;
			return str.length > maxLen ? `"${str.slice(0, maxLen)}…"` : `"${str}"`;
		case "number":
		case "boolean":
			return String(value);
		case "null":
			return "null";
		default:
			return "";
	}
}

function colorClass(t: ReturnType<typeof typeOf>): string {
	switch (t) {
		case "string":
			return "text-emerald-600 dark:text-emerald-400";
		case "number":
			return "text-sky-600 dark:text-sky-400";
		case "boolean":
			return "text-violet-600 dark:text-violet-400";
		case "null":
			return "text-muted-foreground";
		default:
			return "text-foreground";
	}
}

function PrimitiveValue({
	value,
	maxPreviewLength = 200,
}: {
	value: unknown;
	maxPreviewLength?: number;
}) {
	const t = typeOf(value);
	return (
		<span className={cn("font-mono text-xs", colorClass(t))}>
			{valuePreview(value, maxPreviewLength)}
		</span>
	);
}

function previewEntries(value: Record<string, unknown> | unknown[], count: number): string {
	if (Array.isArray(value)) {
		const items = value.slice(0, count);
		const parts = items.map((v) => valuePreview(v, 40));
		const more = value.length > count ? `, …${value.length - count} more` : "";
		return `[${parts.join(", ")}${more}]`;
	}
	const keys = Object.keys(value).slice(0, count);
	const parts = keys.map((k) => {
		const v = value[k];
		return `${k}: ${valuePreview(v, 30)}`;
	});
	const more =
		Object.keys(value).length > count ? `, …${Object.keys(value).length - count} more` : "";
	return `{${parts.join(", ")}${more}}`;
}

function CollapsibleNode({
	label,
	value,
	nested,
	defaultExpanded,
	maxPreviewLength,
}: {
	label?: string;
	value: Record<string, unknown> | unknown[];
	nested: number;
	defaultExpanded?: boolean;
	maxPreviewLength: number;
}) {
	const [expanded, setExpanded] = useState(defaultExpanded ?? nested < 1);
	const isArr = Array.isArray(value);
	const count = isArr ? value.length : Object.keys(value).length;
	const typeLabel = isArr ? `(${count})` : `(${count})`;

	return (
		<div className="min-w-0">
			<button
				type="button"
				onClick={() => setExpanded((e) => !e)}
				className="hover:bg-muted/50 flex w-full items-start gap-1 rounded px-0.5 py-0.5 text-left transition-colors"
			>
				<ChevronRight
					className={cn(
						"mt-0.5 size-3.5 shrink-0 text-muted-foreground transition-transform",
						expanded && "rotate-90",
					)}
				/>
				<div className="min-w-0 flex-1">
					{label !== undefined && (
						<span className="text-foreground font-mono text-xs font-medium">{label}: </span>
					)}
					<span className="text-muted-foreground font-mono text-xs">
						{isArr ? "Array" : "Object"} {typeLabel}
					</span>
					{!expanded && (
						<span className="text-muted-foreground/70 ml-1 font-mono text-xs break-all">
							{previewEntries(value, 2)}
						</span>
					)}
				</div>
			</button>
			{expanded && (
				<div className="ml-[18px] border-l border-border/60 pl-2">
					{isArr
						? value.map((v, i) => (
								<JsonNode
									key={i}
									label={String(i)}
									data={v}
									nested={nested + 1}
									maxPreviewLength={maxPreviewLength}
								/>
							))
						: Object.entries(value).map(([k, v]) => (
								<JsonNode
									key={k}
									label={k}
									data={v}
									nested={nested + 1}
									maxPreviewLength={maxPreviewLength}
								/>
							))}
				</div>
			)}
		</div>
	);
}

function JsonNode({
	label,
	data,
	nested,
	maxPreviewLength,
}: {
	label?: string;
	data: unknown;
	nested: number;
	maxPreviewLength: number;
}) {
	const t = typeOf(data);

	if (t === "object" || t === "array") {
		const obj = data as Record<string, unknown> | unknown[];
		if (obj !== null && (Array.isArray(obj) ? obj.length : Object.keys(obj).length) === 0) {
			return (
				<div className="flex items-center gap-1 px-0.5 py-0.5">
					{label !== undefined && (
						<span className="text-foreground font-mono text-xs font-medium">{label}: </span>
					)}
					<span className="text-muted-foreground font-mono text-xs">
						{Array.isArray(obj) ? "[]" : "{}"}
					</span>
				</div>
			);
		}
		return (
			<CollapsibleNode
				label={label}
				value={obj}
				nested={nested}
				maxPreviewLength={maxPreviewLength}
			/>
		);
	}

	return (
		<div className="flex items-start gap-1 px-0.5 py-0.5">
			<span className="w-[18px] shrink-0" />
			{label !== undefined && (
				<span className="text-foreground font-mono text-xs font-medium">{label}: </span>
			)}
			<PrimitiveValue value={data} maxPreviewLength={maxPreviewLength} />
		</div>
	);
}

export function JsonTree({ data, label, maxPreviewLength = 200 }: JsonTreeProps) {
	const t = typeOf(data);

	if (t === "object" || t === "array") {
		const obj = data as Record<string, unknown> | unknown[];
		const count = Array.isArray(obj) ? obj.length : Object.keys(obj).length;
		if (count === 0) {
			return (
				<span className="text-muted-foreground font-mono text-xs">
					{Array.isArray(obj) ? "[]" : "{}"}
				</span>
			);
		}
		return <JsonNode label={label} data={data} nested={0} maxPreviewLength={maxPreviewLength} />;
	}

	return (
		<div className="flex items-start gap-1 py-0.5">
			{label !== undefined && (
				<span className="text-foreground font-mono text-xs font-medium">{label}: </span>
			)}
			<PrimitiveValue value={data} maxPreviewLength={maxPreviewLength} />
		</div>
	);
}

export type { JsonTreeProps };
