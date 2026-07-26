/**
 * The signalling Worker.
 *
 * A mailbox for WebRTC descriptions, and deliberately nothing more. It never sees an
 * input frame, a snapshot, or anything about the game -- two peers use it for a couple
 * of seconds to find each other and then talk directly for the rest of the match.
 *
 * That distinction is the entire reason this is affordable. A relaying game server
 * carries every message of every match: eight players at 30Hz for ten minutes is
 * hundreds of thousands of messages, which is what made the earlier cost estimate come
 * out at roughly fourteen matches a day on Cloudflare's free tier. This carries about
 * six requests per player per JOIN. The same free tier covers thousands of matches a
 * day, and the difference is not optimisation -- it is that peer-to-peer means the
 * traffic never comes here at all.
 *
 * ## Why a Durable Object
 *
 * A room is a tiny piece of mutable state that two parties must agree on, which is
 * exactly what a plain stateless Worker cannot hold. One DO per room code gives
 * single-threaded access to that room with no locking and no races between a host
 * polling and a joiner posting.
 *
 * The room logic itself is NOT written here -- it is `MemorySignalling` from the shared
 * package, which is also what the unit tests exercise. This file is the HTTP shell:
 * routing, validation, and CORS. A rule about room lifetime or offer limits therefore
 * has one implementation and one test suite, and cannot drift between the version that
 * is tested and the version that is deployed.
 */

import {
  MemorySignalling,
  ROOM_TTL_MS,
  SignallingError,
  isValidRoomCode,
  makeRoomCode,
  normalizeRoomCode,
  type CreateRoomRequest,
  type CreateRoomResponse,
  type PollAnswerResponse,
  type PollOffersResponse,
  type PostAnswerRequest,
  type PostOfferRequest,
  type PostOfferResponse,
} from '@snow/shared';

export interface Env {
  ROOM: DurableObjectNamespace;
}

/**
 * CORS is wide open, on purpose.
 *
 * The page may be served from anywhere -- Cloudflare Pages, a LAN dev server, a file
 * somebody was sent -- and there is nothing here worth protecting with an origin
 * check. The only capability this grants is "join a snowball fight if you know a
 * four-character code", and an origin header is not what would stop that.
 */
const CORS: Record<string, string> = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'GET,POST,OPTIONS',
  'access-control-allow-headers': 'content-type,x-host-token',
  'access-control-max-age': '86400',
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...CORS },
  });
}

function fail(message: string, status = 400): Response {
  return json({ error: message }, status);
}

/** A response coming back from a Durable Object still needs the CORS headers. */
function withCors(res: Response): Response {
  const headers = new Headers(res.headers);
  for (const [k, v] of Object.entries(CORS)) headers.set(k, v);
  return new Response(res.body, { status: res.status, headers });
}

function cryptoRandom(): number {
  return crypto.getRandomValues(new Uint32Array(1))[0]! / 0x100000000;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });

    const url = new URL(request.url);
    const parts = url.pathname.split('/').filter(Boolean);

    // POST /room -> create.
    //
    // Every room object is addressed BY its code, so the code has to be chosen before
    // the object that will own it can be reached. The code is therefore generated HERE
    // and claimed there, retrying on collision. Generating it inside a freshly created
    // object instead would put the room in an object nobody could ever address again --
    // creation would appear to succeed and every subsequent join would 404.
    if (parts.length === 1 && parts[0] === 'room' && request.method === 'POST') {
      const body = (await request.json().catch(() => ({}))) as Partial<CreateRoomRequest>;
      const name = typeof body.name === 'string' ? body.name.slice(0, 24) : 'Host';

      for (let attempt = 0; attempt < 6; attempt++) {
        const code = makeRoomCode(cryptoRandom);
        const res = await env.ROOM.get(env.ROOM.idFromName(code)).fetch(
          new Request(`https://room/claim?code=${code}`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ name }),
          }),
        );
        if (res.status !== 409) return withCors(res);
      }
      return fail('could not find a free room code, try again', 503);
    }

    // Everything else is /room/:code/...
    if (parts.length >= 2 && parts[0] === 'room') {
      const code = normalizeRoomCode(parts[1] ?? '');
      if (!isValidRoomCode(code)) return fail('not a room code', 404);
      // Keyed by CODE, so a host and its joiners always reach the same object.
      const id = env.ROOM.idFromName(code);
      const rest = parts.slice(2).join('/');
      return env.ROOM.get(id).fetch(
        new Request(`https://room/${rest}?code=${code}`, request),
      );
    }

    if (parts.length === 0 || parts[0] === 'health') {
      return json({ ok: true, service: 'snowball-signal' });
    }
    return fail('not found', 404);
  },
};

/**
 * One room.
 *
 * Holds a `MemorySignalling` with exactly one room in it. That looks odd until you
 * notice what it buys: the room rules are the tested implementation, verbatim, and this
 * class only has to decide which method an HTTP request maps to.
 */
export class Room implements DurableObject {
  private readonly svc: MemorySignalling;
  /** The code this object owns, learned on create or from the request. */
  private code = '';
  private hostToken = '';

  constructor(
    private readonly state: DurableObjectState,
    _env: Env,
  ) {
    this.svc = new MemorySignalling({
      now: () => Date.now(),
      random: () => crypto.getRandomValues(new Uint32Array(1))[0]! / 0x100000000,
    });
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname.replace(/^\//, '');

    try {
      if (path === 'claim' && request.method === 'POST') {
        return await this.claim(request, url.searchParams.get('code') ?? '');
      }

      // Reload from storage: a DO can be evicted between requests, and losing a live
      // room to an eviction would look exactly like the code being wrong.
      await this.load(url.searchParams.get('code') ?? '');

      if (path === 'offer' && request.method === 'POST') return await this.postOffer(request);
      if (path === 'offers' && request.method === 'GET') return await this.pollOffers(request);
      if (path === 'answer' && request.method === 'POST') return await this.postAnswer(request);
      if (path === 'answer' && request.method === 'GET') return await this.pollAnswer(url);
      if (path === 'close' && request.method === 'POST') return await this.close(request);
      return fail('not found', 404);
    } catch (e) {
      if (e instanceof SignallingError) return fail(e.message, e.retryable ? 503 : 404);
      return fail('signalling failed', 500);
    }
  }

  /**
   * Claim this object's code, or report that it is already taken.
   *
   * 409 rather than an error body, because the caller's correct response is to try a
   * different code rather than to tell the player anything.
   */
  private async claim(request: Request, code: string): Promise<Response> {
    if (!isValidRoomCode(code)) return fail('not a room code', 400);
    const body = (await request.json().catch(() => ({}))) as Partial<CreateRoomRequest>;
    const name = typeof body.name === 'string' ? body.name.slice(0, 24) : 'Host';

    const already = await this.state.storage.get<string>('hostToken');
    if (already) {
      // A live room already owns this code. Note the TTL check has to happen too: an
      // object whose room has expired should be reusable, or the code space leaks one
      // entry per abandoned lobby forever.
      const touched = (await this.state.storage.get<number>('touchedAtMs')) ?? 0;
      if (Date.now() - touched < ROOM_TTL_MS) return new Response(null, { status: 409, headers: CORS });
      await this.state.storage.deleteAll();
    }

    const created = await this.svc.claimRoom(code, name);
    this.code = created.code;
    this.hostToken = created.hostToken;

    // Persist enough to rebuild after an eviction. The offer and answer mailboxes are
    // deliberately NOT persisted: they live for one round trip, and a description that
    // survived an eviction would be stale by the time anybody read it.
    await this.state.storage.put('code', created.code);
    await this.state.storage.put('hostToken', created.hostToken);
    await this.state.storage.put('name', name);
    await this.state.storage.put('touchedAtMs', Date.now());

    const res: CreateRoomResponse = created;
    return json(res);
  }

  private async load(code: string): Promise<void> {
    if (this.code) return;
    const stored = await this.state.storage.get<string>('code');
    const token = await this.state.storage.get<string>('hostToken');
    if (!stored || !token) throw new SignallingError('no such room');
    this.code = stored;
    this.hostToken = token;
    if (code && code !== stored) throw new SignallingError('no such room');

    // Rebuild the room inside the service. Any pending descriptions are gone, which is
    // correct -- both sides retry.
    const name = (await this.state.storage.get<string>('name')) ?? 'Host';
    await this.svc.claimRoom(stored, name, token);
  }

  private async postOffer(request: Request): Promise<Response> {
    const body = (await request.json().catch(() => ({}))) as Partial<PostOfferRequest>;
    if (!body.offer) return fail('missing offer');
    const out = await this.svc.postOffer(
      this.code,
      typeof body.name === 'string' ? body.name : 'Player',
      body.offer,
    );
    const res: PostOfferResponse = out;
    return json(res);
  }

  private async pollOffers(request: Request): Promise<Response> {
    const token = request.headers.get('x-host-token') ?? '';
    const offers = await this.svc.pollOffers(this.code, token);
    // The host polling is the room's keep-alive, and the persisted timestamp is what
    // survives an eviction -- without writing it here, a long lobby would be
    // reclaimable by `claim` while the host was still sitting in it.
    await this.state.storage.put('touchedAtMs', Date.now());
    const res: PollOffersResponse = { offers };
    return json(res);
  }

  private async postAnswer(request: Request): Promise<Response> {
    const token = request.headers.get('x-host-token') ?? '';
    const body = (await request.json().catch(() => ({}))) as Partial<PostAnswerRequest>;
    if (!body.peerId || !body.answer) return fail('missing peerId or answer');
    await this.svc.postAnswer(this.code, token, body.peerId, body.answer);
    return json({ ok: true });
  }

  private async pollAnswer(url: URL): Promise<Response> {
    const peerId = url.searchParams.get('peerId') ?? '';
    if (!peerId) return fail('missing peerId');
    const answer = await this.svc.pollAnswer(this.code, peerId);
    const res: PollAnswerResponse = { answer };
    return json(res);
  }

  private async close(request: Request): Promise<Response> {
    const token = request.headers.get('x-host-token') ?? '';
    await this.svc.closeRoom(this.code, token);
    if (token === this.hostToken) await this.state.storage.deleteAll();
    return json({ ok: true });
  }
}
