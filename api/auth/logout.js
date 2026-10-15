/** POST /api/auth/logout — clears the session cookie. */
import { sendJson, checkPost } from "../../lib/http.mjs";
import { clearCookie } from "../../lib/session.mjs";

export default function handler(req, res) {
  if (!checkPost(req, res)) return;
  return sendJson(res, 200, { ok: true }, { "Set-Cookie": clearCookie(req) });
}
