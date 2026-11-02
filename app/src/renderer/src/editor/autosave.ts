/**
 * Debounced autosave timer.
 *
 * The timer only decides *when* to call the same save chain a manual save
 * uses; it never writes files itself and never clears dirty state.
 */

export type TimerHandle = ReturnType<typeof setTimeout>;

export interface TimerApi {
  setTimeout(callback: () => void, delayMs: number): TimerHandle;
  clearTimeout(handle: TimerHandle): void;
}

export const defaultTimerApi: TimerApi = {
  setTimeout: (callback, delayMs) => setTimeout(callback, delayMs),
  clearTimeout: (handle) => clearTimeout(handle),
};

export class AutosaveDebouncer {
  private handle: TimerHandle | null = null;

  constructor(
    private readonly delayMs: number,
    private readonly onFire: () => void,
    private readonly timers: TimerApi = defaultTimerApi,
  ) {}

  get pending(): boolean {
    return this.handle !== null;
  }

  get delay(): number {
    return this.delayMs;
  }

  schedule(): void {
    this.cancel();
    this.handle = this.timers.setTimeout(() => {
      this.handle = null;
      this.onFire();
    }, this.delayMs);
  }

  cancel(): void {
    if (this.handle === null) return;
    this.timers.clearTimeout(this.handle);
    this.handle = null;
  }

  /** Fire immediately if a save is pending. */
  flush(): void {
    if (this.handle === null) return;
    this.cancel();
    this.onFire();
  }
}
