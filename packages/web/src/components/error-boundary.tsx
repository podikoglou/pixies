import { useCallback, type ErrorInfo, type ReactNode } from "react";
import { Component } from "react";
import { usePostHog } from "@posthog/react";
import type { PostHog } from "posthog-js";
import { captureReactError } from "@/lib/posthog-capture";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { TriangleAlertIcon } from "@/components/icons";

interface ErrorBoundaryProps {
	children: ReactNode;
	/** Rendered in place of children once an error has been caught. */
	fallback: ReactNode;
	/** Invoked with the error and React component stack. Optional. */
	onError?: (error: unknown, info: ErrorInfo) => void;
}

interface ErrorBoundaryState {
	hasError: boolean;
}

/**
 * Generic React error boundary: catches render-time crashes, renders a
 * fallback, and forwards the error via `onError`. Deliberately free of any
 * PostHog coupling so it stays reusable and side-effect free in tests.
 */
export class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
	override state: ErrorBoundaryState = { hasError: false };

	static getDerivedStateFromError(): ErrorBoundaryState {
		return { hasError: true };
	}

	override componentDidCatch(error: unknown, info: ErrorInfo): void {
		this.props.onError?.(error, info);
	}

	override render(): ReactNode {
		if (this.state.hasError) return this.props.fallback;
		return this.props.children;
	}
}

/**
 * Top-level fallback shown when a render crash escapes every child boundary.
 * Recovery is a full reload — a deterministic crash would otherwise re-throw on
 * any in-place reset.
 */
export function ErrorFallback() {
	return (
		<div className="flex h-dvh items-center justify-center p-6">
			<Alert variant="danger" className="flex max-w-md flex-col gap-3">
				<TriangleAlertIcon size={24} className="text-danger-foreground" />
				<AlertTitle>Something went wrong</AlertTitle>
				<AlertDescription>
					An unexpected error occurred. Reloading usually fixes it.
				</AlertDescription>
				<Button
					variant="default"
					size="sm"
					className="w-fit"
					onClick={() => window.location.reload()}
				>
					Reload
				</Button>
			</Alert>
		</div>
	);
}

/**
 * Error boundary wired to PostHog Error Tracking. Render crashes are forwarded
 * with their component stack when telemetry is on, and silently swallowed (the
 * fallback still shows) when it is off — `usePostHog()` returns `undefined` in
 * that case, which {@link captureReactError} no-ops on.
 */
export function PostHogErrorBoundary({ children }: { children: ReactNode }) {
	// Typed non-nullable by @posthog/react, but `undefined` at runtime when no
	// provider is mounted (telemetry off).
	const posthog = usePostHog() as PostHog | undefined;
	const onError = useCallback(
		(error: unknown, info: ErrorInfo) => {
			captureReactError(posthog, error, info.componentStack ?? "");
		},
		[posthog],
	);
	return (
		<ErrorBoundary fallback={<ErrorFallback />} onError={onError}>
			{children}
		</ErrorBoundary>
	);
}
