/**
 * POST /api/auth/login   { login, password, roleCode }
 * Verifies the password against data/users.json on the server and sets a signed,
 * HttpOnly session cookie. Errors never reveal whether an account exists.
 */
import { sendJson, readJson, checkPost, clientIp } from "../../lib/http.mjs";
import { findByLogin, verifyPassword, publicUser, ROLE_NAMES } from "../../lib/users.mjs";
import { createToken, sessionCookie } from "../../lib/session.mjs";
import { lockedFor, recordFailure, clearFailures } from "../../lib/ratelimit.mjs";

const BAD = "The user ID, email or password is incorrect.";

export default async function handler(req, res) {
  if (!checkPost(req, res)) return;
  try {
    const body = await readJson(req);
    const login = String(body.login || "").trim().slice(0, 120);
    const password = String(body.password || "").slice(0, 200);
    const roleCode = String(body.roleCode || "");
    if (!login || !password) return sendJson(res, 400, { error: "Enter your user ID or email and your password." });
    if (!ROLE_NAMES[roleCode]) return sendJson(res, 400, { error: "Choose a role to sign in as." });

    const keys = ["login:" + login.toLowerCase(), "ip:" + clientIp(req)];
    const wait = lockedFor(keys);
    if (wait) { const m = Math.ceil(wait / 60000); return sendJson(res, 429, { error: `Too many failed attempts. Try again in ${m} minute${m > 1 ? "s" : ""}.` }); }

    const user = findByLogin(login);
    const ok = await verifyPassword(password, user ? user.password : null);   // runs even for unknown accounts
    if (!user || !ok) { recordFailure(keys); return sendJson(res, 401, { error: BAD }); }
    clearFailures(keys);
    if (user.status !== "Active") return sendJson(res, 403, { error: "This account is disabled. Contact HR to restore access." });
    if (user.roleCode !== roleCode) return sendJson(res, 403, { error: `This account is registered as ${ROLE_NAMES[user.roleCode]}. Choose that role to sign in.` });

    return sendJson(res, 200, { user: publicUser(user) }, { "Set-Cookie": sessionCookie(req, createToken(user)) });
  } catch (e) {
    if (e.config) return sendJson(res, 500, { error: "Sign-in isn't configured on the server yet." });
    if (e instanceof SyntaxError) return sendJson(res, 400, { error: "Bad request." });
    return sendJson(res, e.status || 500, { error: e.status ? e.message : "Sign-in failed. Try again." });
  }
}
