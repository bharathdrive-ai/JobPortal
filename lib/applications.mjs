/**
 * Applications register: the "Applications" tab of the register Google Sheet.
 * One row per application: key columns for people reading the sheet, plus the full
 * record as JSON (the shape TalentHub.html uses). The server enforces who may see and
 * change what (see ALLOWED below).
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { readTab, appendRow, writeRow } from "./google.mjs";
import { resumeFields } from "./resumes.mjs";

export const APPS_TAB = "Applications";
export const APP_COLUMNS = ["appId", "jobId", "uIdKey", "empId", "name", "status", "updatedAt", "record"];
const MAX_RECORD = 45000;   // Google Sheets allows 50,000 characters per cell

export function statusOf(r) { return r.decision || r.assessStatus || ""; }
export function toRow(r) {
  const json = JSON.stringify(r);
  if (json.length > MAX_RECORD) throw Object.assign(new Error("This application record is too large to save."), { status: 413 });
  return [r.id, r.jobId, r.uIdKey || "", r.empId, r.name, statusOf(r), new Date().toISOString(), json];
}

/** All applications with their sheet row numbers. Rows with broken JSON are skipped. */
export async function listApps() {
  const rows = await readTab(APPS_TAB);
  const out = [];
  rows.forEach((row, i) => {
    if (!row[0] || row[0] === APP_COLUMNS[0]) return;   // blank or the header row
    try { const rec = JSON.parse(row[7] || "{}"); rec.id = row[0]; out.push({ rec, rowNumber: i + 1 }); }
    catch (e) { console.error(`Applications row ${i + 1}: unreadable record`); }
  });
  return out;
}
export async function appendApp(rec) { await appendRow(APPS_TAB, toRow(rec)); }
export async function saveApp(entry) { await writeRow(APPS_TAB, entry.rowNumber, toRow(entry.rec)); }
export function nextAppId(entries) {
  const nums = entries.map(e => /^APP-(\d+)$/.exec(e.rec.id)).filter(Boolean).map(m => Number(m[1]));
  return "APP-" + (Math.max(5000, ...nums) + 1);   // APP-5001, APP-5002, …
}

/** Who may see an application: its applicant, or any Job Poster / Admin. */
export function canSee(user, rec) {
  if (user.roleCode === "JP" || user.roleCode === "AD") return true;
  return rec.uIdKey === user.uIdKey || (!!rec.empId && rec.empId === user.empId);
}

/* ---------------- job postings (bundled feed) ---------------- */
let jobsCache = null;
export function findJob(jobId) {
  if (!jobsCache) {
    try { jobsCache = JSON.parse(readFileSync(join(process.cwd(), "data", "job-postings.json"), "utf8")).jobs || []; }
    catch (e) { jobsCache = []; }
  }
  return jobsCache.find(j => j.id === jobId) || null;
}

/* ---------------- validation of client-supplied fields ---------------- */
const str = (v, max) => (v == null ? "" : String(v)).slice(0, max);
const strList = (v) => (Array.isArray(v) ? v.slice(0, 60).map(x => str(x, 120).trim()).filter(Boolean) : []);
const num = (v, lo, hi) => { const n = Number(v); return Number.isFinite(n) && n >= lo && n <= hi ? n : null; };
const ASSESS = ["Pending Assessment", "Under Review", "Assessed"];
const POSTER_DECISIONS = ["Shortlisted", "On Hold", "Rejected"];

function cleanCriteria(v) {
  if (!v || typeof v !== "object" || Array.isArray(v)) return null;
  const out = {};
  for (const [k, c] of Object.entries(v).slice(0, 30)) {
    if (!/^[A-Za-z0-9_]{1,40}$/.test(k) || !c || typeof c !== "object") continue;
    const score = c.score === "" || c.score == null ? "" : num(c.score, 0, 100);
    out[k] = { score: score == null ? "" : score,
      evidence: (Array.isArray(c.evidence) ? c.evidence : []).slice(0, 20).map(e => ({ text: str(e && e.text, 400), src: str(e && e.src, 80) })).filter(e => e.text) };
  }
  return out;
}
function cleanOverride(v, user) {
  if (v == null) return null;
  const score = num(v.score, 0, 100), reason = str(v.reason, 500).trim();
  if (score == null || reason.length < 10) throw Object.assign(new Error("An override needs a score from 0 to 100 and a reason of at least 10 characters."), { status: 400 });
  return { score, reason, by: str(v.by, 80) || user.name, at: str(v.at, 20) };
}

/**
 * Applies a patch from `user` to `rec`, enforcing the rules. Returns the updated record
 * or throws { status, message }. A new resume is named by patch.resumeFileId and must already
 * be verified with lib/resumes.mjs#claimResume (passed in as `claimed`).
 */
export function applyPatch(user, rec, patch, claimed = null) {
  if (!patch || typeof patch !== "object") throw Object.assign(new Error("Nothing to change."), { status: 400 });
  const role = user.roleCode, out = { ...rec }, keys = Object.keys(patch);
  const deny = (msg) => { throw Object.assign(new Error(msg), { status: 403 }); };

  if (role === "JS") {
    if (!canSee(user, rec)) deny("That application isn't yours.");
    if (rec.decision) deny("This application already has an outcome, so it can't be changed.");
    const allowed = ["resumeFileId", "decision", "decisionReason"];
    const bad = keys.filter(k => !allowed.includes(k)); if (bad.length) deny("You can't change: " + bad.join(", "));
    if ("decision" in patch) {
      if (patch.decision !== "Withdrawn") deny("Applicants can only withdraw an application.");
      out.decision = "Withdrawn"; out.decisionReason = str(patch.decisionReason, 500) || "Withdrawn by applicant";
    }
  } else if (role === "JP" || role === "AD") {
    const allowed = ["skills", "certs", "education", "relExp", "comments", "criteria", "override", "assessStatus", "decision", "decisionReason",
      "decidedBy", "decidedAt", "resumeFileId"].concat(role === "AD" ? ["mgrApprovalStatus"] : []);
    const bad = keys.filter(k => !allowed.includes(k)); if (bad.length) deny("You can't change: " + bad.join(", "));
    if ("skills" in patch) out.skills = strList(patch.skills);
    if ("certs" in patch) out.certs = strList(patch.certs);
    if ("education" in patch) out.education = str(patch.education, 200);
    if ("relExp" in patch) { const n = num(patch.relExp, 0, 50); if (n == null) throw Object.assign(new Error("Relevant experience must be 0 to 50 years."), { status: 400 }); out.relExp = n; }
    if ("comments" in patch) out.comments = str(patch.comments, 1500);
    if ("criteria" in patch) out.criteria = cleanCriteria(patch.criteria);
    if ("override" in patch) out.override = cleanOverride(patch.override, user);
    if ("assessStatus" in patch) { if (!ASSESS.includes(patch.assessStatus)) throw Object.assign(new Error("Unknown assessment status."), { status: 400 }); out.assessStatus = patch.assessStatus; }
    if ("decision" in patch) {
      if (rec.decision === "Withdrawn") deny("The candidate withdrew this application.");
      if (!POSTER_DECISIONS.includes(patch.decision)) throw Object.assign(new Error("Unknown decision."), { status: 400 });
      out.decision = patch.decision; out.decisionReason = str(patch.decisionReason, 500);
      out.decidedBy = user.name; out.decidedAt = new Date().toISOString().slice(0, 16);
    }
    if ("mgrApprovalStatus" in patch) {
      if (!["Approved", "Declined"].includes(patch.mgrApprovalStatus)) throw Object.assign(new Error("Unknown approval status."), { status: 400 });
      out.mgrApprovalStatus = patch.mgrApprovalStatus;
    }
  } else deny("Your role can't change applications.");

  if ("resumeFileId" in patch) {
    if (!claimed || claimed.id !== patch.resumeFileId) throw Object.assign(new Error("Upload the resume file first."), { status: 400 });
    Object.assign(out, resumeFields(rec, claimed));
  }
  return out;
}
