function boundedCount(value: number): number {
	return Number.isFinite(value) ? Math.max(0, Math.floor(value)) : 0;
}

function integer(value: number): number {
	return Number.isFinite(value) ? Math.trunc(value) : 0;
}

function clamp(value: number, minimum: number, maximum: number): number {
	return Math.min(maximum, Math.max(minimum, value));
}

export interface ViewportRange {
	start: number;
	end: number;
}

/** Mutable scroll state independent of rendering and input bindings. */
export class ScrollViewportState {
	offset = 0;
	pageSize = 0;
	contentLength = 0;
	followEnd = false;

	update(contentLength: number, pageSize: number): ViewportRange {
		this.contentLength = boundedCount(contentLength);
		this.pageSize = boundedCount(pageSize);
		this.clampOffset();
		return this.range;
	}

	get range(): ViewportRange {
		return {
			start: this.offset,
			end: Math.min(this.contentLength, this.offset + this.pageSize),
		};
	}

	get maxOffset(): number {
		return Math.max(0, this.contentLength - this.pageSize);
	}

	get hasOverflow(): boolean {
		return this.contentLength > this.pageSize;
	}

	scrollBy(delta: number): ViewportRange {
		this.followEnd = false;
		this.offset += integer(delta);
		this.clampOffset();
		return this.range;
	}

	pageBy(delta: number): ViewportRange {
		return this.scrollBy(integer(delta) * Math.max(1, this.pageSize));
	}

	home(): ViewportRange {
		this.followEnd = false;
		this.offset = 0;
		return this.range;
	}

	end(follow = true): ViewportRange {
		this.followEnd = follow;
		this.offset = this.maxOffset;
		return this.range;
	}

	reveal(index: number): ViewportRange {
		this.followEnd = false;
		if (this.pageSize === 0 || this.contentLength === 0) return this.range;
		const target = clamp(integer(index), 0, this.contentLength - 1);
		if (target < this.offset) this.offset = target;
		else if (target >= this.offset + this.pageSize) this.offset = target - this.pageSize + 1;
		this.clampOffset();
		return this.range;
	}

	private clampOffset(): void {
		this.offset = this.followEnd ? this.maxOffset : clamp(this.offset, 0, this.maxOffset);
	}
}

/** Selection state that keeps the selected item inside a bounded viewport. */
export class SelectableViewportState {
	selected = 0;
	readonly viewport = new ScrollViewportState();

	constructor(selected = 0) {
		this.selected = boundedCount(selected);
	}

	update(itemCount: number, pageSize: number): ViewportRange {
		const count = boundedCount(itemCount);
		this.selected = count === 0 ? 0 : clamp(this.selected, 0, count - 1);
		this.viewport.update(count, pageSize);
		return count === 0 ? this.viewport.range : this.viewport.reveal(this.selected);
	}

	moveBy(delta: number, itemCount: number): number {
		const count = boundedCount(itemCount);
		this.selected = count === 0 ? 0 : clamp(this.selected + integer(delta), 0, count - 1);
		this.viewport.reveal(this.selected);
		return this.selected;
	}

	pageBy(delta: number, itemCount: number): number {
		return this.moveBy(integer(delta) * Math.max(1, this.viewport.pageSize), itemCount);
	}

	home(): number {
		this.selected = 0;
		this.viewport.reveal(this.selected);
		return this.selected;
	}

	end(itemCount: number): number {
		this.selected = Math.max(0, boundedCount(itemCount) - 1);
		this.viewport.reveal(this.selected);
		return this.selected;
	}
}

/** Naming aliases for screens that model these objects as input controllers. */
export class ScrollViewportController extends ScrollViewportState {}
export class SelectableViewportController extends SelectableViewportState {}
