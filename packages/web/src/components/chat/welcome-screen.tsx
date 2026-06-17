import { CompassIcon } from "@/components/icons";
import { Button } from "@/components/ui/button";

const WELCOME_EXAMPLES = [
	"vegan cafés near camden",
	"how many bus stops in manchester",
	"nearest 24/7 pharmacy to the eiffel tower",
];

interface WelcomeScreenProps {
	onExampleClick: (text: string) => void;
}

export function WelcomeScreen({ onExampleClick }: WelcomeScreenProps) {
	return (
		<div className="mx-auto flex max-w-3xl flex-col items-center gap-6 px-4 py-16 text-center">
			<CompassIcon size={32} className="text-muted-foreground" />
			<p className="text-muted-foreground text-pretty text-sm">
				Ask me anything about places. Try:
			</p>
			<div className="flex w-full flex-col gap-2">
				{WELCOME_EXAMPLES.map((example) => (
					<Button
						key={example}
						variant="outline"
						type="button"
						onClick={() => onExampleClick(example)}
						className="w-full justify-start font-normal"
					>
						{example}
					</Button>
				))}
			</div>
		</div>
	);
}
