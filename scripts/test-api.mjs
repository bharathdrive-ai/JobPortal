/**
 * Tests sign-up, account approval and the applications register over HTTP,
 * using an in-memory fake Google Sheet (GOOGLE_FAKE=1) — nothing touches real Google.
 * Usage:  npm run test:api
 */
import { createServer } from "node:http";
import { pathToFileURL } from "node:url";
import { join } from "node:path";
import { existsSync } from "node:fs";
import { randomBytes } from "node:crypto";

process.env.SESSION_SECRET = randomBytes(32).toString("hex");
process.env.GOOGLE_FAKE = "1";
const google = await import("../lib/google.mjs");
const { ACCOUNT_COLUMNS } = await import("../lib/users.mjs");
const { APP_COLUMNS } = await import("../lib/applications.mjs");

// Fake register: headers + two sample applications (one is Sneha's, matched by Employee ID).
const sample = (id, jobId, empId, name, extra = {}) => [id, jobId, "", empId, name, "Assessed", "", JSON.stringify({ id, jobId, empId, name,
  assessStatus: "Assessed", decision: null, mgrApprovalStatus: "Pending", criteria: null, override: null, skills: [], certs: [], ...extra })];
google.fakeReset({ Accounts: [ACCOUNT_COLUMNS], Applications: [APP_COLUMNS,
  sample("APP-5001", "JOB-2026-1001", "EMP-09321", "Rohan Verma"), sample("APP-5003", "JOB-2026-1001", "EMP-11920", "Sneha Kulkarni")] });

const server = createServer(async (req, res) => {
  const rel = new URL(req.url, "http://x").pathname.replace(/^\//, "");
  const file = [join(process.cwd(), rel + ".js"), join(process.cwd(), rel, "index.js")].find(existsSync);
  await (await import(pathToFileURL(file).href)).default(req, res);
}).listen(0);
const base = `http://localhost:${server.address().port}`;

let pass = 0, fail = 0;
const check = (name, cond, detail) => { if (cond) { pass++; console.log("  ✔ " + name); } else { fail++; console.log("  ✖ " + name + (detail ? "  → " + detail : "")); } };
const H = { "Content-Type": "application/json", "X-TalentHub": "1" };
const post = async (path, body, cookie) => { const r = await fetch(base + path, { method: "POST", headers: { ...H, ...(cookie ? { Cookie: cookie } : {}) }, body: JSON.stringify(body) }); return { status: r.status, body: await r.json().catch(() => ({})), cookie: (r.headers.get("set-cookie") || "").split(";")[0] }; };
const get = async (path, cookie) => { const r = await fetch(base + path, { headers: cookie ? { Cookie: cookie } : {} }); return { status: r.status, body: await r.json().catch(() => ({})) }; };
const login = async (l, p, role) => (await post("/api/auth/login", { login: l, password: p, roleCode: role })).cookie;
const PDF = (tag = "") => Buffer.from("%PDF-1.4\n% TalentHub test " + tag + "\n%%EOF");
const DOCX = () => Buffer.concat([Buffer.from([0x50, 0x4B, 0x03, 0x04]), Buffer.from("....word/document.xml....")]);
const upload = async (cookie, name, data, headers = {}) => {
  const r = await fetch(base + "/api/resumes", { method: "POST", body: data, headers: { "Content-Type": "application/octet-stream", "X-TalentHub": "1",
    "X-File-Name": encodeURIComponent(name), ...(cookie ? { Cookie: cookie } : {}), ...headers } });
  return { status: r.status, body: await r.json().catch(() => ({})) };
};
const fileId = async (cookie, name, tag) => (await upload(cookie, name, PDF(tag))).body.fileId;

const PW = "Talent#Test2026x";
const person = (o) => ({ roleCode: "JS", name: "Meera Nair", email: "meera.nair@talenthub.example", empId: "EMP-12455", designation: "Associate PM",
  department: "Product Management", grade: "G5", tenure: 18, relExp: 5, password: PW, ...o });

console.log("Sign-up and accounts");
let r = await get("/api/auth/session");
check("session reports Google connected", r.body.features && r.body.features.googleConnected === true);
r = await post("/api/auth/register", person());
check("Job Seeker sign-up → 201, Active, next key uid_GE0005", r.status === 201 && r.body.user.status === "Active" && r.body.user.uIdKey === "uid_GE0005", JSON.stringify(r.body));
check("sign-up response has no password data", !JSON.stringify(r.body).includes("salt"));
const row = google.fakeReset && (await google.readTab("Accounts"))[1];
check("saved to Accounts tab with a PBKDF2 hash, not the password", row && row[14] === "PBKDF2-SHA256" && !row.join("|").includes(PW));
r = await post("/api/auth/register", person({ empId: "EMP-99999" }));
check("same email again → refused", r.status === 400 && /already exists/.test(r.body.errors.regEmail || ""));
r = await post("/api/auth/register", person({ email: "other.person@talenthub.example" }));
check("same Employee ID again → refused", r.status === 400 && /already has an account/.test(r.body.errors.regEmp || ""));
r = await post("/api/auth/register", person({ email: "x.y@talenthub.example", empId: "EMP-77777", password: "weakpass" }));
check("weak password → refused with the rules", r.status === 400 && /10\+ characters/.test(r.body.errors.regPw || ""));
r = await post("/api/auth/register", person({ roleCode: "AD", email: "boss@talenthub.example", empId: "EMP-66666" }));
check("Admin self-registration → refused", r.status === 400 && r.body.errors.regRole);
check("sign-up account can sign in", !!(await login("meera.nair", PW, "JS")));

r = await post("/api/auth/register", person({ roleCode: "JP", name: "Kiran Shah", email: "kiran.shah@talenthub.example", empId: "EMP-20001" }));
check("Job Poster sign-up → Pending", r.status === 201 && r.body.user.status === "Pending");
r = await post("/api/auth/login", { login: "kiran.shah", password: PW, roleCode: "JP" });
check("Pending account can't sign in yet", r.status === 403 && /approval/.test(r.body.error));

const admin = await login("arjun.mehta", "Admin#2026!", "AD");
const seeker = await login("sneha.kulkarni", "Seeker#2026!", "JS");
const poster = await login("priya.raman", "Poster#2026!", "JP");
r = await post("/api/auth/user-status", { uIdKey: "uid_GE0006", action: "approve" }, seeker);
check("Job Seeker can't approve accounts → 403", r.status === 403);
r = await post("/api/auth/user-status", { uIdKey: "uid_GE0001", action: "disable" }, admin);
check("users.json accounts can't be changed here → 400", r.status === 400);
r = await post("/api/auth/user-status", { uIdKey: "uid_GE0006", action: "approve" }, admin);
check("Admin approves the Job Poster", r.status === 200 && r.body.user.status === "Active");
check("approved Job Poster can sign in", !!(await login("kiran.shah", PW, "JP")));
r = await get("/api/auth/users", admin);
check("Admin list shows both sources", r.status === 200 && r.body.users.some(u => u.source === "register") && r.body.users.some(u => u.source === "file"));

console.log("Applications register");
r = await get("/api/applications", seeker);
check("Job Seeker sees only their own application", r.status === 200 && r.body.applications.length === 1 && r.body.applications[0].id === "APP-5003");
r = await get("/api/applications", poster);
check("Job Poster sees all applications", r.status === 200 && r.body.applications.length === 2);
console.log("Resume files");
r = await upload(seeker, "Sneha.pdf", PDF("sneha"), { "X-TalentHub": "" });
check("upload without the portal header → 400", r.status === 400);
r = await upload(null, "Sneha.pdf", PDF("sneha"));
check("upload signed out → 401", r.status === 401);
r = await upload(seeker, "Sneha.pdf", Buffer.from("<html><script>alert(1)</script></html>"));
check("a non-PDF named .pdf is refused", r.status === 400 && /PDF or Word/.test(r.body.error));
r = await upload(seeker, "Sneha.docx", PDF("x"));
check("a PDF named .docx is refused", r.status === 400);
r = await upload(seeker, "big.pdf", Buffer.concat([PDF("big"), Buffer.alloc(4 * 1024 * 1024)]));
check("a file over 4 MB is refused → 413", r.status === 413);
r = await upload(seeker, "Sneha_CV.docx", DOCX());
check("a Word .docx upload → 201", r.status === 201 && r.body.kind === "docx");
r = await upload(seeker, "..\\..\\Sneha <b>.pdf", PDF("sneha"));
const sneha1 = r.body.fileId;
check("PDF upload → 201, stored in Drive with a cleaned name", r.status === 201 && r.body.name === "Sneha b.pdf" && google.fakeFiles().get(sneha1).meta.appProperties.uploader === "uid_GE0001", JSON.stringify(r.body));

console.log("Applying with a resume");
r = await post("/api/applications", { jobId: "JOB-2026-1002", note: "Keen", resumeFileId: sneha1, resumeFile: "fake.pdf", name: "Someone Else", empId: "EMP-00001" }, seeker);
check("apply → 201, record built from the account (not the request)", r.status === 201 && r.body.application.name === "Sneha Kulkarni" && r.body.application.empId === "EMP-11920" && r.body.application.id === "APP-5004", JSON.stringify(r.body).slice(0, 160));
check("…with the uploaded file attached", r.body.application.resumeFileId === sneha1 && r.body.application.resumeFile === "Sneha b.pdf");
check("Drive file renamed after the application and marked attached", /^APP-5004 · JOB-2026-1002 · Sneha Kulkarni · resume\.pdf$/.test(google.fakeFiles().get(sneha1).meta.name) && google.fakeFiles().get(sneha1).meta.appProperties.state === "attached");
const newId = r.body.application && r.body.application.id;
r = await post("/api/applications", { jobId: "JOB-2026-1004", resumeFileId: sneha1 }, seeker);
check("an attached file can't be reused for another application", r.status === 400 && /already attached/.test(r.body.error));
const posterFile = await fileId(poster, "poster.pdf", "p");
r = await post("/api/applications", { jobId: "JOB-2026-1004", resumeFileId: posterFile }, seeker);
check("someone else's upload can't be attached", r.status === 400 && /someone else/.test(r.body.error));
r = await post("/api/applications", { jobId: "JOB-2026-1004", resumeFileId: "notARealDriveFileId" }, seeker);
check("an unknown file ID is refused", r.status === 400 && /wasn't found/.test(r.body.error));

console.log("Opening resumes");
let v = await fetch(base + "/api/resumes/file?app=" + newId, { headers: { Cookie: seeker } });
let bytes = Buffer.from(await v.arrayBuffer());
check("applicant opens their resume (PDF, inline, not cached)", v.status === 200 && v.headers.get("content-type") === "application/pdf" && /^inline/.test(v.headers.get("content-disposition")) && /no-store/.test(v.headers.get("cache-control")) && bytes.equals(PDF("sneha")));
v = await fetch(base + "/api/resumes/file?app=" + newId, { headers: { Cookie: poster } });
check("Job Poster opens it too", v.status === 200);
const meera = await login("meera.nair", PW, "JS");
v = await fetch(base + "/api/resumes/file?app=" + newId, { headers: { Cookie: meera } });
check("another Job Seeker can't → 404", v.status === 404);
v = await fetch(base + "/api/resumes/file?app=" + newId);
check("signed out can't → 401", v.status === 401);
v = await fetch(base + "/api/resumes/file?app=APP-5001", { headers: { Cookie: poster } });
check("an older application with only a file name → 404 with an explanation", v.status === 404 && /file name was recorded/.test((await v.json()).error));

r = await post("/api/applications", { jobId: "JOB-2026-1002", resumeFileId: "x" }, seeker);
check("applying twice → 409", r.status === 409);
r = await post("/api/applications", { jobId: "JOB-2026-1007", resumeFile: "x.pdf" }, seeker);
check("applying to a Draft job → 400", r.status === 400);
r = await post("/api/applications", { jobId: "JOB-2026-1005", resumeFile: "x.pdf" }, poster);
check("Job Poster can't apply → 403", r.status === 403);

r = await post("/api/applications/update", { id: "APP-5001", patch: { resumeFileId: await fileId(seeker, "hack.pdf", "h") } }, seeker);
check("Job Seeker can't change someone else's application → 403", r.status === 403);
r = await post("/api/applications/update", { id: newId, patch: { resumeFile: "name-only.pdf" } }, seeker);
check("a bare file name (no upload) is refused", r.status === 403 && /resumeFile/.test(r.body.error));
r = await post("/api/applications/update", { id: newId, patch: { criteria: { reqSkills: { score: 100, evidence: [] } } } }, seeker);
check("Job Seeker can't score their own application → 403", r.status === 403);
const sneha2 = await fileId(seeker, "Sneha_v2.pdf", "v2");
r = await post("/api/applications/update", { id: newId, patch: { resumeFileId: sneha2 } }, seeker);
check("Job Seeker replaces their resume → 200, old file kept in history", r.status === 200 && r.body.application.resumeFile === "Sneha_v2.pdf"
  && r.body.application.resumeFileId === sneha2 && r.body.application.resumeHistory.length === 1 && r.body.application.resumeHistory[0].fileId === sneha1);
v = await fetch(base + "/api/resumes/file?app=" + newId, { headers: { Cookie: poster } });
check("…and the new file is the one that opens", Buffer.from(await v.arrayBuffer()).equals(PDF("v2")));
r = await post("/api/applications/update", { id: newId, patch: { decision: "Shortlisted" } }, seeker);
check("Job Seeker can't shortlist themselves → 403", r.status === 403);
r = await post("/api/applications/update", { id: newId, patch: { decision: "Withdrawn", decisionReason: "Changed my mind" } }, seeker);
check("Job Seeker withdraws → 200", r.status === 200 && r.body.application.decision === "Withdrawn");
r = await post("/api/applications/update", { id: newId, patch: { resumeFileId: await fileId(seeker, "late.pdf", "l") } }, seeker);
check("no changes after withdrawal → 403", r.status === 403);

r = await post("/api/applications/update", { id: "APP-5001", patch: { criteria: { reqSkills: { score: 88, evidence: [{ text: "Built React apps", src: "Experience" }] } }, assessStatus: "Assessed", comments: "Strong" } }, poster);
check("Job Poster saves an assessment → 200", r.status === 200 && r.body.application.criteria.reqSkills.score === 88);
r = await post("/api/applications/update", { id: "APP-5001", patch: { override: { score: 90, reason: "short" } } }, poster);
check("override without a 10-character reason → 400", r.status === 400);
r = await post("/api/applications/update", { id: "APP-5001", patch: { mgrApprovalStatus: "Approved" } }, poster);
check("Job Poster can't give manager approval → 403", r.status === 403);
r = await post("/api/applications/update", { id: "APP-5001", patch: { mgrApprovalStatus: "Approved" } }, admin);
check("Admin gives manager approval → 200", r.status === 200 && r.body.application.mgrApprovalStatus === "Approved");
r = await post("/api/applications/update", { id: "APP-5001", patch: { decision: "Shortlisted", decisionReason: "Great fit", decidedBy: "Someone Else" } }, poster);
check("decision is stamped with the real reviewer's name", r.status === 200 && r.body.application.decidedBy === "Priya Raman");
r = await post("/api/applications/update", { id: "APP-5001", patch: { comments: "x".repeat(60000) } }, poster);
check("an oversized request is refused → 413", r.status === 413);
r = await post("/api/applications/update", { id: "APP-5001", patch: { comments: "y".repeat(3000) } }, poster);
check("long comments are trimmed to 1,500 characters", r.status === 200 && r.body.application.comments.length === 1500);

// A register whose tabs have no header row (e.g. someone deleted it) must still show every row.
google.fakeReset({ Accounts: [], Applications: [] });
r = await post("/api/auth/register", person({ name: "Nina Das", email: "nina.das@talenthub.example", empId: "EMP-40001" }));
const nina = await login("nina.das", PW, "JS");
check("first sign-up in a header-less tab can sign in", r.status === 201 && !!nina);
r = await post("/api/applications", { jobId: "JOB-2026-1003", resumeFileId: await fileId(nina, "Nina.pdf", "n") }, nina);
const firstApp = await get("/api/applications", nina);
check("first application in a header-less tab is listed", r.status === 201 && firstApp.body.applications.length === 1);
r = await post("/api/applications/update", { id: firstApp.body.applications[0].id, patch: { resumeFileId: await fileId(nina, "Nina_v2.pdf", "n2") } }, nina);
check("…and can be updated in place", r.status === 200 && (await get("/api/applications", nina)).body.applications[0].resumeFile === "Nina_v2.pdf");

r = await get("/api/applications");
check("applications need sign-in → 401", r.status === 401);
process.env.GOOGLE_FAKE = "";
r = await get("/api/applications", seeker);
check("without Google connected → 503 'not connected'", r.status === 503 && r.body.notConnected === true);
r = await post("/api/auth/register", person({ email: "late.comer@talenthub.example", empId: "EMP-55555" }));
check("sign-up without Google connected → 503", r.status === 503);

server.close();
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
