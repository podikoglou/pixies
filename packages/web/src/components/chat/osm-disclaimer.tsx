import { Alert, AlertDescription } from "@/components/ui/alert";
import { InfoIcon } from "@/components/icons";

export function OsmDisclaimer() {
	return (
		<Alert
			variant="info"
			className="mx-auto flex max-w-3xl items-center gap-2 rounded-none border-x-0 border-b-0 py-1.5"
		>
			<InfoIcon size={12} className="shrink-0" />
			<AlertDescription className="text-xs">
				{"© "}
				<a
					href="https://www.openstreetmap.org/copyright"
					target="_blank"
					rel="noopener noreferrer"
					className="text-primary underline"
				>
					OpenStreetMap contributors
				</a>
				. Data is community-maintained and may not always be up to date.
			</AlertDescription>
		</Alert>
	);
}
