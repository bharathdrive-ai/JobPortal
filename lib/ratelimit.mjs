/**
 * Failed sign-in tracking.
 *  - per account: 5 failures lock that account's sign-in for 5 minutes
 *  - per network address: 20 failures lock that address for 5 minutes
 *    (higher, because many people in one office can share an address)
 * NOTE: kept in memory, so it is per function instance on Vercel. A shared store
 * (e.g. Vercel KV) would make the limit global; good enough for this stage.
 */
const LIMITS = { login: 5, ip: 20, signuptry: 20, signup: 5 }, LOCK_MS = 5 * 60_000;   // signup = completed sign-ups per address
const state = new Map();   // "login:x" | "ip:y" -> { fails, until }
const limitFor = (key) => LIMITS[key.split(":")[0]] || 5;

export function lockedFor(keys, now = Date.now()) {
  let ms = 0;
  for (const k of keys) { const s = state.get(k); if (s && s.until > now) ms = Math.max(ms, s.until - now); }
  return ms;
}
export function recordFailure(keys, now = Date.now()) {
  for (const k of keys) {
    const s = state.get(k) || { fails: 0, until: 0 };
    s.fails = s.until && s.until <= now ? 1 : s.fails + 1;
    if (s.fails >= limitFor(k)) { s.until = now + LOCK_MS; s.fails = 0; }
    state.set(k, s);
  }
  if (state.size > 5000) state.clear();   // keep memory bounded
}
/** After a successful sign-in only the account's counter resets (not the address's). */
export function clearFailures(keys) { keys.filter(k => k.startsWith("login:")).forEach(k => state.delete(k)); }
