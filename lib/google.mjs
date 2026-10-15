/**
 * Minimal Google API client for the TalentHub server functions.
 *
 * Auth: an OAuth refresh token for the administrator's Google account (scope drive.file),
 * created once with `npm run google-auth`. Settings come from environment variables:
 *   GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, GOOGLE_REFRESH_TOKEN, REGISTER_SHEET_ID, DRIVE_ROOT_FOLDER_ID
 *
 * GOOGLE_FAKE=1 swaps in an in-memory spreadsheet so tests run without Google.
 */
const TOKEN_URL = "https://oauth2.googleapis.com/token";
const SHEETS = "https://sheets.googleapis.com/v4/spreadsheets";
const DRIVE = "https://www.googleapis.com/drive/v3/files";

export const isFake = () => process.env.GOOGLE_FAKE === "1";
export function isConfigured() {
  if (isFake()) return true;
  return ["GOOGLE_CLIENT_ID", "GOOGLE_CLIENT_SECRET", "GOOGLE_REFRESH_TOKEN", "REGISTER_SHEET_ID"].every(k => (process.env[k] || "").trim());
}
export class NotConfigured extends Error {
  constructor() { super("Google storage isn't connected yet."); this.status = 503; this.notConfigured = true; }
}

/* ---------------- access token (cached per function instance) ---------------- */
let token = { value: "", expires: 0 };
export async function accessToken() {
  if (token.value && token.expires > Date.now() + 60_000) return token.value;
  const body = new URLSearchParams({
    client_id: process.env.GOOGLE_CLIENT_ID, client_secret: process.env.GOOGLE_CLIENT_SECRET,
    refresh_token: process.env.GOOGLE_REFRESH_TOKEN, grant_type: "refresh_token",
  });
  const res = await fetch(TOKEN_URL, { method: "POST", body });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error("Google refused the stored connection (" + (data.error || res.status) + "). Run npm run google-auth again."), { status: 502 });
  token = { value: data.access_token, expires: Date.now() + (data.expires_in || 3600) * 1000 };
  return token.value;
}

async function google(url, opts = {}) {
  const res = await fetch(url, { ...opts, headers: { Authorization: "Bearer " + await accessToken(), "Content-Type": "application/json", ...(opts.headers || {}) } });
  const data = res.status === 204 ? {} : await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error("Google API error " + res.status + ": " + ((data.error && data.error.message) || "unknown")), { status: 502 });
  return data;
}

/* ---------------- in-memory fake (tests) ---------------- */
const fake = { sheets: new Map(), files: new Map() };   // tab -> array of rows; file id -> { meta, data }
export function fakeReset(tabs = {}) { fake.sheets = new Map(Object.entries(tabs).map(([k, v]) => [k, v.map(r => [...r])])); fake.files = new Map(); }
export const fakeFiles = () => fake.files;
const fakeTab = (tab) => { if (!fake.sheets.has(tab)) fake.sheets.set(tab, []); return fake.sheets.get(tab); };

/* ---------------- Sheets helpers (whole-tab reads; rows are arrays of strings) ---------------- */
const sheetId = () => { const id = (process.env.REGISTER_SHEET_ID || "").trim(); if (!id && !isFake()) throw new NotConfigured(); return id; };
const q = (s) => encodeURIComponent(s);

/** All rows of a tab (row 1 = header). */
export async function readTab(tab) {
  if (!isConfigured()) throw new NotConfigured();
  if (isFake()) return fakeTab(tab).map(r => r.map(String));
  const data = await google(`${SHEETS}/${sheetId()}/values/${q(tab + "!A1:Z")}?majorDimension=ROWS`);
  return (data.values || []).map(r => r.map(v => (v == null ? "" : String(v))));
}
/** Appends one row. RAW input: nothing is interpreted as a formula. */
export async function appendRow(tab, row) {
  if (!isConfigured()) throw new NotConfigured();
  if (isFake()) { fakeTab(tab).push(row.map(String)); return; }
  await google(`${SHEETS}/${sheetId()}/values/${q(tab + "!A1")}:append?valueInputOption=RAW&insertDataOption=INSERT_ROWS`,
    { method: "POST", body: JSON.stringify({ values: [row.map(String)] }) });
}
/** Overwrites one row (1-based sheet row number). */
export async function writeRow(tab, rowNumber, row) {
  if (!isConfigured()) throw new NotConfigured();
  if (isFake()) { fakeTab(tab)[rowNumber - 1] = row.map(String); return; }
  await google(`${SHEETS}/${sheetId()}/values/${q(`${tab}!A${rowNumber}`)}?valueInputOption=RAW`,
    { method: "PUT", body: JSON.stringify({ values: [row.map(String)] }) });
}

/* ---------------- Drive files (resumes) ---------------- */
const UPLOAD = "https://www.googleapis.com/upload/drive/v3/files";
const FILE_FIELDS = "id,name,size,mimeType,appProperties,parents,trashed";
/** The Drive folder resumes go into (created by npm run google-auth). */
export function resumeFolderId() {
  const id = (process.env.DRIVE_ROOT_FOLDER_ID || "").trim();
  if (!id && !isFake()) throw new NotConfigured();
  return id || "fake-folder";
}

/** Uploads a file (≤ 5 MB) into `parentId` with app properties. Returns its Drive metadata. */
export async function uploadFile({ name, mimeType, parentId, appProperties }, data) {
  if (!isConfigured()) throw new NotConfigured();
  const meta = { name, mimeType, parents: [parentId], appProperties };
  if (isFake()) {
    const id = "fake-" + (fake.files.size + 1) + "-" + Date.now().toString(36);
    const m = { id, ...meta, size: String(data.length), trashed: false };
    fake.files.set(id, { meta: m, data: Buffer.from(data) });
    return { ...m };
  }
  const boundary = "talenthub" + Math.random().toString(36).slice(2);
  const body = Buffer.concat([
    Buffer.from(`--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(meta)}\r\n--${boundary}\r\nContent-Type: ${mimeType}\r\n\r\n`),
    data, Buffer.from(`\r\n--${boundary}--`)]);
  const res = await fetch(`${UPLOAD}?uploadType=multipart&fields=${FILE_FIELDS}`, { method: "POST", body,
    headers: { Authorization: "Bearer " + await accessToken(), "Content-Type": `multipart/related; boundary=${boundary}` } });
  const out = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error("Google Drive upload failed (" + res.status + ": " + ((out.error && out.error.message) || "unknown") + ")"), { status: 502 });
  return out;
}
/** Drive metadata of a file TalentHub created, or null if it doesn't exist / isn't visible. */
export async function getFile(id) {
  if (!isConfigured()) throw new NotConfigured();
  if (!/^[A-Za-z0-9_-]{10,100}$/.test(String(id))) return null;
  if (isFake()) { const f = fake.files.get(id); return f ? { ...f.meta, appProperties: { ...f.meta.appProperties } } : null; }
  try { return await google(`${DRIVE}/${id}?fields=${FILE_FIELDS}`); }
  catch (e) { if (/ 404:/.test(e.message)) return null; throw e; }
}
/** Renames a file and/or merges app properties. */
export async function updateFile(id, { name, appProperties }) {
  if (!isConfigured()) throw new NotConfigured();
  if (isFake()) { const f = fake.files.get(id); if (name) f.meta.name = name; if (appProperties) Object.assign(f.meta.appProperties, appProperties); return; }
  await google(`${DRIVE}/${id}?fields=id`, { method: "PATCH", body: JSON.stringify({ ...(name ? { name } : {}), ...(appProperties ? { appProperties } : {}) }) });
}
/** The file's bytes. */
export async function downloadFile(id) {
  if (!isConfigured()) throw new NotConfigured();
  if (isFake()) { const f = fake.files.get(id); if (!f) throw Object.assign(new Error("File not found."), { status: 404 }); return f.data; }
  const res = await fetch(`${DRIVE}/${id}?alt=media`, { headers: { Authorization: "Bearer " + await accessToken() } });
  if (!res.ok) throw Object.assign(new Error("Google Drive download failed (" + res.status + ")"), { status: res.status === 404 ? 404 : 502 });
  return Buffer.from(await res.arrayBuffer());
}

/* ---------------- one-time setup helpers (used by scripts/google-auth.mjs) ---------------- */
export async function createFolder(name, parentId) {
  return google(DRIVE + "?fields=id,name,webViewLink", { method: "POST",
    body: JSON.stringify({ name, mimeType: "application/vnd.google-apps.folder", ...(parentId ? { parents: [parentId] } : {}) }) });
}
export async function createSpreadsheet(title, tabs) {
  return google(SHEETS, { method: "POST", body: JSON.stringify({ properties: { title }, sheets: tabs.map(t => ({ properties: { title: t } })) }) });
}
export async function moveToFolder(fileId, folderId) {
  const meta = await google(`${DRIVE}/${fileId}?fields=parents`);
  const remove = (meta.parents || []).join(",");
  return google(`${DRIVE}/${fileId}?addParents=${folderId}${remove ? "&removeParents=" + remove : ""}&fields=id,parents`, { method: "PATCH", body: "{}" });
}
export async function writeRange(spreadsheetId, range, rows) {
  return google(`${SHEETS}/${spreadsheetId}/values/${q(range)}?valueInputOption=RAW`, { method: "PUT", body: JSON.stringify({ values: rows }) });
}
