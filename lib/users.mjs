/**
 * Server-side account directory.
 *  - data/users.json: accounts maintained in the repository (bundled with the functions, not published)
 *  - "Accounts" tab of the register Google Sheet: accounts created with Create account (sign-up)
 * Both are merged; a uIdKey or user ID can exist only once across the two.
 */
import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { pbkdf2, timingSafeEqual, randomBytes } from "node:crypto";
import { promisify } from "node:util";
import { isConfigured, readTab, appendRow, writeRow } from "./google.mjs";

const pbkdf2Async = promisify(pbkdf2);
const FILE = join(process.cwd(), "data", "users.json");
export const ROLE_NAMES = { JS: "Job Seeker", JP: "Job Poster", AD: "Admin" };
export const PBKDF2_ITERATIONS = 600000;
export const ACCOUNTS_TAB = "Accounts";
export const ACCOUNT_COLUMNS = ["uIdKey", "userId", "name", "email", "empId", "roleCode", "department", "grade", "designation",
  "tenureMonths", "relExp", "education", "status", "createdAt", "passwordAlgo", "passwordIterations", "passwordSalt", "passwordHash"];

/* ---------------- users.json ---------------- */
let fileCache = { mtime: 0, users: [] };
export function fileUsers() {
  const mtime = statSync(FILE).mtimeMs;
  if (mtime !== fileCache.mtime) {
    const doc = JSON.parse(readFileSync(FILE, "utf8"));
    fileCache = { mtime, users: (Array.isArray(doc.users) ? doc.users : []).map(u => ({ ...u, source: "file" })) };
  }
  return fileCache.users;
}

/* ---------------- register sheet ---------------- */
let sheetCache = { at: 0, users: [] };
const SHEET_CACHE_MS = 10_000;
export function invalidateSheetUsers() { sheetCache.at = 0; }

function fromRow(row, rowNumber) {
  const o = Object.fromEntries(ACCOUNT_COLUMNS.map((c, i) => [c, row[i] == null ? "" : String(row[i])]));
  return { uIdKey: o.uIdKey, userId: o.userId.toLowerCase(), name: o.name, email: o.email.toLowerCase(), empId: o.empId, roleCode: o.roleCode,
    department: o.department, grade: o.grade, designation: o.designation, tenureMonths: Number(o.tenureMonths) || 0, relExp: Number(o.relExp) || 0,
    education: o.education, status: o.status, createdAt: o.createdAt, source: "register", rowNumber,
    password: { algo: o.passwordAlgo, iterations: Number(o.passwordIterations) || 0, salt: o.passwordSalt, hash: o.passwordHash } };
}
export function toRow(u) {
  return ACCOUNT_COLUMNS.map(c => c === "passwordAlgo" ? u.password.algo : c === "passwordIterations" ? u.password.iterations
    : c === "passwordSalt" ? u.password.salt : c === "passwordHash" ? u.password.hash : (u[c] ?? ""));
}

/** Accounts from the sheet; [] when Google isn't connected or can't be reached (users.json still works). */
export async function sheetUsers({ fresh = false } = {}) {
  if (!isConfigured()) return [];
  if (!fresh && sheetCache.at > Date.now() - SHEET_CACHE_MS) return sheetCache.users;
  try {
    const rows = await readTab(ACCOUNTS_TAB);
    // Row numbers are 1-based sheet rows; the header row (if present) is skipped by its first cell.
    const users = rows.map((r, i) => fromRow(r, i + 1)).filter(u => u.uIdKey && u.userId && u.uIdKey !== ACCOUNT_COLUMNS[0]);
    sheetCache = { at: Date.now(), users };
    return users;
  } catch (e) {
    console.error("Accounts sheet unavailable:", e.message);
    return sheetCache.users;   // last known list (may be empty)
  }
}

/** All accounts; users.json wins if the same key or user ID appears in both. */
export async function allUsers(opts) {
  const file = fileUsers();
  const taken = new Set(file.flatMap(u => [u.uIdKey, String(u.userId).toLowerCase()]));
  return file.concat((await sheetUsers(opts)).filter(u => !taken.has(u.uIdKey) && !taken.has(u.userId)));
}

const norm = (s) => String(s || "").trim().toLowerCase();
export async function findByLogin(login) { const l = norm(login); return (await allUsers()).find(u => norm(u.userId) === l || norm(u.email) === l) || null; }
export async function findByKey(key) { return (await allUsers()).find(u => u.uIdKey === key) || null; }
export async function loadUsers(opts) { return allUsers(opts); }

/** Next sequential primary key, e.g. uid_GE0005. */
export function nextUidKey(users) {
  const nums = users.map(u => /^uid_GE(\d+)$/.exec(String(u.uIdKey || ""))).filter(Boolean).map(m => Number(m[1]));
  return "uid_GE" + String((nums.length ? Math.max(...nums) : 0) + 1).padStart(4, "0");
}

export async function appendAccount(user) { await appendRow(ACCOUNTS_TAB, toRow(user)); invalidateSheetUsers(); }
export async function updateAccount(user) {
  if (user.source !== "register" || !user.rowNumber) throw Object.assign(new Error("Only accounts created through sign-up can be changed here."), { status: 400 });
  await writeRow(ACCOUNTS_TAB, user.rowNumber, toRow(user)); invalidateSheetUsers();
}

/* ---------------- passwords ---------------- */
const DUMMY = { algo: "PBKDF2-SHA256", iterations: PBKDF2_ITERATIONS, salt: "AAAAAAAAAAAAAAAAAAAAAA==", hash: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=" };
export { DUMMY };

/** Checks a password against a PBKDF2-SHA256 entry in constant time. */
export async function verifyPassword(password, entry) {
  const p = entry && entry.algo === "PBKDF2-SHA256" && entry.iterations >= 100000 && entry.hash ? entry : DUMMY;
  const expected = Buffer.from(p.hash, "base64");
  const actual = await pbkdf2Async(String(password), Buffer.from(p.salt, "base64"), p.iterations, expected.length || 32, "sha256");
  return p !== DUMMY && actual.length === expected.length && timingSafeEqual(actual, expected);
}
export async function hashPassword(password) {
  const salt = randomBytes(16);
  const hash = await pbkdf2Async(String(password), salt, PBKDF2_ITERATIONS, 32, "sha256");
  return { algo: "PBKDF2-SHA256", iterations: PBKDF2_ITERATIONS, salt: salt.toString("base64"), hash: hash.toString("base64") };
}

/** The account details the portal may see (never the password entry). */
export function publicUser(u) {
  return { uIdKey: u.uIdKey, userId: u.userId, name: u.name, email: u.email, empId: u.empId, roleCode: u.roleCode,
    roleName: ROLE_NAMES[u.roleCode] || u.roleCode, department: u.department || "", grade: u.grade || "",
    designation: u.designation || "", tenureMonths: Number(u.tenureMonths) || 0, relExp: Number(u.relExp) || 0,
    education: u.education || "", status: u.status, createdAt: u.createdAt || "", source: u.source === "register" ? "register" : "file" };
}
