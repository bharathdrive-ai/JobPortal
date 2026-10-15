/**
 * Builds the TalentHub job postings feed from the Excel source of truth.
 *
 *   data/job-postings.xlsx  ──►  data/job-postings.json  (loaded by TalentHub.html)
 *
 * Also assembles the deployable site in ./public for Vercel.
 * The build FAILS (exit code 1) on any validation error, so a broken
 * spreadsheet never replaces the postings on the live site.
 *
 * Usage:  npm run build
 */
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import { mkdir, writeFile, copyFile, rm } from "node:fs/promises";
import * as XLSX from "xlsx";

XLSX.set_fs(fs);

const SOURCE = process.env.JOB_POSTINGS_XLSX || "data/job-postings.xlsx";
const FEED = "data/job-postings.json";
const SITE_DIR = "public";

const STATUSES = ["Draft", "Pending Approval", "Published", "Closed", "Cancelled"];
const WORK_MODES = ["On-site", "Hybrid", "Remote"];
const RESUME = ["Mandatory", "Optional"];
const SENSITIVE = /\b(age|gender|sex|religio|ethnic|race|caste|marital|nationality|national origin|disabilit|health|photo|pregnan|sexual orientation|political)/i;

/** Column header in the workbook -> field name and type in the feed. */
const COLUMNS = {
  "Job ID": ["id", "text"], "Job Title": ["title", "text"], "Department": ["department", "text"],
  "Job Family": ["family", "text"], "Job Grade": ["grade", "text"], "Hiring Manager": ["hiringManager", "text"],
  "Recruiter": ["recruiter", "text"], "Openings": ["openings", "int"], "Job Type": ["jobType", "text"],
  "Job Summary": ["summary", "text"], "Key Responsibilities": ["responsibilities", "text"],
  "Required Qualifications": ["reqQualifications", "text"], "Required Skills": ["reqSkills", "list"],
  "Preferred Skills": ["prefSkills", "list"], "Min Experience (yrs)": ["minExp", "num"],
  "Preferred Experience (yrs)": ["prefExp", "num"], "Certifications": ["certifications", "text"],
  "Work Location": ["location", "text"], "Work Mode": ["workMode", "text"],
  "Eligible Departments": ["eligibleDepts", "list"], "Eligible Grades": ["eligibleGrades", "list"],
  "Min Tenure (months)": ["minTenure", "int"], "Performance Eligibility": ["perfEligibility", "text"],
  "Manager Approval": ["mgrApproval", "text"], "Opening Date": ["openDate", "date"], "Closing Date": ["closeDate", "date"],
  "Resume Requirement": ["resumeRequired", "text"], "Assessment Profile": ["profileId", "text"],
  "Review Threshold": ["threshold", "int"], "Featured": ["featured", "bool"], "Status": ["status", "text"],
  "Created On": ["createdAt", "date"],
};
/** Fields every non-draft posting must have (mirrors the portal's form validation). */
const REQUIRED = ["department", "family", "grade", "hiringManager", "recruiter", "openings", "jobType", "summary",
  "responsibilities", "reqQualifications", "reqSkills", "minExp", "location", "workMode", "eligibleDepts", "eligibleGrades",
  "minTenure", "perfEligibility", "mgrApproval", "openDate", "closeDate", "resumeRequired", "profileId", "threshold"];

const errors = [];
const fail = (where, msg) => errors.push(`${where}: ${msg}`);

/** Raw cell values arrive as string, number (dates are Excel serial numbers), boolean or null. */
const plain = v => (v === undefined ? null : v);
const text = v => { const p = plain(v); return p == null ? "" : String(p).replace(/\r\n/g, "\n").trim(); };

function toDate(v, where, label) {
  const p = plain(v);
  if (p == null || p === "") return "";
  let d;
  if (p instanceof Date) d = p;
  else if (typeof p === "number") d = new Date(Math.round((p - 25569) * 86400000)); // Excel serial
  else if (/^\d{4}-\d{2}-\d{2}$/.test(String(p).trim())) d = new Date(String(p).trim() + "T00:00:00Z");
  if (!d || isNaN(d)) { fail(where, `${label} "${p}" is not a valid date`); return ""; }
  return d.toISOString().slice(0, 10);
}
function toNumber(v, where, label, integer) {
  const p = plain(v);
  if (p == null || p === "") return "";
  const n = Number(p);
  if (!Number.isFinite(n) || n < 0 || (integer && !Number.isInteger(n))) { fail(where, `${label} must be a ${integer ? "whole " : ""}number (got "${p}")`); return ""; }
  return n;
}
const toList = v => [...new Map(text(v).split(/[,;\n]/).map(s => s.trim()).filter(Boolean).map(s => [s.toLowerCase(), s])).values()];

/** Reads a sheet into objects keyed by header text. */
function readSheet(wb, name, { required = true } = {}) {
  const ws = wb.Sheets[name];
  if (!ws) { if (required) fail(SOURCE, `missing sheet "${name}"`); return { headers: [], rows: [] }; }
  // Read from A1 so array index i is worksheet row i + 1; raw values keep dates as serial numbers (no timezone shifts).
  const range = XLSX.utils.decode_range(ws["!ref"] || "A1");
  range.s = { r: 0, c: 0 };
  const grid = XLSX.utils.sheet_to_json(ws, { header: 1, raw: true, defval: null, blankrows: true, range });
  const headers = (grid[0] || []).map(h => text(h));
  const rows = [];
  grid.slice(1).forEach((cells, i) => {
    if (!cells.some(v => v !== null && String(v).trim() !== "")) return;
    const obj = { _row: i + 2 };
    headers.forEach((h, c) => { if (h) obj[h] = cells[c]; });
    rows.push(obj);
  });
  return { headers: headers.filter(Boolean), rows };
}

async function main() {
  let wb;
  try { wb = XLSX.readFile(SOURCE, { cellFormula: false, cellHTML: false, cellText: false }); }
  catch (e) { console.error(`Cannot read ${SOURCE}: ${e.message}`); process.exit(1); }

  // ---- Lookups (dropdown values; merged into the portal's master data)
  const lk = readSheet(wb, "Lookups");
  const col = h => lk.rows.map(r => text(r[h])).filter(Boolean);
  const lookups = { departments: col("Departments"), jobFamilies: col("Job Families"), grades: col("Grades"),
    locations: col("Locations"), people: col("People"), recruiters: col("Recruiters") };

  // ---- Assessment profiles (default weights)
  const profiles = new Map();
  for (const r of readSheet(wb, "Assessment Profiles").rows) {
    const where = `Assessment Profiles row ${r._row}`, id = text(r["Profile ID"]);
    if (!id) continue;
    if (!profiles.has(id)) profiles.set(id, { id, name: text(r["Profile Name"]) || id, criteria: [] });
    const crit = { key: text(r["Criterion Key"]), name: text(r["Criterion Name"]), weight: toNumber(r["Default Weight (%)"], where, "Default Weight", true) };
    if (!crit.key || !crit.name) fail(where, "Criterion Key and Criterion Name are required");
    if (SENSITIVE.test(crit.name)) fail(where, `criterion "${crit.name}" refers to a personal characteristic`);
    profiles.get(id).criteria.push(crit);
  }
  for (const p of profiles.values()) {
    const t = p.criteria.reduce((s, c) => s + (Number(c.weight) || 0), 0);
    if (t !== 100) fail(`Assessment Profiles "${p.id}"`, `default weights total ${t}, must be 100`);
  }

  // ---- Per-job weights
  const weights = new Map();
  for (const r of readSheet(wb, "Assessment Weights").rows) {
    const where = `Assessment Weights row ${r._row}`, id = text(r["Job ID"]);
    if (!id) continue;
    const crit = { key: text(r["Criterion Key"]), name: text(r["Criterion Name"]), weight: toNumber(r["Weight (%)"], where, "Weight", true) };
    if (!crit.key || !crit.name || crit.weight === "") fail(where, "Criterion Key, Criterion Name and Weight are required");
    if (SENSITIVE.test(crit.name)) fail(where, `criterion "${crit.name}" refers to a personal characteristic`);
    if (!weights.has(id)) weights.set(id, []);
    weights.get(id).push(crit);
  }

  // ---- Job postings
  const sheet = readSheet(wb, "Job Postings");
  const missingCols = Object.keys(COLUMNS).filter(h => !sheet.headers.includes(h));
  if (missingCols.length) fail("Job Postings", `missing column(s): ${missingCols.join(", ")}`);
  const jobs = [], seen = new Set();
  for (const r of sheet.rows) {
    const where = `Job Postings row ${r._row}`;
    if (!text(r["Job ID"])) {
      if (Object.keys(COLUMNS).some(h => text(r[h]) && h !== "Featured")) fail(where, "Job ID is empty but the row has data");
      continue;
    }
    const job = {};
    for (const [header, [field, type]] of Object.entries(COLUMNS)) {
      const v = r[header];
      job[field] = type === "list" ? toList(v)
        : type === "date" ? toDate(v, where, header)
        : type === "int" ? toNumber(v, where, header, true)
        : type === "num" ? toNumber(v, where, header, false)
        : type === "bool" ? /^(yes|y|true|1)$/i.test(text(v))
        : text(v);
    }
    // Rules
    if (!/^JOB-\d{4}-\d{3,6}$/.test(job.id)) fail(where, `Job ID "${job.id}" must look like JOB-2026-1001`);
    if (seen.has(job.id)) fail(where, `duplicate Job ID ${job.id}`);
    seen.add(job.id);
    if (!STATUSES.includes(job.status)) fail(where, `Status must be one of: ${STATUSES.join(", ")}`);
    if (!job.title) fail(where, "Job Title is required");
    if (job.status !== "Draft") {
      for (const f of REQUIRED) {
        const v = job[f];
        if (v === "" || v == null || (Array.isArray(v) && !v.length)) fail(where, `${Object.keys(COLUMNS).find(h => COLUMNS[h][0] === f)} is required for a ${job.status} posting`);
      }
    }
    if (job.workMode && !WORK_MODES.includes(job.workMode)) fail(where, `Work Mode must be one of: ${WORK_MODES.join(", ")}`);
    if (job.resumeRequired && !RESUME.includes(job.resumeRequired)) fail(where, "Resume Requirement must be Mandatory or Optional");
    if (job.openDate && job.closeDate && (Date.parse(job.closeDate) - Date.parse(job.openDate)) / 86400000 < 7)
      fail(where, "Closing Date must be at least 7 days after Opening Date");
    if (job.openings !== "" && (job.openings < 1 || job.openings > 50)) fail(where, "Openings must be between 1 and 50");
    if (job.threshold !== "" && job.threshold > 100) fail(where, "Review Threshold must be between 0 and 100");
    if (job.prefExp !== "" && job.minExp !== "" && job.prefExp < job.minExp) fail(where, "Preferred Experience cannot be less than Min Experience");
    if (job.profileId && !profiles.has(job.profileId)) fail(where, `Assessment Profile "${job.profileId}" is not on the Assessment Profiles sheet`);
    for (const [field, list] of [["department", "departments"], ["grade", "grades"], ["location", "locations"]])
      if (job[field] && lookups[list].length && !lookups[list].includes(job[field])) fail(where, `${field} "${job[field]}" is not on the Lookups sheet`);

    // Weights: explicit rows win, otherwise the profile defaults
    const own = weights.get(job.id);
    const profile = profiles.get(job.profileId);
    job.weights = (own && own.length ? own : profile ? profile.criteria : []).map(c => ({ ...c }));
    const total = job.weights.reduce((s, c) => s + (Number(c.weight) || 0), 0);
    if (job.weights.length && total !== 100) fail(where, `assessment weights for ${job.id} total ${total}, must be 100`);
    if (job.status !== "Draft" && !job.weights.length) fail(where, `no assessment weights for ${job.id}`);

    job.history = [];
    job.approved = ["Published", "Closed"].includes(job.status);
    job.source = "spreadsheet";
    jobs.push(job);
  }
  for (const id of weights.keys()) if (!seen.has(id)) fail("Assessment Weights", `rows for unknown Job ID ${id}`);
  if (!jobs.length) fail("Job Postings", "no postings found");

  validateUsers();

  if (errors.length) {
    console.error(`\n✖ The build found ${errors.length} problem(s) in the data files. Fix them and build again:\n`);
    errors.forEach(e => console.error("  • " + e));
    process.exit(1);
  }

  const body = { jobs, profiles: [...profiles.values()], lookups };
  const version = createHash("sha256").update(JSON.stringify(body)).digest("hex").slice(0, 12);
  const feed = { source: SOURCE, version, count: jobs.length, ...body };
  await writeFile(FEED, JSON.stringify(feed, null, 2) + "\n");
  console.log(`✔ ${jobs.length} postings from ${SOURCE} → ${FEED} (version ${version})`);

  // Assemble the deployable site
  await mkdir(`${SITE_DIR}/data`, { recursive: true });
  await copyFile("TalentHub.html", `${SITE_DIR}/TalentHub.html`);
  await copyFile("privacy.html", `${SITE_DIR}/privacy.html`);   // public privacy policy (linked from Google's consent screen)
  await copyFile(FEED, `${SITE_DIR}/${FEED}`);
  // users.json is NOT published: the sign-in functions read it on the server (vercel.json includeFiles).
  await rm(`${SITE_DIR}/${USERS}`, { force: true });
  console.log(`✔ Site assembled in ./${SITE_DIR}`);
}

/* ---------------------------------------------------------------- users.json
   Accounts and role codes. Only salted hashes are allowed: the build fails if
   a plain-text password (or anything that isn't a valid hash entry) appears. */
const USERS = "data/users.json";
const ROLE_CODES = ["JS", "JP", "AD"];
function validateUsers() {
  let doc;
  try { doc = JSON.parse(fs.readFileSync(USERS, "utf8")); }
  catch (e) { fail(USERS, `cannot read or parse: ${e.message}`); return; }
  const roles = Array.isArray(doc.roles) ? doc.roles : [];
  const codes = roles.map(r => r && r.code);
  ROLE_CODES.forEach(c => { if (!codes.includes(c)) fail(USERS, `roles must include code ${c}`); });
  if (!Array.isArray(doc.users) || !doc.users.length) { fail(USERS, "users list is empty"); return; }
  const keys = new Set(), ids = new Set(), emails = new Set();
  const b64 = /^[A-Za-z0-9+/]+={0,2}$/;
  doc.users.forEach((u, i) => {
    const where = `${USERS} user #${i + 1}${u && u.userId ? ` (${u.userId})` : ""}`;
    if (!u || typeof u !== "object") { fail(where, "must be an object"); return; }
    // uIdKey: mandatory primary key, e.g. uid_GE0001
    if (!u.uIdKey) fail(where, "uIdKey is required (format uid_GE0001)");
    else if (!/^uid_GE\d{4,}$/.test(u.uIdKey)) fail(where, `uIdKey "${u.uIdKey}" must look like uid_GE0001`);
    else if (keys.has(u.uIdKey)) fail(where, `duplicate uIdKey ${u.uIdKey}`);
    keys.add(u.uIdKey);
    const id = String(u.userId || "").toLowerCase(), email = String(u.email || "").toLowerCase();
    if (!/^[a-z0-9._-]{3,40}$/.test(id)) fail(where, "userId must be 3–40 characters: letters, digits, dot, dash or underscore");
    if (ids.has(id)) fail(where, `duplicate userId ${id}`); ids.add(id);
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) fail(where, "email is not valid");
    if (emails.has(email)) fail(where, `duplicate email ${email}`); emails.add(email);
    if (!u.name) fail(where, "name is required");
    if (!ROLE_CODES.includes(u.roleCode)) fail(where, `roleCode must be one of ${ROLE_CODES.join(", ")}`);
    if (!["Active", "Disabled"].includes(u.status)) fail(where, "status must be Active or Disabled");
    const p = u.password;
    if (typeof p === "string" || "plainPassword" in u || "passwordText" in u)
      fail(where, "contains a plain-text password. Replace it with the output of: npm run hash-password -- \"password\"");
    else if (!p || p.algo !== "PBKDF2-SHA256" || !(p.iterations >= 100000) || !b64.test(p.salt || "") || !b64.test(p.hash || ""))
      fail(where, "password must be a PBKDF2-SHA256 entry {algo, iterations ≥ 100000, salt, hash}; create one with npm run hash-password");
  });
  if (!doc.users.some(u => u && u.roleCode === "AD" && u.status === "Active")) fail(USERS, "at least one Active Admin (AD) account is required");
  if (!errors.length) console.log(`✔ ${doc.users.length} user accounts in ${USERS} validated (hashed passwords only)`);
}

main().catch(e => { console.error(e); process.exit(1); });
