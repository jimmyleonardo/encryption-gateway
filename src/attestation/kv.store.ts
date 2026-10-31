import { Logger } from '@nestjs/common';

/**
 * Minimal key/value port behind the attestation state. Challenges and enrolled
 * devices must survive across instances, so a serverless deployment (Vercel)
 * needs a shared backend; a single-instance deployment can use memory.
 */
export interface KvStore {
  /** Returns the stored value, or null when absent or expired. */
  get(key: string): Promise<string | null>;
  /** Stores a value, replacing any existing one. */
  set(key: string, value: string, ttlMs?: number): Promise<void>;
  /** Stores a value only when the key is absent. Returns false when it already exists. */
  setIfAbsent(key: string, value: string, ttlMs?: number): Promise<boolean>;
  /** Atomically returns and removes a value. Single-use challenges depend on this. */
  getDelete(key: string): Promise<string | null>;
  delete(key: string): Promise<boolean>;
}

export const KV_STORE = Symbol('KV_STORE');

/**
 * In-process store. Bounded so that unauthenticated challenge requests cannot
 * grow the heap without limit; the oldest entries are evicted once full.
 */
export class MemoryKvStore implements KvStore {
  private readonly entries = new Map<
    string,
    { value: string; expiresAt: number }
  >();

  constructor(private readonly maxEntries = 10_000) {}

  get(key: string): Promise<string | null> {
    return Promise.resolve(this.lookup(key));
  }

  set(key: string, value: string, ttlMs = Infinity): Promise<void> {
    this.write(key, value, ttlMs);
    return Promise.resolve();
  }

  /**
   * Check and write without yielding. An await between the two would let two
   * concurrent enrolments both observe the key as absent and overwrite one
   * another, which is exactly what setIfAbsent exists to prevent.
   */
  setIfAbsent(key: string, value: string, ttlMs = Infinity): Promise<boolean> {
    if (this.lookup(key) !== null) return Promise.resolve(false);
    this.write(key, value, ttlMs);
    return Promise.resolve(true);
  }

  /** Read and remove in one step, so a single-use challenge cannot be consumed twice. */
  getDelete(key: string): Promise<string | null> {
    const value = this.lookup(key);
    this.entries.delete(key);
    return Promise.resolve(value);
  }

  delete(key: string): Promise<boolean> {
    return Promise.resolve(this.entries.delete(key));
  }

  private lookup(key: string): string | null {
    const entry = this.entries.get(key);
    if (!entry) return null;
    if (Date.now() > entry.expiresAt) {
      this.entries.delete(key);
      return null;
    }
    return entry.value;
  }

  private write(key: string, value: string, ttlMs: number): void {
    this.entries.delete(key);
    this.evictIfFull();
    this.entries.set(key, { value, expiresAt: Date.now() + ttlMs });
  }

  /** Drops expired entries first, then the oldest insertion, to stay within the cap. */
  private evictIfFull(): void {
    if (this.entries.size < this.maxEntries) return;
    const now = Date.now();
    for (const [key, entry] of this.entries) {
      if (now > entry.expiresAt) this.entries.delete(key);
    }
    while (this.entries.size >= this.maxEntries) {
      const oldest = this.entries.keys().next();
      if (oldest.done) break;
      this.entries.delete(oldest.value);
    }
  }
}

/**
 * Upstash / Vercel KV over its REST API. HTTP rather than TCP, so it works from
 * serverless functions where connection pools do not survive between invocations.
 */
export class UpstashKvStore implements KvStore {
  private readonly logger = new Logger(UpstashKvStore.name);

  constructor(
    private readonly url: string,
    private readonly token: string,
    private readonly timeoutMs = 5_000,
  ) {}

  async get(key: string): Promise<string | null> {
    return this.command<string | null>(['GET', key]);
  }

  async set(key: string, value: string, ttlMs?: number): Promise<void> {
    const command = ['SET', key, value];
    if (ttlMs !== undefined && Number.isFinite(ttlMs)) {
      command.push('PX', String(Math.max(1, Math.round(ttlMs))));
    }
    await this.command(command);
  }

  async setIfAbsent(
    key: string,
    value: string,
    ttlMs?: number,
  ): Promise<boolean> {
    const command = ['SET', key, value];
    if (ttlMs !== undefined && Number.isFinite(ttlMs)) {
      command.push('PX', String(Math.max(1, Math.round(ttlMs))));
    }
    command.push('NX');
    return (await this.command<string | null>(command)) === 'OK';
  }

  async getDelete(key: string): Promise<string | null> {
    return this.command<string | null>(['GETDEL', key]);
  }

  async delete(key: string): Promise<boolean> {
    return (await this.command<number>(['DEL', key])) > 0;
  }

  private async command<T>(command: string[]): Promise<T> {
    const response = await fetch(this.url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(command),
      // A stalled KV must not hold an attestation request open forever.
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    if (!response.ok) {
      // The command may carry a nonce; log the verb only.
      this.logger.error(
        `KV command ${command[0]} failed with HTTP ${response.status}`,
      );
      throw new Error(`KV command failed with HTTP ${response.status}`);
    }
    const body = (await response.json()) as { result?: T; error?: string };
    if (body.error) {
      this.logger.error(`KV command ${command[0]} failed: ${body.error}`);
      throw new Error(`KV command failed: ${body.error}`);
    }
    return body.result as T;
  }
}
