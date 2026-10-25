// S-2: the store's fetch, late-bound. supertokens-web-js patches window.fetch in init(), which
// runs after the store is built, so binding window.fetch at construction would capture the
// unpatched one and refresh-on-401 would never run for game requests.
import type { FetchLike } from "./wire.js";

export const browserFetch: FetchLike = (input, init) => window.fetch(input, init);
