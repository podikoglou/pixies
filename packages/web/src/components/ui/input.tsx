import * as React from "react";

import { cn } from "@/lib/utils";

function Input({ className, disabled, ...props }: React.ComponentProps<"input">) {
	return (
		<input
			data-slot="input"
			className={cn(
				"placeholder:text-muted-foreground hover:border-ring/70 focus-visible:border-ring focus-visible:ring-ring/50 aria-invalid:ring-destructive/50 aria-invalid:border-destructive bg-input flex h-9 w-full rounded-md border px-3 py-1 text-base shadow-xs transition-all duration-200 outline-none focus-visible:ring-[3px] data-disabled:pointer-events-none data-disabled:opacity-50 md:text-sm",
				className,
			)}
			data-disabled={disabled}
			disabled={disabled}
			{...props}
		/>
	);
}

export { Input };
