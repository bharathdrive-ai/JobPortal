/**
 * Local development server that behaves like the Vercel deployment:
 *   /                 -> TalentHub.html
 *   /data/*.json      -> job-postings feed (users.json is NOT served, as in production)
 *   /api/...          -> the serverless functions in ./api
 *
 * Usage:  npm run dev            (http://localhost:8787)
 * Set SESSION_SECRET to keep sessions across restarts; otherwise a random one is used.
 */
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { existsSync, readFileSync } from "node:fs";
import { join, extname, normalize } from "node:path";
import { randomBytes } from "node:crypto";
import { pathToFileURL } from "node:url";

const PORT = Number(process.env.PORT || 8787);
const ROOT = process.cwd();

// Local settings written by `npm run google-auth` (.env* files are git-ignored). Real environment variables win.
if (existsSync(join(ROOT, ".env.local"))) {
  for (const line of readFileSync(join(ROOT, ".env.local"), "utf8").split(/\r?\n/)) {
    const m = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim());
    if (m && !(m[1] in process.env)) process.env[m[1]] = m[2].replace(/^"(.*)"$/, "$1");
  }
  console.log("ℹ Loaded settings from .env.local");
}
if (!process.env.SESSION_SECRET) {
  process.env.SESSION_SECRET = randomBytes(32).toString("hex");
  console.log("ℹ SESSION_SECRET not set: using a random one for this run (sessions end when the server restarts).");
}

const TYPES = { ".html": "text/html; charset=utf-8", ".json": "application/json; charset=utf-8", ".js": "text/javascript", ".css": "text/css" };
const STATIC = { "/": "TalentHub.html", "/TalentHub.html": "TalentHub.html", "/data/job-postings.json": "data/job-postings.json", "/privacy.html": "privacy.html" };

createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  try {
    if (url.pathname.startsWith("/api/")) {
      const rel = normalize(url.pathname.replace(/^\/+/, "")).replace(/\\/g, "/");
      // Same routing as Vercel: api/x.js or api/x/index.js
      const file = [join(ROOT, rel + ".js"), join(ROOT, rel, "index.js")].find(p => existsSync(p));
      if (!/^api\/[a-z0-9/_-]+$/i.test(rel) || !file) { res.statusCode = 404; return res.end("Not found"); }
      const mod = await import(pathToFileURL(file).href);
      return await mod.default(req, res);
    }
    const name = STATIC[url.pathname];
    if (!name) { res.statusCode = 404; return res.end("Not found"); }
    res.setHeader("Content-Type", TYPES[extname(name)] || "application/octet-stream");
    res.setHeader("Cache-Control", "no-cache");
    res.end(await readFile(join(ROOT, name)));
  } catch (e) {
    console.error(e);
    if (!res.headersSent) { res.statusCode = 500; res.end("Server error"); }
  }
}).listen(PORT, () => console.log(`TalentHub dev server: http://localhost:${PORT}`));
