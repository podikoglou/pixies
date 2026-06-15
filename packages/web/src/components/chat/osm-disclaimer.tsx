import { Alert, AlertDescription } from "@/components/ui/alert";
import { InfoIcon } from "@/components/icons";

export function OsmDisclaimer() {
	return (
		<Alert variant="info" className="mx-auto max-w-3xl rounded-none border-x-0 border-b-0">
			<InfoIcon />
			<AlertDescription>
				OpenStreetMap data is community-maintained and may not always be up to date.
			</AlertDescription>
		</Alert>
	);
}
