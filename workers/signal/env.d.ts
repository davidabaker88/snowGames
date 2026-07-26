/**
 * Minimal Cloudflare Workers types.
 *
 * Hand-declared rather than pulling in `@cloudflare/workers-types`, so this Worker is
 * typechecked by the same `tsc` run as everything else instead of being the one
 * directory nobody compiles. Only the handful of surfaces this file actually touches
 * are declared -- if the Worker grows, so does this.
 *
 * `wrangler` supplies the real types at deploy time and will disagree with nothing
 * here; these are a strict subset.
 */

interface DurableObjectId {
  toString(): string;
}

interface DurableObjectStorage {
  get<T>(key: string): Promise<T | undefined>;
  put<T>(key: string, value: T): Promise<void>;
  delete(key: string): Promise<boolean>;
  deleteAll(): Promise<void>;
}

interface DurableObjectState {
  readonly id: DurableObjectId;
  readonly storage: DurableObjectStorage;
}

interface DurableObjectStub {
  fetch(request: Request): Promise<Response>;
}

interface DurableObjectNamespace {
  idFromName(name: string): DurableObjectId;
  newUniqueId(): DurableObjectId;
  get(id: DurableObjectId): DurableObjectStub;
}

interface DurableObject {
  fetch(request: Request): Promise<Response>;
}
