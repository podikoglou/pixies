const HEARTBEAT_INTERVAL_MS = 15_000;

export type SseCloseHandler = () => void;

export class SseWriter {
	private controller?: ReadableStreamDefaultController<Uint8Array>;
	private heartbeat?: ReturnType<typeof setInterval>;
	private readonly stream: ReadableStream<Uint8Array>;
	private readonly encoder = new TextEncoder();

	constructor(onClose: SseCloseHandler) {
		this.stream = new ReadableStream<Uint8Array>({
			start: (controller) => {
				this.controller = controller;
				this.heartbeat = setInterval(() => this.writeRaw(": ping\n\n"), HEARTBEAT_INTERVAL_MS);
			},
			cancel: () => {
				if (this.heartbeat) clearInterval(this.heartbeat);
				this.controller = undefined;
				onClose();
			},
		});
	}

	get response(): Response {
		return new Response(this.stream, {
			headers: {
				"Content-Type": "text/event-stream",
				"Cache-Control": "no-cache",
				Connection: "keep-alive",
			},
		});
	}

	write(event: string, data: unknown): void {
		this.writeRaw(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
	}

	private writeRaw(chunk: string): void {
		this.controller?.enqueue(this.encoder.encode(chunk));
	}

	close(): void {
		if (this.heartbeat) clearInterval(this.heartbeat);
		try {
			this.controller?.close();
		} catch {
			// already closed
		}
		this.controller = undefined;
	}
}
