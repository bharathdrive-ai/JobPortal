/**
 * Tests the server sign-in API end to end over HTTP.
 * Uses the demo accounts documented in docs/demo-accounts.md.
 * Usage:  npm run test:auth
 */
import { createServer } from "node:http";
import { pathToFileURL } from "node:url";
import { join } from "node:path";
import { randomBytes } from "node:crypto";

process.env.SESSION_SECRET = randomBytes(32).toString("hex");
const { createToken } = await import("../lib/session.mjs");
const { findByLogin } = await import("../lib/users.mjs");

const server = createServer(async (req, res) => {
  const path = new URL(req.url, "http://x").pathname.replace(/^\//, "");
  const mod = await import(pathToFileURL(join(process.cwd(), path + ".js")).href);
  await mod.default(req, res);
}).listen(0);
const base = `http://localhost:${server.address().port}`;

let pass = 0, fail = 0;
const check = (name, cond, detail) => { if (cond) { pass++; console.log("  ✔ " + name); } else { fail++; console.log("  ✖ " + name + (detail ? "  → " + detail : "")); } };
const post = (path, body, extra = {}) => fetch(base + path, { method: "POST", headers: { "Content-Type": "application/json", "X-TalentHub": "1", ...extra }, body: JSON.stringify(body) });
const get = (path, cookie) => fetch(base + path, { headers: cookie ? { Cookie: cookie } : {} });
const cookieOf = (r) => (r.headers.get("set-cookie") || "").split(";")[0];

const DEMO = { JS: ["sneha.kulkarni", "Seeker#2026!"], JP: ["priya.raman", "Poster#2026!"], AD: ["arjun.mehta", "Admin#2026!"] };

console.log("Server sign-in API");
let r = await get("/api/auth/session");
check("session without cookie → 401 and backend header", r.status === 401 && r.headers.get("x-talenthub-auth") === "server");

r = await fetch(base + "/api/auth/login", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
check("login without the X-TalentHub header is refused (CSRF guard)", r.status === 400);
r = await get("/api/auth/login");
check("GET on login → 405", r.status === 405);

r = await post("/api/auth/login", { login: "sneha.kulkarni", password: "Wrong#Password1", roleCode: "JS" });
const wrongPw = await r.json();
r = await post("/api/auth/login", { login: "nobody.here", password: "Wrong#Password1", roleCode: "JS" });
const unknown = await r.json();
check("wrong password → 401", wrongPw.error && r.status === 401);
check("unknown account gets the identical message", wrongPw.error === unknown.error, unknown.error);

r = await post("/api/auth/login", { login: DEMO.JS[0], password: DEMO.JS[1], roleCode: "AD" });
check("right password, wrong role → 403 naming the right role", r.status === 403 && /Job Seeker/.test((await r.json()).error));

const cookies = {};
for (const [role, [login, pw]] of Object.entries(DEMO)) {
  const t0 = Date.now();
  r = await post("/api/auth/login", { login, password: pw, roleCode: role });
  const body = await r.json(), sc = r.headers.get("set-cookie") || "";
  check(`${role} sign-in → 200 (${Date.now() - t0} ms)`, r.status === 200 && body.user.roleCode === role, JSON.stringify(body));
  check(`${role} response has no password data`, !JSON.stringify(body).includes("hash") && !("password" in body.user));
  check(`${role} cookie is HttpOnly + SameSite=Strict`, /HttpOnly/.test(sc) && /SameSite=Strict/.test(sc));
  cookies[role] = cookieOf(r);
}

r = await get("/api/auth/session", cookies.JP);
check("session with cookie returns the same user", r.status === 200 && (await r.json()).user.userId === DEMO.JP[0]);

// Tamper: swap the payload to claim Admin while keeping the old signature
const [payload, sig] = cookies.JS.split("=")[1].split(".");
const forged = JSON.parse(Buffer.from(payload, "base64url").toString()); forged.r = "AD"; forged.k = "uid_GE0004";
r = await get("/api/auth/session", "th_session=" + Buffer.from(JSON.stringify(forged)).toString("base64url") + "." + sig);
check("tampered token (claims Admin) → 401", r.status === 401);

const old = createToken(findByLogin(DEMO.AD[0]), Date.now() - 9 * 3600_000);
r = await get("/api/auth/session", "th_session=" + old);
check("expired token → 401", r.status === 401);

r = await get("/api/auth/users", cookies.JS);
check("user list as Job Seeker → 403", r.status === 403);
r = await get("/api/auth/users", cookies.AD);
const list = await r.json();
check("user list as Admin → 200 without passwords", r.status === 200 && list.users.length >= 4 && !JSON.stringify(list).includes("salt"));

r = await post("/api/auth/logout", {}, { Cookie: cookies.AD });
check("logout clears the cookie", /Max-Age=0/.test(r.headers.get("set-cookie") || ""));

for (let i = 0; i < 5; i++) await post("/api/auth/login", { login: "rohan.verma", password: "Nope#123456", roleCode: "JS" });
r = await post("/api/auth/login", { login: "rohan.verma", password: "Seeker#2026!", roleCode: "JS" });
check("6th attempt after 5 failures is locked (even with the right password) → 429", r.status === 429);
r = await post("/api/auth/login", { login: DEMO.JP[0], password: DEMO.JP[1], roleCode: "JP" });
check("another account from the same address still signs in (no office-wide lockout)", r.status === 200);

process.env.SESSION_SECRET = "";
r = await post("/api/auth/login", { login: DEMO.JP[0], password: DEMO.JP[1], roleCode: "JP" });
check("missing SESSION_SECRET → 500 with a clear message", r.status === 500 && /configured/.test((await r.json()).error));

server.close();
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
