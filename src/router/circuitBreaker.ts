/** In-memory circuit breaker with optional state persistence via an injected store. */

export type BreakerState = 'closed' | 'open' | 'halfOpen';

export interface PersistedBreaker {
  state: Exclude<BreakerState, 'halfOpen'>;
  openUntil: number;
}

export interface StateStore {
  get(key: string): PersistedBreaker | undefined;
  set(key: string, value: PersistedBreaker): void;
}

export interface BreakerOptions {
  failureThreshold: number;
  cooldownMs: number;
  now?: () => number;
  store?: StateStore;
  persistKey?: string;
}

export class CircuitBreaker {
  private state: BreakerState = 'closed';
  private failures = 0;
  private openUntil = 0;
  private halfOpenInFlight = false;
  private readonly failureThreshold: number;
  private readonly cooldownMs: number;
  private readonly now: () => number;
  private readonly store?: StateStore;
  private readonly persistKey?: string;

  constructor(opts: BreakerOptions) {
    this.failureThreshold = opts.failureThreshold;
    this.cooldownMs = opts.cooldownMs;
    this.now = opts.now ?? Date.now;
    this.store = opts.store;
    this.persistKey = opts.persistKey;
    if (opts.store && opts.persistKey) {
      const saved = opts.store.get(opts.persistKey);
      if (saved) {
        this.state = saved.state;
        this.openUntil = saved.openUntil;
        // Transition to halfOpen automatically once cooldown elapses (checked on canAttempt).
      }
    }
  }

  getState(): BreakerState {
    return this.state;
  }

  /** Whether a new attempt may proceed right now. */
  canAttempt(now?: number): boolean {
    const t = now ?? this.now();
    if (this.state === 'closed') return true;
    if (this.state === 'open') {
      if (t >= this.openUntil) {
        this.state = 'halfOpen';
        this.persist();
        return true;
      }
      return false;
    }
    // halfOpen: single probe — only allow one in flight.
    if (this.halfOpenInFlight) return false;
    return true;
  }

  beginProbe(): void {
    // A probe may start when the breaker was open but its cooldown elapsed;
    // canAttempt() normally performs this transition, but a direct probe must too.
    if (this.state === 'open' && this.now() >= this.openUntil) {
      this.state = 'halfOpen';
      this.persist();
    }
    if (this.state === 'halfOpen') this.halfOpenInFlight = true;
  }

  recordSuccess(): void {
    this.failures = 0;
    this.halfOpenInFlight = false;
    if (this.state !== 'closed') {
      this.state = 'closed';
      this.persist();
    }
  }

  recordFailure(): void {
    this.failures++;
    this.halfOpenInFlight = false;
    if (this.state === 'halfOpen') {
      // Half-open probe failed: immediately reopen with fresh cooldown.
      this.open();
      return;
    }
    if (this.state === 'open') return; // already open
    if (this.failures >= this.failureThreshold) {
      this.open();
    }
  }

  private open(): void {
    this.state = 'open';
    this.openUntil = this.now() + this.cooldownMs;
    this.persist();
  }

  private persist(): void {
    if (this.store && this.persistKey) {
      this.store.set(this.persistKey, { state: this.state === 'halfOpen' ? 'open' : this.state, openUntil: this.openUntil });
    }
  }
}
