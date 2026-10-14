/**
 * Creates the password entry for a user in data/users.json.
 * Passwords are never stored in plain text: this prints a salted PBKDF2-SHA256 hash
 * in the format TalentHub.html verifies in the browser (Web Crypto).
 *
 * Usage:  npm run hash-password -- "the-password"
 */
import { pbkdf2Sync, randomBytes } from "node:crypto";

export const ITERATIONS = 600000;   // OWASP 2023 recommendation for PBKDF2-HMAC-SHA256

export function hashPassword(password, iterations = ITERATIONS) {
  const salt = randomBytes(16);
  const hash = pbkdf2Sync(password, salt, iterations, 32, "sha256");
  return { algo: "PBKDF2-SHA256", iterations, salt: salt.toString("base64"), hash: hash.toString("base64") };
}

if (process.argv[1] && process.argv[1].endsWith("hash-password.mjs")) {   // run as a command, not imported
  const pw = process.argv[2];
  if (!pw) { console.error('Usage: npm run hash-password -- "the-password"'); process.exit(1); }
  if (pw.length < 10) { console.error("Use at least 10 characters."); process.exit(1); }
  console.log(JSON.stringify({ password: hashPassword(pw) }, null, 2));
}
