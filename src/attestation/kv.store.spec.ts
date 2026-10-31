import { MemoryKvStore } from './kv.store.js';

describe('MemoryKvStore', () => {
  it('stores and returns a value', async () => {
    const kv = new MemoryKvStore();
    await kv.set('a', 'one');
    expect(await kv.get('a')).toBe('one');
  });

  it('returns null for an unknown key', async () => {
    expect(await new MemoryKvStore().get('missing')).toBeNull();
  });

  it('expires a value once its ttl has passed', async () => {
    const kv = new MemoryKvStore();
    await kv.set('a', 'one', 5);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(await kv.get('a')).toBeNull();
  });

  it('getDelete returns the value once, then nothing', async () => {
    const kv = new MemoryKvStore();
    await kv.set('a', 'one');
    expect(await kv.getDelete('a')).toBe('one');
    expect(await kv.getDelete('a')).toBeNull();
  });

  it('gives a value to only one concurrent getDelete caller', async () => {
    const kv = new MemoryKvStore();
    await kv.set('a', 'one');
    const values = await Promise.all([kv.getDelete('a'), kv.getDelete('a')]);
    expect(values.filter((value) => value !== null)).toEqual(['one']);
  });

  it('lets only one concurrent setIfAbsent caller win', async () => {
    const kv = new MemoryKvStore();
    const results = await Promise.all([
      kv.setIfAbsent('a', 'first'),
      kv.setIfAbsent('a', 'second'),
    ]);
    expect(results.filter(Boolean)).toHaveLength(1);
  });

  it('setIfAbsent refuses to overwrite an existing key', async () => {
    const kv = new MemoryKvStore();
    expect(await kv.setIfAbsent('a', 'first')).toBe(true);
    expect(await kv.setIfAbsent('a', 'second')).toBe(false);
    expect(await kv.get('a')).toBe('first');
  });

  it('setIfAbsent succeeds once the existing key has expired', async () => {
    const kv = new MemoryKvStore();
    await kv.set('a', 'first', 5);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(await kv.setIfAbsent('a', 'second')).toBe(true);
    expect(await kv.get('a')).toBe('second');
  });

  it('stays within its entry cap under sustained writes', async () => {
    const kv = new MemoryKvStore(10);
    for (let i = 0; i < 100; i++) {
      await kv.set(`key-${i}`, String(i), 60_000);
    }
    // The most recent write survives; the cap prevents unbounded growth.
    expect(await kv.get('key-99')).toBe('99');
    expect(await kv.get('key-0')).toBeNull();
  });
});
