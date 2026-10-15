/**
 * Small HTTP helpers for the TalentHub API functions.
 * Uses only Node core APIs so the same handlers run on Vercel and in scripts/dev-server.mjs.
 */

/** Sends a JSON response that is never cached and marks the backend as present. */
export function sendJson(res, status, body, headers = {}) {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-TalentHub-Auth", "server");      // lets the portal detect server sign-in
  for (const [k, v] of Object.entries(headers)) res.setHeader(k, v);
  res.end(JSON.stringify(body));
}

/** Reads a JSON request body (Vercel may already have parsed it into req.body). Max 16 KB. */
export async function readJson(req) {
  if (req.body && typeof req.body === "object") return req.body;
  if (typeof req.body === "string") return JSON.parse(req.body || "{}");
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 16 * 1024) throw Object.assign(new Error("Request body too large"), { status: 413 });
    chunks.push(chunk);
  }
  const text = Buffer.concat(chunks).toString("utf8");
  return text ? JSON.parse(text) : {};
}

/** Reads a raw request body as a Buffer (Vercel may already have buffered it into req.body). */
export async function readBinary(req, max) {
  const tooBig = () => Object.assign(new Error("That file is too large."), { status: 413 });
  if (Buffer.isBuffer(req.body)) { if (req.body.length > max) throw tooBig(); return req.body; }
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > max) throw tooBig();
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

export function parseCookies(req) {
  const out = {};
  String(req.headers.cookie || "").split(";").forEach(part => {
    const i = part.indexOf("=");
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  });
  return out;
}

/** True when the request comes over plain http from localhost (dev server). */
export function isLocalHttp(req) {
  const host = String(req.headers.host || "");
  const proto = String(req.headers["x-forwarded-proto"] || (req.socket && req.socket.encrypted ? "https" : "http"));
  return proto === "http" && /^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/.test(host);
}

/**
 * Guards state-changing requests: POST only, JSON body, and the custom header the portal sends.
 * Together with the SameSite=Strict cookie this blocks cross-site request forgery.
 */
export function checkPost(req, res, contentType = "application/json") {
  if (req.method !== "POST") { sendJson(res, 405, { error: "Use POST." }, { Allow: "POST" }); return false; }
  if (req.headers["x-talenthub"] !== "1" || !String(req.headers["content-type"] || "").includes(contentType)) {
    sendJson(res, 400, { error: "Bad request." }); return false;
  }
  return true;
}

/** Best-effort client address for rate limiting. */
export function clientIp(req) {
  return String(req.headers["x-forwarded-for"] || "").split(",")[0].trim() || (req.socket && req.socket.remoteAddress) || "unknown";
}
