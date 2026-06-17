import type { HTMLAttributes } from "react";
import { forwardRef } from "react";

import { cn } from "@/lib/utils";

interface TriangleAlertIconProps extends HTMLAttributes<HTMLDivElement> {
	size?: number;
}

const TriangleAlertIcon = forwardRef<HTMLDivElement, TriangleAlertIconProps>(
	({ className, size = 28, ...props }, ref) => {
		return (
			<div className={cn(className)} ref={ref} {...props}>
				<svg
					fill="none"
					height={size}
					stroke="currentColor"
					strokeLinecap="round"
					strokeLinejoin="round"
					strokeWidth="2"
					viewBox="0 0 24 24"
					width={size}
					xmlns="http://www.w3.org/2000/svg"
				>
					<path d="M21.73 18a2 2 0 0 1-1.73 3H4a2 2 0 0 1-1.73-3l7.78-13.5a2 2 0 0 1 3.46 0Z" />
					<path d="M12 10.5v4" />
					<path d="M12 18h.01" />
				</svg>
			</div>
		);
	},
);

TriangleAlertIcon.displayName = "TriangleAlertIcon";

export { TriangleAlertIcon };
