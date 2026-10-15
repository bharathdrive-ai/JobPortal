/**
 * POST /api/applications/update   { id, patch }
 * Changes one application. lib/applications.mjs#applyPatch decides what each role may change:
 *  - Job Seekers: their own open application — new resume (resumeFileId from /api/resumes), or withdraw
 *  - Job Posters / Admins: assessment fields and decisions; Admins also manager approval
 */
import { sendJson, readJson, checkPost } from "../../lib/http.mjs";
import { currentUser } from "../../lib/session.mjs";
import { isConfigured } from "../../lib/google.mjs";
import { listApps, saveApp, applyPatch } from "../../lib/applications.mjs";
import { claimResume, attachResume } from "../../lib/resumes.mjs";

export default async function handler(req, res) {
  if (!checkPost(req, res)) return;
  if (!isConfigured()) return sendJson(res, 503, { error: "The applications register isn't connected yet.", notConnected: true });
  try {
    const user = await currentUser(req);
    if (!user) return sendJson(res, 401, { error: "Not signed in." });
    const { id, patch } = await readJson(req);
    const entry = (await listApps()).find(e => e.rec.id === String(id || ""));
    if (!entry) return sendJson(res, 404, { error: "Application not found." });
    const claimed = patch && patch.resumeFileId ? await claimResume(user, patch.resumeFileId) : null;
    entry.rec = applyPatch(user, entry.rec, patch, claimed);
    await saveApp(entry);
    if (claimed) await attachResume(claimed, entry.rec).catch(e => console.error("attach resume:", e.message));
    return sendJson(res, 200, { application: entry.rec });
  } catch (e) {
    if (e instanceof SyntaxError) return sendJson(res, 400, { error: "Bad request." });
    if (e.status && e.status < 500) return sendJson(res, e.status, { error: e.message });
    console.error("applications/update:", e.message);
    return sendJson(res, 502, { error: "The applications register couldn't be reached. Try again." });
  }
}
