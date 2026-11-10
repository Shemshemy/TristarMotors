export class RateLimiter {
  constructor({
    windowMs = 60 * 1000,
    max = 300,
    mutationMax = 60,
    cleanupIntervalMs = 60 * 1000,
  } = {}) {
    this.windowMs = windowMs;
    this.max = max;
    this.mutationMax = mutationMax;
    this.clients = new Map();
    this.cleanupTimer = setInterval(() => this.cleanup(), cleanupIntervalMs);
    if (this.cleanupTimer.unref) this.cleanupTimer.unref();
  }

  isAllowed(ip, limit = this.max) {
    const now = Date.now();
    let record = this.clients.get(ip);
    if (!record || now > record.resetTime) {
      record = { count: 1, resetTime: now + this.windowMs };
      this.clients.set(ip, record);
      return { allowed: true, remaining: limit - 1, resetTime: record.resetTime };
    }

    record.count += 1;
    const allowed = record.count <= limit;
    const remaining = Math.max(0, limit - record.count);
    return { allowed, remaining, resetTime: record.resetTime };
  }

  cleanup() {
    const now = Date.now();
    for (const [ip, record] of this.clients.entries()) {
      if (now > record.resetTime) {
        this.clients.delete(ip);
      }
    }
  }

  reset() {
    this.clients.clear();
  }

  close() {
    clearInterval(this.cleanupTimer);
    this.clients.clear();
  }
}

export function getClientIp(request) {
  const forwarded = request.headers["x-forwarded-for"];
  if (forwarded && typeof forwarded === "string") {
    const client = forwarded.split(",")[0].trim();
    if (client) return client;
  }
  return request.socket.remoteAddress || "127.0.0.1";
}

