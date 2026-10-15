/**
 * GET /api/auth/users — Admin only. Lists accounts from users.json without password data,
 * for Administration → User accounts. (users.json itself is no longer published.)
 */
import { sendJson } from "../../lib/http.mjs";
import { loadUsers, publicUser } from "../../lib/users.mjs";
import { currentUser } from "../../lib/session.mjs";

export default function handler(req, res) {
  if (req.method !== "GET") return sendJson(res, 405, { error: "Use GET." }, { Allow: "GET" });
  try {
    const user = currentUser(req);
    if (!user) return sendJson(res, 401, { error: "Not signed in." });
    if (user.roleCode !== "AD") return sendJson(res, 403, { error: "Only Admins can list user accounts." });
    return sendJson(res, 200, { users: loadUsers().map(publicUser) });
  } catch (e) {
    return sendJson(res, 500, { error: e.config ? "Sign-in isn't configured on the server yet." : "Couldn't load accounts." });
  }
}
