/**
 * Resume files in Google Drive (the "TalentHub Resumes" folder).
 *
 * 1. upload:  the browser sends the file to /api/resumes; the server checks its real
 *             contents (PDF or Word .docx) and stores it, tagged with the uploader's key.
 * 2. claim:   applying / updating an application names the uploaded file's ID; the server
 *             accepts it only if this user uploaded it and it isn't attached elsewhere.
 * 3. attach:  after the application is saved, the file is renamed after the application
 *             and marked attached.
 * Old files are kept when a resume is replaced (listed in the record's resumeHistory).
 */
import { uploadFile, getFile, updateFile, resumeFolderId } from "./google.mjs";

export const MAX_RESUME_BYTES = 4 * 1024 * 1024;   // Vercel functions accept request bodies up to 4.5 MB
export const RESUME_TYPES = {
  pdf: "application/pdf",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
};

/** What the bytes really are: "pdf", "docx" or "". (Same rules as the browser check.) */
export function sniff(buf) {
  if (buf.length >= 5 && buf.subarray(0, 5).toString("latin1") === "%PDF-") return "pdf";
  if (buf.length >= 4 && buf[0] === 0x50 && buf[1] === 0x4B && buf[2] === 0x03 && buf[3] === 0x04)
    return buf.toString("latin1").includes("word/document.xml") ? "docx" : "";
  return "";
}

/** A file name safe for Drive and for a download header: no paths, controls or odd characters. */
export function safeName(name) {
  const base = String(name || "").split(/[\\/]/).pop().normalize("NFC")
    .replace(/[\u0000-\u001f\u007f"<>|:*?]/g, "").replace(/\s+/g, " ").trim().slice(0, 120);
  return base || "resume";
}

/** Checks and stores an uploaded resume. Throws { status, message } for anything unacceptable. */
export async function storeResume(user, fileName, data) {
  const bad = (msg, status = 400) => { throw Object.assign(new Error(msg), { status }); };
  if (!data.length) bad("That file is empty. Choose your saved resume.");
  if (data.length > MAX_RESUME_BYTES) bad(`That file is ${(data.length / 1048576).toFixed(1)} MB; the limit is 4 MB.`, 413);
  const name = safeName(fileName), ext = (name.split(".").pop() || "").toLowerCase();
  const kind = sniff(data);
  if (!kind) bad("Only PDF or Word (.docx) resumes are accepted, and this file isn't either.");
  if (kind !== ext) bad(kind === "pdf" ? "That file is a PDF but its name doesn't end in .pdf." : "That file is a Word document but its name doesn't end in .docx.");
  const meta = await uploadFile({
    name: `Unattached · ${user.name} · ${name}`, mimeType: RESUME_TYPES[kind], parentId: resumeFolderId(),
    appProperties: { app: "talenthub", uploader: user.uIdKey, originalName: name.slice(0, 100), state: "unattached" },
  }, data);
  return { fileId: meta.id, name, size: data.length, kind };
}

/**
 * Verifies that `user` may attach Drive file `fileId`. Returns { id, name, size } for the record.
 */
export async function claimResume(user, fileId) {
  const deny = (msg) => { throw Object.assign(new Error(msg), { status: 400 }); };
  const f = await getFile(String(fileId || ""));
  const p = (f && f.appProperties) || {};
  if (!f || f.trashed || p.app !== "talenthub") deny("That resume upload wasn't found. Upload the file again.");
  if (p.uploader !== user.uIdKey) deny("That resume was uploaded by someone else.");
  if (p.state !== "unattached") deny("That resume is already attached to an application. Upload the file again.");
  return { id: f.id, name: p.originalName || "resume", size: Number(f.size) || 0 };
}

/** Marks a claimed file as belonging to an application and gives it a readable name. */
export async function attachResume(file, rec) {
  const ext = (file.name.split(".").pop() || "").toLowerCase();
  await updateFile(file.id, {
    name: `${rec.id} · ${rec.jobId} · ${rec.name} · resume.${ext}`.slice(0, 200),
    appProperties: { state: "attached", appId: rec.id },
  });
}

/** Record fields for a newly attached resume, keeping the previous one in resumeHistory. */
export function resumeFields(rec, file) {
  const history = Array.isArray(rec.resumeHistory) ? rec.resumeHistory.slice(-9) : [];
  if (rec.resumeFileId) history.push({ fileId: rec.resumeFileId, name: rec.resumeFile, at: rec.resumeUpdatedAt || "" });
  return { resumeFile: file.name, resumeSize: file.size, resumeFileId: file.id, resumeUpdatedAt: new Date().toISOString().slice(0, 16), resumeHistory: history };
}
