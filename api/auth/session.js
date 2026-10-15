/**
 * GET /api/auth/session
 * Returns the signed-in user (200) or 401. The portal also uses this call to detect
 * that server sign-in is available (X-TalentHub-Auth header).
 */
import { sendJson } from "../../lib/http.mjs";
import { publicUser } from "../../lib/users.mjs";
import { currentUser } from "../../lib/session.mjs";

export default function handler(req, res) {
  if (req.method !== "GET") return sendJson(res, 405, { error: "Use GET." }, { Allow: "GET" });
  try {
    const user = currentUser(req);
    return user ? sendJson(res, 200, { user: publicUser(user) }) : sendJson(res, 401, { error: "Not signed in." });
  } catch (e) {
    return sendJson(res, 500, { error: e.config ? "Sign-in isn't configured on the server yet." : "Session check failed." });
  }
}
