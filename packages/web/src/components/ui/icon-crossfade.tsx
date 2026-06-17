import { Children, type ReactNode } from "react";
import { cn } from "@/lib/utils";

interface IconCrossfadeProps {
	children: ReactNode;
	activeIndex: number;
	slotClassNames?: (string | undefined)[];
}

export function IconCrossfade({ children, activeIndex, slotClassNames }: IconCrossfadeProps) {
	return (
		<span className="relative flex size-4 items-center justify-center">
			{Children.map(children, (child, i) => (
				<span
					className={cn(
						"absolute inset-0 flex items-center justify-center transition-all duration-200 ease-out",
						i === activeIndex ? "scale-100 opacity-100" : "scale-75 opacity-0",
						slotClassNames?.[i],
					)}
				>
					{child}
				</span>
			))}
		</span>
	);
}
