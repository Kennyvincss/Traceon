'use strict';
// Server-side session store. The GitHub access token lives only here —
// the browser holds an opaque, HttpOnly session id and never sees the token.
//
// This in-memory store is fine for a single-process deployment. For multiple
// instances or restarts, swap it for Redis/a database with encryption at rest
// (same interface: create/get/update/destroy).

const crypto = require('crypto');

class SessionStore {
  constructor({ ttlMs }) {
    this.ttlMs = ttlMs;
    this.sessions = new Map();
    this.pending = new Map(); // in-flight OAuth logins: id -> { state, verifier, createdAt }
    this.sweeper = setInterval(() => this.sweep(), 10 * 60 * 1000);
    this.sweeper.unref();
  }

  static newId() {
    return crypto.randomBytes(32).toString('base64url');
  }

  create(data) {
    const id = SessionStore.newId();
    this.sessions.set(id, { ...data, createdAt: Date.now(), lastSeen: Date.now() });
    return id;
  }

  get(id) {
    if (!id) return null;
    const s = this.sessions.get(id);
    if (!s) return null;
    if (Date.now() - s.lastSeen > this.ttlMs) {
      this.sessions.delete(id);
      return null;
    }
    s.lastSeen = Date.now();
    return s;
  }

  destroy(id) {
    if (id) this.sessions.delete(id);
  }

  createPending(data) {
    const id = SessionStore.newId();
    this.pending.set(id, { ...data, createdAt: Date.now() });
    return id;
  }

  // One-time use: a pending login is removed as soon as it is read.
  takePending(id) {
    if (!id) return null;
    const p = this.pending.get(id);
    this.pending.delete(id);
    if (!p || Date.now() - p.createdAt > 10 * 60 * 1000) return null;
    return p;
  }

  sweep() {
    const now = Date.now();
    for (const [id, s] of this.sessions) if (now - s.lastSeen > this.ttlMs) this.sessions.delete(id);
    for (const [id, p] of this.pending) if (now - p.createdAt > 10 * 60 * 1000) this.pending.delete(id);
  }
}

module.exports = { SessionStore };
