/**
 * Server-side access to data/users.json (bundled with the functions, never served publicly).
 */
import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { pbkdf2, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";

const pbkdf2Async = promisify(pbkdf2);
const FILE = join(process.cwd(), "data", "users.json");
export const ROLE_NAMES = { JS: "Job Seeker", JP: "Job Poster", AD: "Admin" };

let cache = { mtime: 0, users: [] };
/** Loads users.json, re-reading it only when the file changes. */
export function loadUsers() {
  const mtime = statSync(FILE).mtimeMs;
  if (mtime !== cache.mtime) {
    const doc = JSON.parse(readFileSync(FILE, "utf8"));
    cache = { mtime, users: Array.isArray(doc.users) ? doc.users : [] };
  }
  return cache.users;
}

const norm = (s) => String(s || "").trim().toLowerCase();
export const findByLogin = (login) => { const l = norm(login); return loadUsers().find(u => norm(u.userId) === l || norm(u.email) === l) || null; };
export const findByKey = (key) => loadUsers().find(u => u.uIdKey === key) || null;

// A fixed hash entry used for unknown accounts, so they take as long to check as real ones.
const DUMMY = { algo: "PBKDF2-SHA256", iterations: 600000, salt: "AAAAAAAAAAAAAAAAAAAAAA==", hash: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=" };

/** Checks a password against a PBKDF2-SHA256 entry in constant time. */
export async function verifyPassword(password, entry) {
  const p = entry && entry.algo === "PBKDF2-SHA256" && entry.iterations >= 100000 ? entry : DUMMY;
  const expected = Buffer.from(p.hash, "base64");
  const actual = await pbkdf2Async(String(password), Buffer.from(p.salt, "base64"), p.iterations, expected.length || 32, "sha256");
  return p !== DUMMY && actual.length === expected.length && timingSafeEqual(actual, expected);
}
export { DUMMY };

/** The account details the portal may see (never the password entry). */
export function publicUser(u) {
  return { uIdKey: u.uIdKey, userId: u.userId, name: u.name, email: u.email, empId: u.empId, roleCode: u.roleCode,
    roleName: ROLE_NAMES[u.roleCode] || u.roleCode, department: u.department || "", grade: u.grade || "",
    designation: u.designation || "", tenureMonths: Number(u.tenureMonths) || 0, relExp: Number(u.relExp) || 0,
    education: u.education || "", status: u.status, createdAt: u.createdAt || "" };
}
