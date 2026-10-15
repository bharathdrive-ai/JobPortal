/**
 * POST /api/resumes   — uploads a resume file to the TalentHub Resumes folder in Google Drive
 * Body: the file's bytes (Content-Type: application/octet-stream, max 4 MB)
 * Header X-File-Name: the original file name (URI-encoded)
 * Returns { fileId, name, size, kind }. The file is attached to an application separately
 * (resumeFileId in /api/applications or /api/applications/update).
 */
import { sendJson, checkPost, readBinary } from "../../lib/http.mjs";
import { currentUser } from "../../lib/session.mjs";
import { isConfigured } from "../../lib/google.mjs";
import { storeResume, MAX_RESUME_BYTES } from "../../lib/resumes.mjs";
import { lockedFor, recordFailure } from "../../lib/ratelimit.mjs";

export default async function handler(req, res) {
  if (!checkPost(req, res, "application/octet-stream")) return;
  if (!isConfigured()) return sendJson(res, 503, { error: "Resume storage isn't connected yet.", notConnected: true });
  try {
    const user = await currentUser(req);
    if (!user) return sendJson(res, 401, { error: "Not signed in." });
    const key = ["upload:" + user.uIdKey];
    if (lockedFor(key)) return sendJson(res, 429, { error: "Too many uploads. Try again in a few minutes." });
    recordFailure(key);   // counts uploads

    let fileName = "";
    try { fileName = decodeURIComponent(String(req.headers["x-file-name"] || "")); } catch (e) { fileName = ""; }
    const data = await readBinary(req, MAX_RESUME_BYTES);
    const stored = await storeResume(user, fileName, data);
    return sendJson(res, 201, stored);
  } catch (e) {
    if (e.status && e.status < 500) return sendJson(res, e.status, { error: e.status === 413 ? "That file is larger than 4 MB." : e.message });
    console.error("resumes:", e.message);
    return sendJson(res, 502, { error: "The resume couldn't be saved to Google Drive. Try again." });
  }
}
