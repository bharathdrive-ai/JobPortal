/**
 * GET /api/resumes/file?app=APP-5001   — opens the resume attached to an application
 * Allowed for whoever may see the application (the applicant, Job Posters, Admins).
 * PDFs open in the browser; Word files download. Never cached.
 */
import { sendJson } from "../../lib/http.mjs";
import { currentUser } from "../../lib/session.mjs";
import { isConfigured, downloadFile } from "../../lib/google.mjs";
import { listApps, canSee } from "../../lib/applications.mjs";
import { sniff, RESUME_TYPES } from "../../lib/resumes.mjs";

export default async function handler(req, res) {
  if (req.method !== "GET") return sendJson(res, 405, { error: "Use GET." }, { Allow: "GET" });
  if (!isConfigured()) return sendJson(res, 503, { error: "Resume storage isn't connected yet.", notConnected: true });
  try {
    const user = await currentUser(req);
    if (!user) return sendJson(res, 401, { error: "Sign in to TalentHub to open resumes." });
    const appId = new URL(req.url, "http://x").searchParams.get("app") || "";
    const entry = (await listApps()).find(e => e.rec.id === appId);
    if (!entry || !canSee(user, entry.rec)) return sendJson(res, 404, { error: "Application not found." });
    const rec = entry.rec;
    if (!rec.resumeFileId) return sendJson(res, 404, { error: "Only the file name was recorded for this resume; the file itself wasn't stored." });

    const data = await downloadFile(rec.resumeFileId);
    const kind = sniff(data);
    if (!kind) return sendJson(res, 502, { error: "The stored resume isn't a PDF or Word file." });
    const base = String(rec.resumeFile || "resume").replace(/\.[^.]*$/, "").replace(/[^\w .()-]/g, "_").slice(0, 100) || "resume";
    const fileName = `${base}.${kind}`;
    res.statusCode = 200;
    res.setHeader("Content-Type", RESUME_TYPES[kind]);
    res.setHeader("Content-Length", String(data.length));
    res.setHeader("Content-Disposition", `${kind === "pdf" ? "inline" : "attachment"}; filename="${fileName}"`);
    res.setHeader("Cache-Control", "private, no-store");
    res.setHeader("X-Content-Type-Options", "nosniff");
    // No CSP sandbox here: Chrome refuses to show sandboxed PDFs. The type is fixed from the
    // checked contents and nosniff stops the browser treating it as anything else.
    res.setHeader("X-TalentHub-Auth", "server");
    res.end(data);
  } catch (e) {
    if (e.status === 404) return sendJson(res, 404, { error: "The resume file is no longer in Google Drive." });
    console.error("resumes/file:", e.message);
    return sendJson(res, 502, { error: "The resume couldn't be loaded from Google Drive. Try again." });
  }
}
