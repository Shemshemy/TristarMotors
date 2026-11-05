import { createHash, randomBytes, scryptSync, timingSafeEqual } from "node:crypto";

const SESSION_TTL_MS = 8 * 60 * 60 * 1000;
const MAX_LOGIN_ATTEMPTS = 5;
const LOGIN_LOCK_MS = 5 * 60 * 1000;

function hashToken(token) {
  return createHash("sha256").update(token).digest("hex");
}

function readCookie(request, name) {
  const cookies = String(request.headers.cookie || "").split(";");
  for (const cookie of cookies) {
    const [key, ...value] = cookie.trim().split("=");
    if (key === name) return value.join("=");
  }
  return "";
}

export class AdminAuth {
  constructor(password) {
    this.configured = typeof password === "string" && password.length >= 12;
    this.salt = this.configured ? randomBytes(16) : null;
    this.passwordHash = this.configured ? scryptSync(password, this.salt, 32) : null;
    this.sessions = new Map();
    this.loginAttempts = new Map();
  }

  checkPassword(password) {
    if (!this.configured || typeof password !== "string" || password.length > 1024) return false;
    const candidate = scryptSync(password, this.salt, 32);
    return timingSafeEqual(candidate, this.passwordHash);
  }

  loginAllowed(address) {
    const attempt = this.loginAttempts.get(address);
    if (!attempt) return true;
    if (attempt.lockedUntil > Date.now()) return false;
    if (attempt.lockedUntil) this.loginAttempts.delete(address);
    return true;
  }

  recordFailedLogin(address) {
    const attempt = this.loginAttempts.get(address) || { count: 0 };
    attempt.count += 1;
    if (attempt.count >= MAX_LOGIN_ATTEMPTS) {
      attempt.count = 0;
      attempt.lockedUntil = Date.now() + LOGIN_LOCK_MS;
    }
    this.loginAttempts.set(address, attempt);
  }

  createSession(response) {
    const token = randomBytes(32).toString("base64url");
    const expiresAt = Date.now() + SESSION_TTL_MS;
    this.sessions.set(hashToken(token), expiresAt);
    response.setHeader(
      "Set-Cookie",
      `tristar_admin=${encodeURIComponent(token)}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=${SESSION_TTL_MS / 1000}`,
    );
  }

  isAuthenticated(request) {
    const token = readCookie(request, "tristar_admin");
    if (!token) return false;
    const tokenHash = hashToken(token);
    const expiresAt = this.sessions.get(tokenHash);
    if (!expiresAt || expiresAt <= Date.now()) {
      this.sessions.delete(tokenHash);
      return false;
    }
    return true;
  }

  destroySession(request, response) {
    const token = readCookie(request, "tristar_admin");
    if (token) this.sessions.delete(hashToken(token));
    response.setHeader("Set-Cookie", "tristar_admin=; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=0");
  }

  cleanup() {
    const now = Date.now();
    for (const [token, expiresAt] of this.sessions) {
      if (expiresAt <= now) this.sessions.delete(token);
    }
  }
}
