/** Serialises asynchronous work per key (one document save queue). */
export class SerialQueue {
  private tail: Promise<void> = Promise.resolve();

  /**
   * Run `task` after every previously queued task has settled. A rejected task
   * never blocks the queue: the tail is normalised to a resolved promise.
   */
  run<T>(task: () => Promise<T>): Promise<T> {
    const result = this.tail.then(task, task);
    this.tail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }
}
