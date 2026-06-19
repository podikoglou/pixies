import { useEffect, useRef } from "react";
import {
	CheckIcon,
	LoaderCircleIcon,
	type LoaderCircleIconHandle,
	TriangleAlertIcon,
	XIcon,
} from "@/components/icons";
import { IconCrossfade } from "@/components/ui/icon-crossfade";

interface StatusIconProps {
	status: "running" | "done" | "error" | "warning";
}

export function StatusIcon({ status }: StatusIconProps) {
	const loaderRef = useRef<LoaderCircleIconHandle>(null);

	useEffect(() => {
		if (status === "running") {
			loaderRef.current?.startAnimation();
		} else {
			loaderRef.current?.stopAnimation();
		}
	}, [status]);

	const activeIndex =
		status === "running" ? 0 : status === "done" ? 1 : status === "warning" ? 2 : 3;

	return (
		<IconCrossfade activeIndex={activeIndex}>
			<LoaderCircleIcon ref={loaderRef} size={16} className="text-muted-foreground" />
			<CheckIcon size={16} className="text-emerald-500 dark:text-emerald-400" />
			<TriangleAlertIcon size={16} className="text-warning" />
			<XIcon size={16} className="text-destructive" />
		</IconCrossfade>
	);
}
