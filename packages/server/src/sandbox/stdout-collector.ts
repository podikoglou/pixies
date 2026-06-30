/**
 * Bounds the model's own `print()` output per cell.
 *
 * The model habitually `print()`s the results it gets (`print(features)`),
 * which floods its context. Monty streams each formatted argument through the
 * JS `printCallback` as one fragment (`stdout_write` per arg, then `stdout_push`
 * for separators/newlines), with backpressure — so we can accumulate live and
 * cap cheaply: once the budget is spent, further fragments are counted but not
 * stored, and `finish()` appends a truncation marker.
 *
 * The marker is the load-bearing piece: a truncated `print(features)` shows
 * partial output, but the marker tells the model it saw a sliver and steers it
 * to `profile()` / `filter()` — the bounded inspection primitives that replace
 * row-peeks.
 */
export class StdoutCollector {
	private readonly parts: string[] = [];
	private stored = 0;
	private total = 0;
	private truncated = false;

	constructor(private readonly budget: number) {}

	/** Account for one print fragment. Cheap no-op once over budget (backpressure
	 *  means Monty still calls back; we just don't store). */
	push(text: string): void {
		this.total += text.length;
		if (this.truncated) return;
		const remaining = this.budget - this.stored;
		if (remaining <= 0) {
			// The budget is full, but truncation is a claim about CONTENT overflow
			// (total > budget), not about storage being full. An empty fragment
			// when stored == budget == total does not grow the total, so it must
			// not flip the marker on its own (else we emit "~0 chars omitted").
			if (this.total > this.budget) this.truncated = true;
			return;
		}
		if (text.length <= remaining) {
			this.parts.push(text);
			this.stored += text.length;
		} else {
			this.parts.push(text.slice(0, remaining));
			this.stored = this.budget;
			this.truncated = true;
		}
	}

	/** The bounded stdout, with a trailing truncation marker when over budget. */
	finish(): string {
		let out = this.parts.join("");
		if (this.truncated) {
			const omitted = this.total - this.stored;
			out += `\n[stdout truncated: ~${omitted} chars omitted — print less, or use profile()/filter() to inspect data]\n`;
		}
		return out;
	}
}
