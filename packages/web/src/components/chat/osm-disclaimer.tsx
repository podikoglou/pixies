import { InfoIcon } from "@/components/icons";

export function OsmDisclaimer() {
	return (
		<div className="mx-auto flex max-w-3xl items-center gap-1.5 px-4 py-1.5">
			<InfoIcon size={12} className="text-muted-foreground shrink-0" />
			<p className="text-muted-foreground text-xs">
				OpenStreetMap data is community-maintained and may not always be up to date.
			</p>
		</div>
	);
}
