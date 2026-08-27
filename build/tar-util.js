'use strict';
/**
 * Deterministic POSIX-ustar tar.gz writer + a matching pure-Node reader.
 * Shared by the build pipeline (build.js) and the bootstrap e2e harness
 * (scripts/bootstrap-e2e.mjs). Byte-for-byte reproducible: sorted entries,
 * zeroed mtime/uid/gid, gzip mtime=0. Regular files + directories only — which
 * is exactly what the Go stub's hardened extractor accepts.
 */
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const BLOCK = 512;

function makeTarHeader(name, size, isDir) {
  const header = Buffer.alloc(BLOCK);
  if (Buffer.byteLength(name, 'utf8') > 100) {
    throw new Error(`tar entry name too long for ustar header: ${name}`);
  }
  header.write(name, 0, 100, 'utf8');
  header.write(isDir ? '0000755' : '0000644', 100, 8, 'utf8');
  header.write('\0', 107, 1);
  header.write('0000000', 108, 8, 'utf8'); header.write('\0', 115, 1);
  header.write('0000000', 116, 8, 'utf8'); header.write('\0', 123, 1);
  header.write(size.toString(8).padStart(11, '0'), 124, 12, 'utf8');
  header.write(' ', 135, 1);
  header.write('00000000000', 136, 12, 'utf8'); header.write(' ', 147, 1);
  for (let i = 148; i < 156; i++) header[i] = 0x20;
  header.write(isDir ? '5' : '0', 156, 1, 'utf8');
  header.write('ustar\0', 257, 6, 'utf8');
  header.write('00', 263, 2, 'utf8');
  let sum = 0;
  for (let i = 0; i < BLOCK; i++) sum += header[i];
  header.write(sum.toString(8).padStart(6, '0'), 148, 6, 'utf8');
  header[154] = 0x00;
  header[155] = 0x20;
  return header;
}

// Pack every file/dir under rootDir into a deterministic gzipped ustar buffer.
function buildDeterministicTarGz(rootDir) {
  const entries = [];
  function walk(rel) {
    const abs = path.join(rootDir, rel);
    const st = fs.lstatSync(abs); // lstat: do NOT follow symlinks
    if (st.isSymbolicLink()) {
      throw new Error(`refusing to pack symlink into tarball: ${rel}`);
    }
    if (st.isDirectory()) {
      entries.push({ rel: rel.replace(/\\/g, '/') + '/', abs, isDir: true, size: 0 });
      for (const child of fs.readdirSync(abs).sort()) walk(path.join(rel, child));
    } else if (st.isFile()) {
      entries.push({ rel: rel.replace(/\\/g, '/'), abs, isDir: false, size: st.size });
    } else {
      throw new Error(`refusing to pack non-regular file into tarball: ${rel}`);
    }
  }
  for (const top of fs.readdirSync(rootDir).sort()) walk(top);

  const blocks = [];
  for (const e of entries) {
    const data = e.isDir ? Buffer.alloc(0) : fs.readFileSync(e.abs);
    blocks.push(makeTarHeader(e.rel, data.length, e.isDir));
    if (data.length > 0) {
      blocks.push(data);
      const padLen = (BLOCK - (data.length % BLOCK)) % BLOCK;
      if (padLen) blocks.push(Buffer.alloc(padLen));
    }
  }
  blocks.push(Buffer.alloc(BLOCK * 2));
  return zlib.gzipSync(Buffer.concat(blocks), { level: 9, mtime: 0 });
}

// Extract one of OUR ustar tar.gz buffers/files to destDir. Pure Node — no
// external `tar` (Git's GNU tar treats a Windows `E:\` path as a remote host).
// Regular files + dirs only, with the same path-safety the Go extractor uses.
function extractTarGz(tarballOrBuf, destDir) {
  const gz = Buffer.isBuffer(tarballOrBuf) ? tarballOrBuf : fs.readFileSync(tarballOrBuf);
  const absDest = path.resolve(destDir);
  fs.rmSync(absDest, { recursive: true, force: true });
  fs.mkdirSync(absDest, { recursive: true });
  const buf = zlib.gunzipSync(gz);
  for (let off = 0; off + BLOCK <= buf.length;) {
    const header = buf.subarray(off, off + BLOCK);
    off += BLOCK;
    if (header.every((b) => b === 0)) break; // EOF zero block
    const name = header.subarray(0, 100).toString('utf8').replace(/\0.*$/, '');
    const size = parseInt(header.subarray(124, 136).toString('utf8').replace(/\0.*$/, '').trim() || '0', 8);
    const typeflag = String.fromCharCode(header[156]);
    if (!name) { off += Math.ceil(size / BLOCK) * BLOCK; continue; }
    if (name.includes('..') || name.includes('\\') || path.isAbsolute(name) || /^[a-zA-Z]:/.test(name)) {
      throw new Error(`unsafe tar entry: ${name}`);
    }
    const target = path.join(absDest, name);
    const rel = path.relative(absDest, target);
    if (rel === '..' || rel.startsWith('..' + path.sep)) {
      throw new Error(`tar entry escapes dest: ${name}`);
    }
    const isDir = typeflag === '5' || name.endsWith('/');
    const isReg = typeflag === '0' || typeflag === '\0' || typeflag === '';
    if (isDir) {
      fs.mkdirSync(target, { recursive: true });
    } else if (isReg) {
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, buf.subarray(off, off + size));
    } else {
      throw new Error(`disallowed tar entry type ${JSON.stringify(typeflag)}: ${name}`);
    }
    off += Math.ceil(size / BLOCK) * BLOCK;
  }
}

module.exports = { buildDeterministicTarGz, makeTarHeader, extractTarGz };
