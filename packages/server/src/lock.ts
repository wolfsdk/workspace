/** Runs jobs that share a key one after another, in the order they asked; jobs with different keys overlap. */
export class KeyedLock {
  private readonly tails = new Map<string, Promise<void>>();

  async run<T>(key: string, job: () => Promise<T>): Promise<T> {
    const previous = this.tails.get(key) ?? Promise.resolve();
    const gate = Promise.withResolvers<void>();
    const tail = previous.then(() => gate.promise);
    this.tails.set(key, tail);
    await previous;
    try {
      return await job();
    } finally {
      gate.resolve();
      if (this.tails.get(key) === tail) this.tails.delete(key);
    }
  }
}
