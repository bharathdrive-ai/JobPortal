/**
 * POST /api/auth/register   — Create account (sign-up)
 * Body: { roleCode: "JS"|"JP", name, email, empId, designation, department, grade, tenure, relExp, password }
 * Validates everything on the server, hashes the password (PBKDF2-SHA256) and appends the
 * account to the "Accounts" tab of the register sheet. Job Seekers are Active at once;
 * Job Posters are Pending until an Admin approves them. Admin accounts can't self-register.
 */
import { sendJson, readJson, checkPost, clientIp } from "../../lib/http.mjs";
import { allUsers, nextUidKey, hashPassword, appendAccount, publicUser, ROLE_NAMES } from "../../lib/users.mjs";
import { isConfigured } from "../../lib/google.mjs";
import { lockedFor, recordFailure } from "../../lib/ratelimit.mjs";

const PW_RULES = [[p => p.length >= 10, "10+ characters"], [p => /[a-z]/.test(p) && /[A-Z]/.test(p), "upper and lower case"],
  [p => /\d/.test(p), "a number"], [p => /[^A-Za-z0-9]/.test(p), "a symbol"]];

export default async function handler(req, res) {
  if (!checkPost(req, res)) return;
  if (!isConfigured()) return sendJson(res, 503, { error: "Sign-up isn't available yet: the accounts register isn't connected." });
  try {
    // Per network address: up to 20 attempts and 5 completed sign-ups per 5 minutes.
    const ip = clientIp(req), tryKey = ["signuptry:" + ip], doneKey = ["signup:" + ip];
    if (lockedFor(tryKey.concat(doneKey))) return sendJson(res, 429, { error: "Too many sign-ups from this network. Try again in a few minutes." });
    recordFailure(tryKey);

    const b = await readJson(req);
    const s = (v, max) => String(v == null ? "" : v).trim().slice(0, max);
    const f = { roleCode: s(b.roleCode, 2), name: s(b.name, 80).replace(/\s+/g, " "), email: s(b.email, 120).toLowerCase(),
      empId: s(b.empId, 9).toUpperCase(), designation: s(b.designation, 80), department: s(b.department, 60), grade: s(b.grade, 10),
      tenure: b.tenure, relExp: b.relExp, password: String(b.password || "").slice(0, 200) };
    const errors = {};
    if (!["JS", "JP"].includes(f.roleCode)) errors.regRole = "Choose Job Seeker or Job Poster.";
    if (!/^[\p{L}][\p{L} .'-]{1,79}$/u.test(f.name)) errors.regName = "Enter your full name (letters, spaces, . ' -).";
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]{2,}$/.test(f.email)) errors.regEmail = "Enter a valid work email address.";
    if (!/^EMP-\d{5}$/.test(f.empId)) errors.regEmp = "Employee ID looks like EMP-12345.";
    if (!f.designation) errors.regDesig = "Enter your current designation.";
    if (!f.department) errors.regDept = "Choose your department.";
    if (!f.grade) errors.regGrade = "Choose your grade.";
    const tenure = Number(f.tenure), exp = Number(f.relExp);
    if (f.tenure === "" || !Number.isInteger(tenure) || tenure < 0 || tenure > 600) errors.regTenure = "Enter whole months from 0 to 600.";
    if (f.relExp === "" || isNaN(exp) || exp < 0 || exp > 50) errors.regExp = "Enter years from 0 to 50.";
    const missing = PW_RULES.filter(([ok]) => !ok(f.password)).map(([, label]) => label);
    const lower = f.password.toLowerCase();
    if ([f.name.split(" ")[0], f.email.split("@")[0], f.empId].some(x => x && x.length >= 3 && lower.includes(x.toLowerCase()))) missing.push("not to contain your name, email or ID");
    if (missing.length) errors.regPw = "Password needs: " + missing.join(", ") + ".";

    const users = await allUsers({ fresh: true });
    const userId = f.email.split("@")[0].replace(/[^a-z0-9._-]/g, "").slice(0, 40);
    if (!errors.regEmail && (userId.length < 3 || users.some(u => u.email === f.email || String(u.userId).toLowerCase() === userId)))
      errors.regEmail = userId.length < 3 ? "Use an email whose name part has at least 3 letters or digits." : "An account with this email already exists. Sign in instead.";
    if (!errors.regEmp && users.some(u => u.empId === f.empId)) errors.regEmp = "This Employee ID already has an account.";
    if (Object.keys(errors).length) return sendJson(res, 400, { error: "Please correct the highlighted fields.", errors });

    const user = { uIdKey: nextUidKey(users), userId, name: f.name, email: f.email, empId: f.empId, roleCode: f.roleCode,
      department: f.department, grade: f.grade, designation: f.designation, tenureMonths: tenure, relExp: exp, education: "",
      status: f.roleCode === "JP" ? "Pending" : "Active", createdAt: new Date().toISOString().slice(0, 10),
      password: await hashPassword(f.password), source: "register" };
    await appendAccount(user);
    recordFailure(doneKey);   // counts completed sign-ups
    return sendJson(res, 201, { user: publicUser(user), roleName: ROLE_NAMES[user.roleCode] });
  } catch (e) {
    if (e instanceof SyntaxError) return sendJson(res, 400, { error: "Bad request." });
    console.error("register:", e.message);
    return sendJson(res, e.status === 503 ? 503 : 500, { error: e.status === 503 ? e.message : "Sign-up failed. Try again." });
  }
}
