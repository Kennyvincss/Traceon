'use strict';
// Minimal streaming tar reader (ustar + pax + GNU long names), enough for
// GitHub repository tarballs. Only entries accepted by `want(path, size)` are
// buffered; everything else is skipped without being held in memory.

function readString(buf, start, len) {
  const slice = buf.subarray(start, start + len);
  const nul = slice.indexOf(0);
  return slice.subarray(0, nul === -1 ? slice.length : nul).toString('utf8');
}

function readSize(buf) {
  if (buf[124] & 0x80) {
    // base-256 encoding for large files
    let n = 0;
    for (let i = 125; i < 136; i++) n = n * 256 + buf[i];
    return n;
  }
  const s = readString(buf, 124, 12).trim();
  return s ? parseInt(s, 8) : 0;
}

function parsePax(buf) {
  const out = {};
  let off = 0;
  const text = buf.toString('utf8');
  while (off < text.length) {
    const sp = text.indexOf(' ', off);
    if (sp === -1) break;
    const len = parseInt(text.slice(off, sp), 10);
    if (!len) break;
    const rec = text.slice(sp + 1, off + len - 1);
    const eq = rec.indexOf('=');
    if (eq !== -1) out[rec.slice(0, eq)] = rec.slice(eq + 1);
    off += len;
  }
  return out;
}

class TarExtractor {
  constructor({ want, onFile }) {
    this.want = want;
    this.onFile = onFile;
    this.buf = Buffer.alloc(0);
    this.state = 'header';
    this.remaining = 0;
    this.pad = 0;
    this.chunks = null;
    this.entry = null;
    this.paxPath = null;
    this.longName = null;
    this.zeroBlocks = 0;
    this.ended = false;
  }

  write(chunk) {
    this.buf = this.buf.length ? Buffer.concat([this.buf, chunk]) : chunk;
    let off = 0;
    while (!this.ended) {
      const avail = this.buf.length - off;
      if (this.state === 'header') {
        if (avail < 512) break;
        const h = this.buf.subarray(off, off + 512);
        off += 512;
        this.startEntry(h);
      } else if (this.state === 'body') {
        if (!avail) break;
        const n = Math.min(avail, this.remaining);
        if (this.chunks) this.chunks.push(Buffer.from(this.buf.subarray(off, off + n)));
        off += n;
        this.remaining -= n;
        if (this.remaining === 0) {
          this.finishEntry();
          this.state = this.pad ? 'pad' : 'header';
        }
      } else {
        if (!avail) break;
        const n = Math.min(avail, this.pad);
        off += n;
        this.pad -= n;
        if (this.pad === 0) this.state = 'header';
      }
    }
    this.buf = Buffer.from(this.buf.subarray(off));
  }

  startEntry(h) {
    if (h.every(b => b === 0)) {
      if (++this.zeroBlocks >= 2) this.ended = true;
      return;
    }
    this.zeroBlocks = 0;
    const name = readString(h, 0, 100);
    const prefix = readString(h, 345, 155);
    const type = String.fromCharCode(h[156] || 48);
    const size = readSize(h);
    let path = this.paxPath || this.longName || (prefix ? `${prefix}/${name}` : name);
    const isMeta = type === 'x' || type === 'g' || type === 'L';
    const isFile = type === '0' || type === '7' || h[156] === 0;
    if (!isMeta) { this.paxPath = null; this.longName = null; }

    this.entry = { path, type, size, isFile, isMeta };
    const collect = isMeta || (isFile && this.want(path, size));
    this.chunks = collect ? [] : null;
    this.remaining = size;
    this.pad = (512 - (size % 512)) % 512;
    if (size === 0) this.finishEntry();
    else this.state = 'body';
  }

  finishEntry() {
    const e = this.entry;
    const data = this.chunks ? Buffer.concat(this.chunks) : null;
    this.chunks = null;
    if (e.type === 'x' && data) {
      const pax = parsePax(data);
      if (pax.path) this.paxPath = pax.path;
    } else if (e.type === 'L' && data) {
      this.longName = readString(data, 0, data.length);
    } else if (e.isFile && data) {
      this.onFile(e.path, data);
    }
  }
}

module.exports = { TarExtractor };
