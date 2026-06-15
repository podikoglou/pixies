import type { HTMLAttributes } from "react";

interface InfoIconProps extends HTMLAttributes<HTMLDivElement> {
	size?: number;
}

function InfoIcon({ className, size = 16, ...props }: InfoIconProps) {
	return (
		<div className={className} {...props}>
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
				<circle cx="12" cy="12" r="10" />
				<path d="M12 16v-4" />
				<path d="M12 8h.01" />
			</svg>
		</div>
	);
}

export { InfoIcon };
