/**
 * POST /api/auth/user-status   { uIdKey, action: "approve" | "disable" | "enable" }   — Admin only
 * Changes the status of an account created through sign-up (register sheet).
 * Accounts in data/users.json are changed by editing that file instead.
 */
import { sendJson, readJson, checkPost } from "../../lib/http.mjs";
import { allUsers, updateAccount, publicUser } from "../../lib/users.mjs";
import { currentUser } from "../../lib/session.mjs";

const NEXT = { approve: ["Pending", "Active"], disable: ["Active", "Disabled"], enable: ["Disabled", "Active"] };

export default async function handler(req, res) {
  if (!checkPost(req, res)) return;
  try {
    const admin = await currentUser(req);
    if (!admin) return sendJson(res, 401, { error: "Not signed in." });
    if (admin.roleCode !== "AD") return sendJson(res, 403, { error: "Only Admins can change accounts." });
    const { uIdKey, action } = await readJson(req);
    const step = NEXT[action];
    if (!step) return sendJson(res, 400, { error: "Unknown action." });
    if (uIdKey === admin.uIdKey) return sendJson(res, 400, { error: "You can't change your own account." });
    const user = (await allUsers({ fresh: true })).find(u => u.uIdKey === uIdKey);
    if (!user) return sendJson(res, 404, { error: "Account not found." });
    if (user.source !== "register") return sendJson(res, 400, { error: "This account is maintained in data/users.json. Change it there." });
    if (user.status !== step[0]) return sendJson(res, 409, { error: `This account is ${user.status}, so it can't be ${action}d.` });
    user.status = step[1];
    await updateAccount(user);
    return sendJson(res, 200, { user: publicUser(user) });
  } catch (e) {
    if (e instanceof SyntaxError) return sendJson(res, 400, { error: "Bad request." });
    console.error("user-status:", e.message);
    return sendJson(res, e.status || 500, { error: e.status && e.status < 500 ? e.message : "Couldn't update the account. Try again." });
  }
}
