/**
 * Signed session tokens kept in an HttpOnly cookie.
 * Token = base64url(JSON payload) + "." + base64url(HMAC-SHA256(payload, SESSION_SECRET)).
 * The browser can't read or alter it; the server re-checks the account on every request.
 */
import { createHmac, timingSafeEqual } from "node:crypto";
import { parseCookies, isLocalHttp } from "./http.mjs";
import { findByKey } from "./users.mjs";

export const COOKIE = "th_session";
export const SESSION_HOURS = 8;

function secret() {
  const s = process.env.SESSION_SECRET || "";
  if (s.length < 32) throw Object.assign(new Error("SESSION_SECRET is not configured (needs 32+ characters)."), { status: 500, config: true });
  return s;
}
const b64url = (buf) => Buffer.from(buf).toString("base64url");
const sign = (data) => createHmac("sha256", secret()).update(data).digest();

export function createToken(user, now = Date.now()) {
  const payload = b64url(JSON.stringify({ k: user.uIdKey, r: user.roleCode, iat: now, exp: now + SESSION_HOURS * 3600_000 }));
  return payload + "." + b64url(sign(payload));
}

/** Returns the payload if the signature is valid and not expired, else null. */
export function verifyToken(token, now = Date.now()) {
  if (typeof token !== "string" || token.length > 1024) return null;
  const [payload, sig] = token.split(".");
  if (!payload || !sig) return null;
  const expected = sign(payload), given = Buffer.from(sig, "base64url");
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null;
  let data;
  try { data = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")); } catch { return null; }
  if (!data || typeof data.exp !== "number" || data.exp <= now) return null;
  return data;
}

export function sessionCookie(req, token) {
  return [`${COOKIE}=${token}`, "Path=/", "HttpOnly", "SameSite=Strict", `Max-Age=${SESSION_HOURS * 3600}`]
    .concat(isLocalHttp(req) ? [] : ["Secure"]).join("; ");
}
export function clearCookie(req) {
  return [`${COOKIE}=`, "Path=/", "HttpOnly", "SameSite=Strict", "Max-Age=0"].concat(isLocalHttp(req) ? [] : ["Secure"]).join("; ");
}

/**
 * The signed-in user for this request, or null. Re-checks that the account still exists,
 * is Active and still has the role in the token (so disabling an account ends its sessions).
 */
export function currentUser(req) {
  const data = verifyToken(parseCookies(req)[COOKIE]);
  if (!data) return null;
  const user = findByKey(data.k);
  if (!user || user.status !== "Active" || user.roleCode !== data.r) return null;
  return user;
}
