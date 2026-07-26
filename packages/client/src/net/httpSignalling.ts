/**
 * `Signalling` over HTTP, talking to the Worker in `workers/signal`.
 *
 * Plain `fetch` against a handful of endpoints, with retries on the two failures that
 * are actually transient: a cold Worker and a lost request. Everything else -- a bad
 * code, an expired room, a room that is full -- is reported straight through, because
 * retrying those just makes the player wait longer to be told the same thing.
 *
 * Note the base URL is configurable and can be empty. With no signalling server
 * configured the game simply has no online mode, which is the correct behaviour for a
 * static build somebody opened from a file: the LAN and single-device paths still work.
 */

import {
  SignallingError,
  type PendingOffer,
  type PollAnswerResponse,
  type PollOffersResponse,
  type PostOfferResponse,
  type SessionDescription,
  type Signalling,
  type CreateRoomResponse,
  type ErrorResponse,
} from '@snow/shared';

export interface HttpSignallingOptions {
  /** Worker origin, e.g. `https://snowball-signal.you.workers.dev`. */
  baseUrl: string;
  /** Per-request timeout. A signalling call that takes this long has failed. */
  timeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 8000;
/** Only the transient failures are retried, and only a couple of times. */
const RETRIES = 2;

export class HttpSignalling implements Signalling {
  constructor(private readonly opts: HttpSignallingOptions) {}

  async createRoom(name: string): Promise<{ code: string; hostToken: string }> {
    return this.call<CreateRoomResponse>('POST', '/room', { name });
  }

  async pollOffers(code: string, hostToken: string): Promise<PendingOffer[]> {
    const res = await this.call<PollOffersResponse>(
      'GET',
      `/room/${code}/offers`,
      undefined,
      hostToken,
    );
    return res.offers ?? [];
  }

  async postAnswer(
    code: string,
    hostToken: string,
    peerId: string,
    answer: SessionDescription,
  ): Promise<void> {
    await this.call('POST', `/room/${code}/answer`, { peerId, answer }, hostToken);
  }

  async postOffer(
    code: string,
    name: string,
    offer: SessionDescription,
  ): Promise<{ peerId: string }> {
    return this.call<PostOfferResponse>('POST', `/room/${code}/offer`, { name, offer });
  }

  async pollAnswer(code: string, peerId: string): Promise<SessionDescription | null> {
    const res = await this.call<PollAnswerResponse>(
      'GET',
      `/room/${code}/answer?peerId=${encodeURIComponent(peerId)}`,
    );
    return res.answer ?? null;
  }

  async closeRoom(code: string, hostToken: string): Promise<void> {
    // Best-effort: a host closing the tab is the common case, and failing loudly about
    // a room that will expire on its own in twenty minutes helps nobody.
    await this.call('POST', `/room/${code}/close`, {}, hostToken).catch(() => undefined);
  }

  private async call<T>(
    method: 'GET' | 'POST',
    path: string,
    body?: unknown,
    hostToken?: string,
  ): Promise<T> {
    if (!this.opts.baseUrl) throw new SignallingError('no signalling server configured');

    let lastError: Error = new SignallingError('signalling failed', true);
    for (let attempt = 0; attempt <= RETRIES; attempt++) {
      const controller = new AbortController();
      const timer = setTimeout(
        () => controller.abort(),
        this.opts.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      );
      try {
        const headers: Record<string, string> = {};
        if (body !== undefined) headers['content-type'] = 'application/json';
        if (hostToken) headers['x-host-token'] = hostToken;

        const res = await fetch(`${this.opts.baseUrl}${path}`, {
          method,
          headers,
          body: body === undefined ? undefined : JSON.stringify(body),
          signal: controller.signal,
        });

        if (res.ok) return (await res.json()) as T;

        const payload = (await res.json().catch(() => ({}))) as Partial<ErrorResponse>;
        const message = payload.error ?? `signalling returned ${res.status}`;
        // 5xx and 429 can plausibly succeed on a retry; a 4xx will not, and retrying it
        // only delays telling the player their code is wrong.
        const retryable = res.status >= 500 || res.status === 429;
        lastError = new SignallingError(message, retryable);
        if (!retryable) throw lastError;
      } catch (e) {
        if (e instanceof SignallingError && !e.retryable) throw e;
        lastError = e instanceof Error ? e : new Error(String(e));
      } finally {
        clearTimeout(timer);
      }

      // Back off a little between attempts. A cold Worker is the usual reason for the
      // first failure and it will be warm by the second.
      if (attempt < RETRIES) await sleep(250 * (attempt + 1));
    }
    throw lastError instanceof SignallingError
      ? lastError
      : new SignallingError(lastError.message, true);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((res) => setTimeout(res, ms));
}
