import { createHash, randomBytes, scryptSync, timingSafeEqual } from "node:crypto";
import { readFileSync, renameSync, writeFileSync } from "node:fs";

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
  constructor(password, { passwordFilePath } = {}) {
    this.passwordFilePath = passwordFilePath;
    this.sessions = new Map();
    this.loginAttempts = new Map();

    let saved;
    if (passwordFilePath) {
      try {
        saved = JSON.parse(readFileSync(passwordFilePath, "utf8"));
      } catch (error) {
        if (error.code !== "ENOENT") throw new Error(`Could not read administrator password settings: ${error.message}`);
      }
    }

    const envPasswordAvailable = typeof password === "string" && password.length >= 12;
    const savedStateIsValid = saved?.version === 1 &&
      /^[a-f\d]{32}$/.test(saved.environmentSalt || "") &&
      /^[a-f\d]{64}$/.test(saved.environmentPasswordHash || "") &&
      /^[a-f\d]{32}$/.test(saved.salt || "") &&
      /^[a-f\d]{64}$/.test(saved.passwordHash || "");
    if (envPasswordAvailable && savedStateIsValid) {
      this.environmentSalt = Buffer.from(saved.environmentSalt, "hex");
      this.environmentPasswordHash = Buffer.from(saved.environmentPasswordHash, "hex");
      const candidate = scryptSync(password, this.environmentSalt, 32);
      if (timingSafeEqual(candidate, this.environmentPasswordHash)) {
        this.configured = true;
        this.salt = Buffer.from(saved.salt, "hex");
        this.passwordHash = Buffer.from(saved.passwordHash, "hex");
        return;
      }
    }

    this.configured = envPasswordAvailable;
    this.environmentSalt = this.configured ? randomBytes(16) : null;
    this.environmentPasswordHash = this.configured ? scryptSync(password, this.environmentSalt, 32) : null;
    this.salt = this.configured ? randomBytes(16) : null;
    this.passwordHash = this.configured ? scryptSync(password, this.salt, 32) : null;
    if (this.configured && passwordFilePath) this.persistPassword(this.salt, this.passwordHash);
  }

  persistPassword(salt, passwordHash) {
    const temporaryPath = `${this.passwordFilePath}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`;
    const contents = JSON.stringify({
      version: 1,
      environmentSalt: this.environmentSalt.toString("hex"),
      environmentPasswordHash: this.environmentPasswordHash.toString("hex"),
      salt: salt.toString("hex"),
      passwordHash: passwordHash.toString("hex"),
    });
    writeFileSync(temporaryPath, contents, { encoding: "utf8", mode: 0o600, flag: "wx" });
    renameSync(temporaryPath, this.passwordFilePath);
  }

  updatePassword(password) {
    if (typeof password !== "string" || password.length < 12 || password.length > 1024) {
      throw new Error("Password must be between 12 and 1024 characters");
    }
    const salt = randomBytes(16);
    const passwordHash = scryptSync(password, salt, 32);
    if (this.passwordFilePath) this.persistPassword(salt, passwordHash);
    this.salt = salt;
    this.passwordHash = passwordHash;
    this.configured = true;
    this.sessions.clear();
    this.loginAttempts.clear();
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
