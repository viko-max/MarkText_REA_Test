import { describe, expect, it } from 'vitest';
import { SerialQueue } from '../src/renderer/src/editor/queue';

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

describe('SerialQueue', () => {
  it('runs tasks in submission order, never overlapping', async () => {
    const queue = new SerialQueue();
    const log: string[] = [];

    const first = queue.run(async () => {
      log.push('first-start');
      await delay(15);
      log.push('first-end');
      return 1;
    });
    const second = queue.run(async () => {
      log.push('second-start');
      await delay(1);
      log.push('second-end');
      return 2;
    });

    await expect(Promise.all([first, second])).resolves.toEqual([1, 2]);
    expect(log).toEqual(['first-start', 'first-end', 'second-start', 'second-end']);
  });

  it('keeps running after a rejected task', async () => {
    const queue = new SerialQueue();
    const failed = queue.run(async () => {
      throw new Error('boom');
    });
    const recovered = queue.run(async () => 'ok');

    await expect(failed).rejects.toThrow('boom');
    await expect(recovered).resolves.toBe('ok');
  });

  it('serialises a save race: the second task sees the first committed value', async () => {
    const queue = new SerialQueue();
    let diskHash = 'a'.repeat(64);

    const save = (nextHash: string, baseHash: string) =>
      queue.run(async () => {
        await delay(5);
        if (baseHash !== diskHash) return 'conflict';
        diskHash = nextHash;
        return 'saved';
      });

    const first = save('b'.repeat(64), 'a'.repeat(64));
    const second = save('c'.repeat(64), 'a'.repeat(64));
    await expect(first).resolves.toBe('saved');
    await expect(second).resolves.toBe('conflict');
    expect(diskHash).toBe('b'.repeat(64));
  });
});
