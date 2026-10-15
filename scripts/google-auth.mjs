/**
 * One-time Google setup for TalentHub (personal Google account, scope drive.file).
 *
 *   npm run google-auth -- "C:\path\to\client_secret_….json"
 *
 * 1. Opens Google in your browser so you can approve access (OAuth with PKCE, local loopback).
 * 2. Creates a private "TalentHub Resumes" folder in your Drive and a "TalentHub Register"
 *    sheet inside it (tabs: About, Accounts, Applications), with sample applications.
 * 3. Saves the settings to Vercel (production, sensitive) and to .env.local for local testing.
 *    Secret values are never printed.
 *
 * Options:  --no-sample   start with an empty Applications tab
 *           --no-vercel   only write .env.local
 *           --reuse       keep the folder and sheet IDs already in .env.local (only renew the token)
 */
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { createServer } from "node:http";
import { randomBytes, createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { join } from "node:path";

const args = process.argv.slice(2);
const flag = (f) => args.includes(f);
const clientPath = args.find(a => !a.startsWith("--"));
const SCOPE = "https://www.googleapis.com/auth/drive.file";
const ENV_FILE = join(process.cwd(), ".env.local");
const fail = (msg) => { console.error("\n✖ " + msg + "\n"); process.exit(1); };

// ---------------------------------------------------------------- client file
if (!clientPath) fail('Give the path to the downloaded client JSON, e.g.\n  npm run google-auth -- "C:\\Users\\Admin\\TalentHub-secrets\\talenthub-oauth-client.json"');
if (!existsSync(clientPath)) fail("File not found: " + clientPath);
if (clientPath.startsWith(process.cwd())) fail("Keep the client file outside the project folder, so it can't be committed. Move it and try again.");
let client;
try { client = JSON.parse(readFileSync(clientPath, "utf8")); } catch { fail("That file isn't valid JSON."); }
if (!client.installed) fail(client.web ? "That is a Web application client. Create a *Desktop app* client (Part D) and use its JSON." : "That doesn't look like a Google OAuth client file.");
const { client_id: CLIENT_ID, client_secret: CLIENT_SECRET } = client.installed;

// ---------------------------------------------------------------- existing local settings
const env = {};
if (existsSync(ENV_FILE)) for (const line of readFileSync(ENV_FILE, "utf8").split(/\r?\n/)) {
  const m = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim()); if (m) env[m[1]] = m[2];
}

// ---------------------------------------------------------------- OAuth (PKCE + loopback)
const verifier = randomBytes(32).toString("base64url");
const challenge = createHash("sha256").update(verifier).digest("base64url");
const state = randomBytes(16).toString("hex");

const code = await new Promise((resolve, reject) => {
  const server = createServer((req, res) => {
    const url = new URL(req.url, "http://127.0.0.1");
    if (url.pathname !== "/") { res.statusCode = 404; return res.end(); }
    const ok = url.searchParams.get("state") === state && url.searchParams.get("code");
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.end(ok ? "<h2>TalentHub is connected to Google.</h2><p>You can close this tab and return to the terminal.</p>"
               : "<h2>Google access wasn't granted.</h2><p>Return to the terminal for details.</p>");
    server.close();
    ok ? resolve(url.searchParams.get("code")) : reject(new Error(url.searchParams.get("error") || "state mismatch"));
  }).listen(0, "127.0.0.1", () => {
    const redirect = `http://127.0.0.1:${server.address().port}`;
    globalThis.REDIRECT = redirect;
    const auth = "https://accounts.google.com/o/oauth2/v2/auth?" + new URLSearchParams({
      client_id: CLIENT_ID, redirect_uri: redirect, response_type: "code", scope: SCOPE, access_type: "offline", prompt: "consent",
      code_challenge: challenge, code_challenge_method: "S256", state }).toString();
    console.log("\nOpening Google in your browser to connect TalentHub (Drive: only files TalentHub creates).");
    console.log("If it doesn't open, copy this address into your browser:\n\n  " + auth + "\n");
    const opener = process.platform === "win32" ? ["rundll32", ["url.dll,FileProtocolHandler", auth]]
      : process.platform === "darwin" ? ["open", [auth]] : ["xdg-open", [auth]];
    spawn(opener[0], opener[1], { stdio: "ignore", detached: true }).on("error", () => {}).unref();
  });
  setTimeout(() => { server.close(); reject(new Error("timed out after 5 minutes")); }, 5 * 60_000).unref();
}).catch(e => fail("Google sign-in didn't complete: " + e.message));

const tokenRes = await fetch("https://oauth2.googleapis.com/token", { method: "POST", body: new URLSearchParams({
  code, client_id: CLIENT_ID, client_secret: CLIENT_SECRET, redirect_uri: globalThis.REDIRECT, grant_type: "authorization_code", code_verifier: verifier }) });
const tokens = await tokenRes.json();
if (!tokenRes.ok || !tokens.refresh_token) fail("Google didn't return a long-lived token (" + (tokens.error_description || tokens.error || "no refresh token") + ").");
if (!String(tokens.scope || "").split(" ").every(s => s === SCOPE)) fail("Unexpected permissions were granted: " + tokens.scope);
console.log("✔ Google access approved (drive.file only)");

// ---------------------------------------------------------------- Drive folder + register sheet
const api = async (url, opts = {}) => {
  const r = await fetch(url, { ...opts, headers: { Authorization: "Bearer " + tokens.access_token, "Content-Type": "application/json" } });
  const d = await r.json().catch(() => ({}));
  if (!r.ok) fail("Google API error " + r.status + ": " + ((d.error && d.error.message) || "unknown"));
  return d;
};
let folderId = env.DRIVE_ROOT_FOLDER_ID, sheetId = env.REGISTER_SHEET_ID, folderLink = "", sheetLink = "";
if (flag("--reuse") && folderId && sheetId) {
  console.log("✔ Keeping the existing folder and register sheet");
} else {
  const folder = await api("https://www.googleapis.com/drive/v3/files?fields=id,webViewLink", { method: "POST",
    body: JSON.stringify({ name: "TalentHub Resumes", mimeType: "application/vnd.google-apps.folder" }) });
  folderId = folder.id; folderLink = folder.webViewLink;
  const sheet = await api("https://sheets.googleapis.com/v4/spreadsheets", { method: "POST", body: JSON.stringify({
    properties: { title: "TalentHub Register" }, sheets: ["About", "Accounts", "Applications"].map(t => ({ properties: { title: t } })) }) });
  sheetId = sheet.spreadsheetId; sheetLink = sheet.spreadsheetUrl;
  const meta = await api(`https://www.googleapis.com/drive/v3/files/${sheetId}?fields=parents`);
  await api(`https://www.googleapis.com/drive/v3/files/${sheetId}?addParents=${folderId}&removeParents=${(meta.parents || []).join(",")}&fields=id`, { method: "PATCH", body: "{}" });

  const write = (range, values) => api(`https://sheets.googleapis.com/v4/spreadsheets/${sheetId}/values/${encodeURIComponent(range)}?valueInputOption=RAW`,
    { method: "PUT", body: JSON.stringify({ values }) });
  await write("About!A1", [["TalentHub Register"],
    ["Managed by TalentHub (https://talenthub-jobportal.vercel.app). Please don't rename the tabs, reorder columns or edit the 'record' column by hand."],
    ["Accounts: accounts created with Create account on the sign-in page. Passwords are stored only as salted PBKDF2 hashes."],
    ["Applications: one row per application; the 'record' column holds the full details as JSON."],
    ["Resumes will be stored as files in this folder (TalentHub Resumes) once resume storage is switched on."]]);
  await write("Accounts!A1", [["uIdKey", "userId", "name", "email", "empId", "roleCode", "department", "grade", "designation",
    "tenureMonths", "relExp", "education", "status", "createdAt", "passwordAlgo", "passwordIterations", "passwordSalt", "passwordHash"]]);
  const rows = [["appId", "jobId", "uIdKey", "empId", "name", "status", "updatedAt", "record"]];
  if (!flag("--no-sample")) {
    // Sample applications from the portal's demo data, so dashboards and evaluations have content.
    const html = readFileSync(join(process.cwd(), "TalentHub.html"), "utf8");
    const a = html.indexOf("function seedData()"), b = html.indexOf("return { lookups", a), e = html.indexOf("\n}\n", b) + 2;
    const CONFIG = { today: new Date().toISOString().slice(0, 10) };   // used inside seedData
    const seed = new Function("CONFIG", "return (" + html.slice(a, e) + ")()")(CONFIG);
    const now = new Date().toISOString();
    for (const r of seed.apps) rows.push([r.id, r.jobId, "", r.empId, r.name, r.decision || r.assessStatus || "", now, JSON.stringify(r)]);
  }
  await write("Applications!A1", rows);
  console.log(`✔ Created Drive folder "TalentHub Resumes" and sheet "TalentHub Register"` + (rows.length > 1 ? ` (${rows.length - 1} sample applications)` : ""));
}

// ---------------------------------------------------------------- save settings
const settings = { GOOGLE_CLIENT_ID: CLIENT_ID, GOOGLE_CLIENT_SECRET: CLIENT_SECRET, GOOGLE_REFRESH_TOKEN: tokens.refresh_token,
  DRIVE_ROOT_FOLDER_ID: folderId, REGISTER_SHEET_ID: sheetId };
const merged = { ...env, ...settings };
writeFileSync(ENV_FILE, "# Local settings for npm run dev (git-ignored). Written by npm run google-auth.\n" +
  Object.entries(merged).map(([k, v]) => `${k}=${v}`).join("\n") + "\n");
console.log("✔ Saved settings to .env.local (for npm run dev; not committed)");

if (!flag("--no-vercel")) {
  const addEnv = (name, value) => new Promise((resolve) => {
    const p = spawn("npx", ["--yes", "vercel@latest", "env", "add", name, "production", "--sensitive", "--force", "--yes"],
      { shell: process.platform === "win32", stdio: ["pipe", "ignore", "pipe"] });
    let err = ""; p.stderr.on("data", d => { err += d; });
    p.on("close", (codeOut) => resolve(codeOut === 0 ? "" : err.split(/\r?\n/).filter(l => /error/i.test(l)).slice(0, 2).join(" ") || "exit " + codeOut));
    p.stdin.end(value);
  });
  for (const [k, v] of Object.entries(settings)) {
    const err = await addEnv(k, v);
    console.log(err ? `✖ Vercel: couldn't save ${k} (${err})` : `✔ Vercel: saved ${k} (production, hidden)`);
  }
  console.log("\nVercel uses new settings from the next deployment (push to main, or redeploy).");
}

if (folderLink) console.log("\nDrive folder:   " + folderLink + "\nRegister sheet: " + sheetLink);
console.log("\nDone. You can move the \"TalentHub Resumes\" folder anywhere in your Drive; TalentHub keeps access because it created it.\n");
