/**
 * GET  /api/applications   — applications the signed-in user may see
 *                            (Job Seekers: their own; Job Posters and Admins: all)
 * POST /api/applications   — a Job Seeker applies: { jobId, note, resumeFileId }
 *                            (resumeFileId comes from uploading the file to /api/resumes first)
 *                            The record is built from the signed-in account, not from the request.
 */
import { sendJson, readJson, checkPost } from "../../lib/http.mjs";
import { currentUser } from "../../lib/session.mjs";
import { isConfigured } from "../../lib/google.mjs";
import { listApps, appendApp, nextAppId, canSee, findJob } from "../../lib/applications.mjs";
import { claimResume, attachResume, resumeFields } from "../../lib/resumes.mjs";

export default async function handler(req, res) {
  if (!isConfigured()) return sendJson(res, 503, { error: "The applications register isn't connected yet.", notConnected: true });
  try {
    const user = await currentUser(req);
    if (!user) return sendJson(res, 401, { error: "Not signed in." });

    if (req.method === "GET") {
      const apps = (await listApps()).map(e => e.rec).filter(r => canSee(user, r));
      return sendJson(res, 200, { applications: apps });
    }
    if (!checkPost(req, res)) return;
    if (user.roleCode !== "JS") return sendJson(res, 403, { error: "Only Job Seekers can apply for jobs." });

    const b = await readJson(req);
    const job = findJob(String(b.jobId || ""));
    const today = new Date().toISOString().slice(0, 10);
    if (!job || job.status !== "Published") return sendJson(res, 400, { error: "This job is not open for applications." });
    if (job.closeDate && job.closeDate < today) return sendJson(res, 400, { error: "The application window for this job has closed." });
    if (job.resumeRequired === "Mandatory" && !b.resumeFileId) return sendJson(res, 400, { error: "A resume is required for this job." });

    const entries = await listApps();
    if (entries.some(e => e.rec.jobId === job.id && canSee(user, e.rec) && e.rec.decision !== "Withdrawn"))
      return sendJson(res, 409, { error: "You have already applied to this job." });
    const claimed = b.resumeFileId ? await claimResume(user, b.resumeFileId) : null;

    const rec = { id: nextAppId(entries), jobId: job.id, uIdKey: user.uIdKey, name: user.name, empId: user.empId, dept: user.department,
      designation: user.designation, grade: user.grade, tenureMonths: Number(user.tenureMonths) || 0, relExp: Number(user.relExp) || 0,
      skills: [], education: user.education || "", certs: [],
      resumeFile: "(not provided)", resumeSize: 0, resumeUpdatedAt: "",
      appliedAt: today, mgrApprovalStatus: job.mgrApproval === "Notify only" ? "Not required" : "Pending", assessStatus: "Pending Assessment",
      decision: null, decisionReason: "", comments: "", override: null, criteria: null, note: String(b.note || "").slice(0, 1000) };
    if (claimed) Object.assign(rec, resumeFields(rec, claimed));
    await appendApp(rec);
    if (claimed) await attachResume(claimed, rec).catch(e => console.error("attach resume:", e.message));
    return sendJson(res, 201, { application: rec });
  } catch (e) {
    if (e instanceof SyntaxError) return sendJson(res, 400, { error: "Bad request." });
    console.error("applications:", e.message);
    return sendJson(res, e.status && e.status < 500 ? e.status : 502, { error: e.status && e.status < 500 ? e.message : "The applications register couldn't be reached. Try again." });
  }
}
