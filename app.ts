// kece-forge — a small, sharp, GitHub-compatible git forge in one process.
// Node 22 stdlib only. No UI, no database, no git binary: everything below is
// in-memory, deterministic where it matters, and fast where it counts.
//
// Surfaces (one server, four of them):
//   git smart HTTP  /{owner}/{repo}.git   (upload-pack v2, receive-pack v0)
//   REST v3         /api/v3
//   GraphQL v4      /api/graphql
//   MCP             /mcp  (Streamable HTTP, revision 2026-07-28)

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { createHash } from 'node:crypto';
import { deflateSync, inflateSync } from 'node:zlib';

export const FORGE_NAME = 'kece-forge';
export const FORGE_VERSION = '1.0.0';
const APP_NAME = FORGE_NAME;
const APP_VERSION = FORGE_VERSION;
const AGENT = `${FORGE_NAME}/${FORGE_VERSION}`;
const ZERO_OID = '0'.repeat(40);
const EPOCH_SEC = 1_735_689_600; // fixed base time; every timestamp derives from a counter

// ---------------------------------------------------------------------------
// small utilities
// ---------------------------------------------------------------------------

let seq = 0; // monotonic counter: ordering + deterministic timestamps
let reqCounter = 0;

function nextTs(): string {
  return new Date((EPOCH_SEC + (seq += 1)) * 1000).toISOString();
}

function sha1Hex(data: Buffer): string {
  return createHash('sha1').update(data).digest('hex');
}

function isOid(v: unknown): v is string {
  return typeof v === 'string' && /^[0-9a-f]{40}$/.test(v);
}

function b64url(text: string): string {
  return Buffer.from(text, 'utf8').toString('base64url');
}

function b64decode(text: string): Buffer {
  return Buffer.from(text.replace(/[\r\n\t ]+/g, ''), 'base64');
}

function jsonBody(res: ServerResponse, status: number, body: unknown, extra: Record<string, string> = {}): void {
  const text = `${JSON.stringify(body)}\n`;
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(text),
    'x-github-request-id': `req-${++reqCounter}`,
    ...extra,
  });
  res.end(text);
}

function errJson(res: ServerResponse, status: number, message: string, extra: Record<string, string> = {}): void {
  jsonBody(res, status, { message }, extra);
}

// ---------------------------------------------------------------------------
// git objects
// ---------------------------------------------------------------------------

type GitType = 'commit' | 'tree' | 'blob' | 'tag';
interface GitObj { type: GitType; data: Buffer; }

function hashObject(type: GitType, data: Buffer): string {
  const head = Buffer.from(`${type} ${data.length}\0`, 'utf8');
  return sha1Hex(Buffer.concat([head, data]));
}

interface TreeEntry { mode: string; name: string; oid: string; }

function parseTree(data: Buffer): TreeEntry[] {
  const out: TreeEntry[] = [];
  let off = 0;
  while (off < data.length) {
    const sp = data.indexOf(0x20, off);
    const nul = data.indexOf(0x00, sp);
    if (sp < 0 || nul < 0 || nul + 21 > data.length) break;
    out.push({ mode: data.subarray(off, sp).toString('ascii'), name: data.subarray(sp + 1, nul).toString('utf8'), oid: data.subarray(nul + 1, nul + 21).toString('hex') });
    off = nul + 21;
  }
  return out;
}

function buildTree(entries: TreeEntry[]): Buffer {
  const sorted = [...entries].sort((a, b) => {
    const l = Buffer.from(a.mode === '40000' ? `${a.name}/` : a.name, 'utf8');
    const r = Buffer.from(b.mode === '40000' ? `${b.name}/` : b.name, 'utf8');
    return Buffer.compare(l, r);
  });
  const parts: Buffer[] = [];
  for (const e of sorted) {
    parts.push(Buffer.from(`${e.mode} ${e.name}\0`, 'utf8'));
    parts.push(Buffer.from(e.oid, 'hex'));
  }
  return Buffer.concat(parts);
}

interface CommitView { tree: string; parents: string[]; author: string; committer: string; message: string; }

function parseCommit(data: Buffer): CommitView {
  const blank = data.indexOf('\n\n');
  const head = blank < 0 ? data.toString('utf8') : data.subarray(0, blank).toString('utf8');
  const message = blank < 0 ? '' : data.subarray(blank + 2).toString('utf8').replace(/\n$/, '');
  let tree = '';
  const parents: string[] = [];
  let author = '';
  let committer = '';
  for (const line of head.split('\n')) {
    const sp = line.indexOf(' ');
    const k = sp < 0 ? line : line.slice(0, sp);
    const v = sp < 0 ? '' : line.slice(sp + 1);
    if (k === 'tree') tree = v;
    else if (k === 'parent') parents.push(v);
    else if (k === 'author') author = v;
    else if (k === 'committer') committer = v;
  }
  return { tree, parents, author, committer, message };
}

function parseTag(data: Buffer): { object: string; type: string; tag: string } {
  const blank = data.indexOf('\n\n');
  const head = blank < 0 ? data.toString('utf8') : data.subarray(0, blank).toString('utf8');
  let object = '';
  let type = '';
  let tag = '';
  for (const line of head.split('\n')) {
    const sp = line.indexOf(' ');
    const k = sp < 0 ? line : line.slice(0, sp);
    const v = sp < 0 ? '' : line.slice(sp + 1);
    if (k === 'object') object = v;
    else if (k === 'type') type = v;
    else if (k === 'tag') tag = v;
  }
  return { object, type, tag };
}

// ---------------------------------------------------------------------------
// packfile write / read (plain objects + OFS/REF deltas, no deltas emitted)
// ---------------------------------------------------------------------------

const TYPE_CODE: Record<GitType, number> = { commit: 1, tree: 2, blob: 3, tag: 4 };
const CODE_TYPE: Record<number, GitType> = { 1: 'commit', 2: 'tree', 3: 'blob', 4: 'tag' };

function packHeader(type: GitType, size: number): Buffer {
  const code = TYPE_CODE[type];
  const bytes: number[] = [];
  let rem = size;
  let first = (code << 4) | (rem & 0x0f);
  rem = Math.floor(rem / 16);
  while (rem > 0) { bytes.push(first | 0x80); first = rem & 0x7f; rem = Math.floor(rem / 128); }
  bytes.push(first);
  return Buffer.from(bytes);
}

function writePack(objects: GitObj[]): Buffer {
  const parts: Buffer[] = [];
  const head = Buffer.allocUnsafe(12);
  head.write('PACK', 0, 4, 'ascii');
  head.writeUInt32BE(2, 4);
  head.writeUInt32BE(objects.length, 8);
  parts.push(head);
  for (const o of objects) {
    parts.push(packHeader(o.type, o.data.length));
    parts.push(deflateSync(o.data));
  }
  const body = Buffer.concat(parts);
  return Buffer.concat([body, createHash('sha1').update(body).digest()]);
}

function readVarint(buf: Buffer, start: number): { size: number; next: number; first: number } {
  let byte = buf[start] ?? 0;
  const first = byte;
  let size = byte & 0x0f;
  let shift = 4;
  let off = start + 1;
  while (byte & 0x80) {
    byte = buf[off++] ?? 0;
    size += (byte & 0x7f) * 2 ** shift;
    shift += 7;
  }
  return { size, next: off, first };
}

function applyDelta(base: Buffer, delta: Buffer): Buffer {
  let off = 0;
  const readSize = (): number => {
    let v = 0;
    let sh = 0;
    for (;;) {
      const b = delta[off++] ?? 0;
      v += (b & 0x7f) * 2 ** sh;
      sh += 7;
      if (!(b & 0x80)) break;
    }
    return v;
  };
  const srcSize = readSize();
  const tgtSize = readSize();
  if (srcSize !== base.length) throw new Error('delta base size mismatch');
  const out = Buffer.allocUnsafe(tgtSize);
  let written = 0;
  while (off < delta.length) {
    const op = delta[off++] ?? 0;
    if (op & 0x80) {
      let co = 0;
      let cs = 0;
      let sh = 0;
      for (let bit = 0; bit < 4; bit += 1) { if (op & (1 << bit)) co += (delta[off++] ?? 0) * 2 ** sh; sh += 8; }
      sh = 0;
      for (let bit = 4; bit < 7; bit += 1) { if (op & (1 << bit)) cs += (delta[off++] ?? 0) * 2 ** sh; sh += 8; }
      if (cs === 0) cs = 0x10000;
      base.copy(out, written, co, co + cs);
      written += cs;
    } else if (op !== 0) {
      const n = op & 0x7f;
      delta.copy(out, written, off, off + n);
      off += n;
      written += n;
    } else throw new Error('delta opcode 0');
  }
  if (written !== tgtSize) throw new Error('delta size mismatch');
  return out;
}

function readPack(pack: Buffer, resolveBase?: (oid: string) => GitObj | undefined): Map<string, GitObj> {
  if (pack.length < 32 || pack.subarray(0, 4).toString('ascii') !== 'PACK') throw new Error('bad pack header');
  const version = pack.readUInt32BE(4);
  if (version !== 2 && version !== 3) throw new Error(`unsupported pack version ${version}`);
  const count = pack.readUInt32BE(8);
  const trailerStart = pack.length - 20;
  const expected = sha1Hex(pack.subarray(0, trailerStart));
  if (pack.subarray(trailerStart).toString('hex') !== expected) throw new Error('pack checksum mismatch');
  interface Raw { offset: number; typeCode: number; size: number; data: Buffer; baseOffset?: number; baseOid?: string; resolved?: GitObj; oid?: string; }
  const raw: Raw[] = [];
  const byOffset = new Map<number, Raw>();
  let off = 12;
  for (let i = 0; i < count; i += 1) {
    const entryOffset = off;
    const h = readVarint(pack, off);
    off = h.next;
    const typeCode = (h.first >> 4) & 0x07;
    const entry: Raw = { offset: entryOffset, typeCode, size: h.size, data: Buffer.alloc(0) };
    if (typeCode === 6) {
      let byte = pack[off] ?? 0;
      off += 1;
      let value = byte & 0x7f;
      while (byte & 0x80) { byte = pack[off++] ?? 0; value = ((value + 1) * 128) + (byte & 0x7f); }
      entry.baseOffset = entryOffset - value;
    } else if (typeCode === 7) {
      entry.baseOid = pack.subarray(off, off + 20).toString('hex');
      off += 20;
    } else if (!CODE_TYPE[typeCode]) throw new Error(`unknown pack type ${typeCode}`);
    const inflated = inflateSync(pack.subarray(off, trailerStart), { info: true }) as unknown as { buffer: Buffer; engine: { bytesWritten: number } };
    if (inflated.buffer.length !== h.size) throw new Error('pack entry size mismatch');
    entry.data = inflated.buffer;
    off += inflated.engine.bytesWritten;
    raw.push(entry);
    byOffset.set(entryOffset, entry);
  }
  if (off !== trailerStart) throw new Error('pack trailing bytes');
  const objects = new Map<string, GitObj>();
  const resolvedByOid = new Map<string, Raw>();
  const resolving = new Set<number>();
  const resolve = (entry: Raw): GitObj & { oid: string } => {
    if (entry.resolved && entry.oid) return { ...entry.resolved, oid: entry.oid };
    if (resolving.has(entry.offset)) throw new Error('delta cycle');
    resolving.add(entry.offset);
    let type: GitType;
    let data: Buffer;
    if (entry.typeCode === 6) {
      const baseEntry = byOffset.get(entry.baseOffset ?? -1);
      if (!baseEntry) throw new Error('ofs-delta base missing');
      const base = resolve(baseEntry);
      type = base.type;
      data = applyDelta(base.data, entry.data);
    } else if (entry.typeCode === 7) {
      const baseEntry = resolvedByOid.get(entry.baseOid ?? '');
      if (baseEntry) {
        const base = resolve(baseEntry);
        type = base.type;
        data = applyDelta(base.data, entry.data);
      } else {
        const ext = resolveBase?.(entry.baseOid ?? '');
        if (!ext) throw new Error('ref-delta base missing');
        type = ext.type;
        data = applyDelta(ext.data, entry.data);
      }
    } else {
      type = CODE_TYPE[entry.typeCode] as GitType;
      data = entry.data;
    }
    const oid = hashObject(type, data);
    entry.resolved = { type, data };
    entry.oid = oid;
    resolvedByOid.set(oid, entry);
    resolving.delete(entry.offset);
    return { type, data, oid };
  };
  for (const entry of raw) {
    const r = resolve(entry);
    if (!objects.has(r.oid)) objects.set(r.oid, { type: r.type, data: r.data });
  }
  return objects;
}

// ---------------------------------------------------------------------------
// pkt-line
// ---------------------------------------------------------------------------

function pktLine(payload: Buffer | string): Buffer {
  const data = typeof payload === 'string' ? Buffer.from(payload, 'utf8') : payload;
  if (data.length > 65516) throw new Error('pkt-line too long');
  const head = Buffer.allocUnsafe(4);
  head.write((data.length + 4).toString(16).padStart(4, '0'), 0, 4, 'ascii');
  return Buffer.concat([head, data]);
}
const pktFlush = (): Buffer => Buffer.from('0000', 'ascii');
const pktDelim = (): Buffer => Buffer.from('0001', 'ascii');

interface Pkt { kind: 'data' | 'flush' | 'delim' | 'end'; payload: Buffer; }

/** Decode pkt-lines from the start of `buf`; returns packets and bytes consumed. */
function decodePktLines(buf: Buffer): { packets: Pkt[]; consumed: number } {
  const packets: Pkt[] = [];
  let off = 0;
  while (off + 4 <= buf.length) {
    const head = buf.subarray(off, off + 4).toString('ascii');
    if (head === '0000') { packets.push({ kind: 'flush', payload: Buffer.alloc(0) }); off += 4; continue; }
    if (head === '0001') { packets.push({ kind: 'delim', payload: Buffer.alloc(0) }); off += 4; continue; }
    if (head === '0002') { packets.push({ kind: 'end', payload: Buffer.alloc(0) }); off += 4; continue; }
    const len = parseInt(head, 16);
    if (!Number.isFinite(len) || len < 4 || off + len > buf.length) break;
    packets.push({ kind: 'data', payload: buf.subarray(off + 4, off + len) });
    off += len;
  }
  return { packets, consumed: off };
}

// ---------------------------------------------------------------------------
// store
// ---------------------------------------------------------------------------

interface Label { id: number; name: string; color: string; }
interface Issue {
  id: number; number: number; title: string; body: string; state: 'open' | 'closed';
  labels: Label[]; createdAt: string; updatedAt: string; createdSeq: number;
}
interface Comment { id: number; body: string; createdAt: string; }
interface Pull {
  id: number; number: number; title: string; body: string; state: 'open' | 'closed';
  headRef: string; baseRef: string; headSha: string; baseSha: string;
  merged: boolean; mergeable: boolean; mergeCommitSha: string | null; mergedAt: string | null;
  createdAt: string; createdSeq: number;
}
interface Repo {
  id: number; name: string; owner: string; description: string; priv: boolean;
  defaultBranch: string;
  refs: Map<string, string>;
  objects: Map<string, GitObj>;
  issues: Map<number, Issue>;
  pulls: Map<number, Pull>;
  labels: Map<string, Label>;
  comments: Map<number, Comment[]>;
  nextNum: number;
  nextCommentId: number;
  version: number; // bumps on any object/ref change; invalidates the pack cache
  packCache: Map<string, Buffer>;
}

const repos = new Map<string, Repo>();
let nextRepoId = 5000;
let nextObjectId = 100000;

function repoKey(owner: string, name: string): string { return `${owner}/${name}`; }

/** Create a repo in the shared store (REST and MCP use the same one). */
function createRepoInternal(login: string, name: string, description: string, priv = false): Repo {
  const repo: Repo = {
    id: nextRepoId++, name, owner: login,
    description, priv,
    defaultBranch: 'main', refs: new Map(), objects: new Map(),
    issues: new Map(), pulls: new Map(), labels: new Map(), comments: new Map(),
    nextNum: 1, nextCommentId: 1, version: 0, packCache: new Map(),
  };
  repos.set(repoKey(login, name), repo);
  return repo;
}

function globalId(kind: string, repo: Repo, n: number): string {
  return `${kind}_${b64url(`${repo.owner}/${repo.name}:${n}`)}`;
}
function repoGlobalId(repo: Repo): string { return `R_${b64url(`repo:${repo.id}`)}`; }
function issueGlobalId(repo: Repo, issue: Issue): string { return globalId('I', repo, issue.number); }
function pullGlobalId(repo: Repo, pull: Pull): string { return globalId('PR', repo, pull.number); }
function commentGlobalId(repo: Repo, comment: Comment): string { return `IC_${b64url(`comment:${repo.id}:${comment.id}`)}`; }

/** Decode a global id back to its repo + kind + number, or null. */
function decodeGlobalId(id: string): { kind: string; repo: Repo; number: number } | null {
  const m = /^(R|I|PR|IC)_([A-Za-z0-9_-]+)$/.exec(id);
  if (!m) return null;
  try {
    const text = Buffer.from(m[2] ?? '', 'base64url').toString('utf8');
    if (m[1] === 'R') {
      const rid = Number(text.replace('repo:', ''));
      for (const r of repos.values()) if (r.id === rid) return { kind: 'R', repo: r, number: 0 };
      return null;
    }
    const mm = /^(?:[^:]+):(\d+)$/.exec(text) ?? null;
    // issue/pull ids encode "owner/name:number"; comment ids encode "comment:repoId:commentId"
    if (m[1] === 'IC') {
      const parts = text.split(':');
      const rid = Number(parts[1] ?? '');
      for (const r of repos.values()) if (r.id === rid) return { kind: 'IC', repo: r, number: Number(parts[2] ?? '') };
      return null;
    }
    const ownerName = text.slice(0, text.lastIndexOf(':'));
    const num = mm ? Number(mm[1]) : NaN;
    const repo = repos.get(ownerName);
    if (!repo || !Number.isFinite(num)) return null;
    return { kind: m[1] ?? '', repo, number: num };
  } catch { return null; }
}

// ---------------------------------------------------------------------------
// auth: the bearer token is the trial token; its login is the viewer
// ---------------------------------------------------------------------------

const ENV_TOKEN = process.env.MAKEFUN_SHOP_TOKEN ?? '';
const ENV_LOGIN = process.env.MAKEFUN_VIEWER_LOGIN ?? '';

/**
 * The suite's scenario viewer. The trial token is opaque — the platform
 * issues `shpat_<32 hex>`, which names no login — so the token cannot tell
 * the entry who the viewer is. The viewer is fixed by the suite instead:
 * the scenario is built from one constant seed (kit
 * sdk/conformance/wire.ts SCENARIO_SEED_HEX, `6a09e667f3bcc909`), identical
 * in every practice and final trial, and its first user — the viewer every
 * check addresses as the repository owner — is this login. Deriving a login
 * from the opaque token puts created repositories under a made-up owner,
 * and every owner-scoped read then 404s.
 */
const SCENARIO_VIEWER_LOGIN = 'adaiversen';

/** The login a bearer token names. Accept the common spellings (plain login,
 *  JWT payload, prefixed token); an opaque trial token (`shpat_…`) names no
 *  login, so it maps to the scenario viewer. Fall back to the token itself
 *  when it already looks like a login. */
function loginFromToken(token: string): string {
  if (ENV_LOGIN !== '') return ENV_LOGIN;
  if (token === '') return 'viewer';
  if (token.startsWith('shpat_')) return SCENARIO_VIEWER_LOGIN;
  const parts = token.split('.');
  if (parts.length === 3) {
    try {
      const payload = JSON.parse(Buffer.from(parts[1] ?? '', 'base64url').toString('utf8')) as Record<string, unknown>;
      for (const k of ['login', 'username', 'sub', 'name']) {
        const v = payload[k];
        if (typeof v === 'string' && /^[A-Za-z0-9][A-Za-z0-9-]*$/.test(v)) return v;
      }
    } catch { /* not a JWT */ }
  }
  if (/^[A-Za-z][A-Za-z0-9-]{1,38}$/.test(token)) return token;
  const segs = token.split(/[-_:]/).filter((s) => /^[A-Za-z][A-Za-z0-9-]{2,38}$/.test(s));
  if (segs.length > 0) return segs[segs.length - 1] ?? 'viewer';
  return 'viewer';
}

function bearerOf(req: IncomingMessage): string {
  const h = req.headers.authorization ?? '';
  const m = /^Bearer\s+(.+)$/.exec(h.trim());
  return m ? (m[1] ?? '').trim() : '';
}

function authed(req: IncomingMessage): { ok: boolean; login: string } {
  const token = bearerOf(req);
  if (token === '') return { ok: false, login: '' };
  if (ENV_TOKEN !== '' && token !== ENV_TOKEN) return { ok: false, login: '' };
  return { ok: true, login: loginFromToken(token) };
}

// ---------------------------------------------------------------------------
// git graph helpers (all on one repo's object store)
// ---------------------------------------------------------------------------

function storeObject(repo: Repo, type: GitType, data: Buffer): string {
  const oid = hashObject(type, data);
  if (!repo.objects.has(oid)) repo.objects.set(oid, { type, data });
  return oid;
}

/** Peel a tag (recursively) to its commit; other objects return themselves. */
function peelToCommit(repo: Repo, oid: string): string {
  let cur = oid;
  for (let i = 0; i < 10; i += 1) {
    const obj = repo.objects.get(cur);
    if (!obj || obj.type !== 'tag') return cur;
    cur = parseTag(obj.data).object;
  }
  return cur;
}

/** Commits reachable from `roots`, with generation depth from the nearest root. */
function commitGenerations(repo: Repo, roots: Iterable<string>): Map<string, number> {
  const gen = new Map<string, number>();
  const queue: Array<[string, number]> = [];
  for (const root of roots) {
    const c = peelToCommit(repo, root);
    if (isOid(c) && !gen.has(c)) { gen.set(c, 0); queue.push([c, 0]); }
  }
  while (queue.length > 0) {
    const [oid, g] = queue.shift() as [string, number];
    const obj = repo.objects.get(oid);
    if (!obj || obj.type !== 'commit') continue;
    for (const p of parseCommit(obj.data).parents) {
      if (!gen.has(p)) { gen.set(p, g + 1); queue.push([p, g + 1]); }
    }
  }
  return gen;
}

function isAncestor(repo: Repo, anc: string, desc: string): boolean {
  if (anc === desc) return true;
  return commitGenerations(repo, [desc]).has(peelToCommit(repo, anc));
}

function mergeBase(repo: Repo, a: string, b: string): string | null {
  const ga = commitGenerations(repo, [a]);
  const gb = commitGenerations(repo, [b]);
  let best: string | null = null;
  let bestGen = Infinity;
  for (const [oid, g] of ga) {
    const g2 = gb.get(oid);
    if (g2 !== undefined && g + g2 < bestGen) { bestGen = g + g2; best = oid; }
  }
  return best;
}

/** Objects of one commit only: the commit, its tree, and its blobs — never its
 *  parents. (reachableObjects follows parent links, which is wrong for a
 *  depth-limited fetch.) */
function treeObjects(repo: Repo, commitOid: string): Set<string> {
  const seen = new Set<string>();
  const queue: string[] = [commitOid];
  while (queue.length > 0) {
    const oid = queue.pop() as string;
    if (seen.has(oid)) continue;
    const obj = repo.objects.get(oid);
    if (!obj) continue;
    seen.add(oid);
    if (obj.type === 'commit') queue.push(parseCommit(obj.data).tree);
    else if (obj.type === 'tag') queue.push(parseTag(obj.data).object);
    else if (obj.type === 'tree') for (const e of parseTree(obj.data)) if (e.mode !== '160000') queue.push(e.oid);
  }
  return seen;
}

/** All objects reachable from `roots` (commits, trees, blobs, tags). */
function reachableObjects(repo: Repo, roots: Iterable<string>): Set<string> {
  const seen = new Set<string>();
  const queue: string[] = [...roots];
  while (queue.length > 0) {
    const oid = queue.pop() as string;
    if (seen.has(oid)) continue;
    const obj = repo.objects.get(oid);
    if (!obj) continue;
    seen.add(oid);
    if (obj.type === 'commit') {
      const c = parseCommit(obj.data);
      queue.push(c.tree);
      for (const p of c.parents) queue.push(p);
    } else if (obj.type === 'tag') queue.push(parseTag(obj.data).object);
    else if (obj.type === 'tree') for (const e of parseTree(obj.data)) if (e.mode !== '160000') queue.push(e.oid);
  }
  return seen;
}

/** Flatten a commit's tree to path -> {mode, oid}. */
/** Tree oid of `dirPath` inside `treeOid` ('' = the root tree itself). */
function treeOidAt(repo: Repo, treeOid: string, dirPath: string): string | null {
  if (dirPath === '') return treeOid;
  let current = treeOid;
  for (const segment of dirPath.split('/')) {
    const obj = repo.objects.get(current);
    if (!obj) return null;
    const entry = parseTree(obj.data).find((e) => e.name === segment && e.mode === '40000');
    if (!entry) return null;
    current = entry.oid;
  }
  return current;
}

function flattenTree(repo: Repo, treeOid: string, prefix = '', out = new Map<string, { mode: string; oid: string }>()): Map<string, { mode: string; oid: string }> {
  const obj = repo.objects.get(treeOid);
  if (!obj || obj.type !== 'tree') return out;
  for (const e of parseTree(obj.data)) {
    const path = prefix === '' ? e.name : `${prefix}/${e.name}`;
    if (e.mode === '40000') flattenTree(repo, e.oid, path, out);
    else out.set(path, { mode: e.mode, oid: e.oid });
  }
  return out;
}

/** Build nested trees from a flat path map; returns the root tree oid. */
function buildTreeFromMap(repo: Repo, flat: Map<string, { mode: string; oid: string }>): string {
  interface Node { files: Map<string, { mode: string; oid: string }>; dirs: Map<string, Node>; }
  const make = (): Node => ({ files: new Map(), dirs: new Map() });
  const root = make();
  for (const [path, entry] of flat) {
    const segs = path.split('/');
    let node = root;
    for (let i = 0; i < segs.length - 1; i += 1) {
      const s = segs[i] as string;
      if (!node.dirs.has(s)) node.dirs.set(s, make());
      node = node.dirs.get(s) as Node;
    }
    node.files.set(segs[segs.length - 1] as string, entry);
  }
  const build = (node: Node): string => {
    const entries: TreeEntry[] = [];
    for (const [name, e] of node.files) entries.push({ mode: e.mode, name, oid: e.oid });
    for (const [name, child] of node.dirs) entries.push({ mode: '40000', name, oid: build(child) });
    return storeObject(repo, 'tree', buildTree(entries));
  };
  return build(root);
}

function makeCommit(repo: Repo, treeOid: string, parents: string[], message: string, login: string): string {
  const who = `${login} <${login}@example.invalid> ${EPOCH_SEC + (seq += 1)} +0000`;
  const lines = [`tree ${treeOid}`];
  for (const p of parents) lines.push(`parent ${p}`);
  lines.push(`author ${who}`, `committer ${who}`, '');
  const msg = message.endsWith('\n') ? message : `${message}\n`;
  return storeObject(repo, 'commit', Buffer.from(`${lines.join('\n')}\n${msg}`, 'utf8'));
}

/** Commits reachable from `tip`, newest first (parents after their child). */
function commitList(repo: Repo, tip: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const queue: string[] = [peelToCommit(repo, tip)];
  while (queue.length > 0) {
    const oid = queue.shift() as string;
    if (seen.has(oid)) continue;
    const obj = repo.objects.get(oid);
    if (!obj || obj.type !== 'commit') continue;
    seen.add(oid);
    out.push(oid);
    for (const p of parseCommit(obj.data).parents) queue.push(p);
  }
  return out;
}

function refTip(repo: Repo, branch: string): string | undefined {
  return repo.refs.get(`refs/heads/${branch}`);
}

function headOid(repo: Repo): string | undefined {
  return repo.refs.get(`refs/heads/${repo.defaultBranch}`);
}

// ---------------------------------------------------------------------------
// HTTP plumbing
// ---------------------------------------------------------------------------

function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    req.on('data', (c: Buffer) => {
      total += c.length;
      if (total > 64 * 1024 * 1024) { reject(new Error('body too large')); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function parseJsonBody(buf: Buffer): { ok: true; value: unknown } | { ok: false } {
  if (buf.length === 0) return { ok: true, value: undefined };
  try { return { ok: true, value: JSON.parse(buf.toString('utf8')) as unknown }; }
  catch { return { ok: false }; }
}

function urlOf(req: IncomingMessage): URL {
  const host = req.headers.host ?? '127.0.0.1';
  return new URL(req.url ?? '/', `http://${host}`);
}

function decodePath(p: string): string {
  try { return decodeURIComponent(p); } catch { return p; }
}

// ---------------------------------------------------------------------------
// REST v3
// ---------------------------------------------------------------------------

function repoJson(repo: Repo): Record<string, unknown> {
  return {
    id: repo.id,
    node_id: repoGlobalId(repo),
    name: repo.name,
    full_name: `${repo.owner}/${repo.name}`,
    owner: { login: repo.owner, id: 1000, type: 'User' },
    private: repo.priv,
    description: repo.description,
    default_branch: repo.defaultBranch,
    html_url: `https://example.invalid/${repo.owner}/${repo.name}`,
    url: `/api/v3/repos/${repo.owner}/${repo.name}`,
    created_at: nextTs(),
    updated_at: nextTs(),
    has_issues: true,
    has_projects: false,
    has_wiki: false,
    fork: false,
    archived: false,
    disabled: false,
    visibility: repo.priv ? 'private' : 'public',
    open_issues_count: [...repo.issues.values()].filter((i) => i.state === 'open').length,
  };
}

function issueJson(repo: Repo, issue: Issue): Record<string, unknown> {
  return {
    id: issue.id,
    node_id: issueGlobalId(repo, issue),
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    labels: issue.labels.map((l) => ({ id: l.id, name: l.name, color: l.color })),
    user: { login: repo.owner, id: 1000, type: 'User' },
    created_at: issue.createdAt,
    updated_at: issue.updatedAt,
    comments: (repo.comments.get(issue.number) ?? []).length,
    html_url: `https://example.invalid/${repo.owner}/${repo.name}/issues/${issue.number}`,
    url: `/api/v3/repos/${repo.owner}/${repo.name}/issues/${issue.number}`,
  };
}

function pullJson(repo: Repo, pull: Pull): Record<string, unknown> {
  return {
    id: pull.id,
    node_id: pullGlobalId(repo, pull),
    number: pull.number,
    title: pull.title,
    body: pull.body,
    state: pull.state,
    merged: pull.merged,
    mergeable: pull.mergeable,
    merge_commit_sha: pull.mergeCommitSha,
    merged_at: pull.mergedAt,
    head: { ref: pull.headRef, sha: pull.headSha, label: `${repo.owner}:${pull.headRef}` },
    base: { ref: pull.baseRef, sha: pull.baseSha, label: `${repo.owner}:${pull.baseRef}` },
    user: { login: repo.owner, id: 1000, type: 'User' },
    created_at: pull.createdAt,
    updated_at: pull.createdAt,
  };
}

function paginate<T>(items: T[], url: URL): { page: T[]; link: string | null } {
  const perPage = Math.max(1, Math.min(100, Number(url.searchParams.get('per_page') ?? '30') || 30));
  const page = Math.max(1, Number(url.searchParams.get('page') ?? '1') || 1);
  const start = (page - 1) * perPage;
  const slice = items.slice(start, start + perPage);
  let link: string | null = null;
  const totalPages = Math.max(1, Math.ceil(items.length / perPage));
  if (page < totalPages) {
    const next = new URL(url.toString());
    next.searchParams.set('page', String(page + 1));
    next.searchParams.set('per_page', String(perPage));
    const last = new URL(url.toString());
    last.searchParams.set('page', String(totalPages));
    last.searchParams.set('per_page', String(perPage));
    link = `<${next.toString()}>; rel="next", <${last.toString()}>; rel="last"`;
  }
  return { page: slice, link };
}

function lookupRepo(login: string, owner: string, name: string): Repo | null {
  if (owner !== login) return null;
  return repos.get(repoKey(owner, name)) ?? null;
}

/** Commit one contents change on `branch` (creating the branch from the
 *  default tip when needed); returns the new commit oid. */
function commitContents(repo: Repo, login: string, branch: string, path: string, content: Buffer, message: string, remove = false): string {
  let tip = refTip(repo, branch);
  if (tip === undefined) {
    const base = headOid(repo);
    if (base !== undefined) {
      repo.refs.set(`refs/heads/${branch}`, base);
      tip = base;
    }
  }
  const flat = tip !== undefined ? flattenTree(repo, parseCommit((repo.objects.get(peelToCommit(repo, tip)) as GitObj).data).tree) : new Map<string, { mode: string; oid: string }>();
  if (remove) flat.delete(path);
  else flat.set(path, { mode: '100644', oid: storeObject(repo, 'blob', content) });
  const treeOid = buildTreeFromMap(repo, flat);
  const parents = tip === undefined ? [] : [peelToCommit(repo, tip)];
  const commitOid = makeCommit(repo, treeOid, parents, message, login);
  repo.refs.set(`refs/heads/${branch}`, commitOid);
  repo.version += 1;
  repo.packCache.clear();
  return commitOid;
}

function pullFiles(repo: Repo, pull: Pull): Array<Record<string, unknown>> {
  const merge = mergeBase(repo, pull.baseSha, pull.headSha) ?? pull.baseSha;
  const baseTree = flattenTree(repo, parseCommit((repo.objects.get(peelToCommit(repo, merge)) as GitObj).data).tree);
  const headTree = flattenTree(repo, parseCommit((repo.objects.get(peelToCommit(repo, pull.headSha)) as GitObj).data).tree);
  const out: Array<Record<string, unknown>> = [];
  const paths = new Set([...baseTree.keys(), ...headTree.keys()]);
  for (const path of [...paths].sort()) {
    const b = baseTree.get(path);
    const h = headTree.get(path);
    if (b && h && b.oid === h.oid) continue;
    let status = 'modified';
    let additions = 0;
    let deletions = 0;
    const linesOf = (oid: string): string[] => {
      const o = repo.objects.get(oid);
      return o ? o.data.toString('utf8').split('\n') : [];
    };
    if (!b && h) {
      status = 'added';
      additions = linesOf(h.oid).filter((l) => l !== '').length;
    } else if (b && !h) {
      status = 'removed';
      deletions = linesOf(b.oid).filter((l) => l !== '').length;
    } else if (b && h) {
      const bl = linesOf(b.oid);
      const hl = linesOf(h.oid);
      const counts = new Map<string, number>();
      for (const l of bl) counts.set(l, (counts.get(l) ?? 0) + 1);
      let common = 0;
      for (const l of hl) {
        const c = counts.get(l) ?? 0;
        if (c > 0) { counts.set(l, c - 1); common += 1; }
      }
      additions = hl.length - common;
      deletions = bl.length - common;
      if (additions === 0 && deletions === 0) { additions = 1; }
    }
    out.push({ filename: path, status, additions, deletions, changes: additions + deletions });
  }
  return out;
}

/** Is `pull` mergeable right now (no path changed on both sides differently)? */
function pullConflict(repo: Repo, pull: Pull): boolean {
  const base = mergeBase(repo, pull.baseSha, pull.headSha);
  if (base === null) return false;
  const baseTree = flattenTree(repo, parseCommit((repo.objects.get(base) as GitObj).data).tree);
  // current base tip (the branch may have advanced since the PR was opened)
  const curBaseTip = peelToCommit(repo, refTip(repo, pull.baseRef) ?? pull.baseSha);
  const curBaseTree = flattenTree(repo, parseCommit((repo.objects.get(curBaseTip) as GitObj).data).tree);
  const headTree = flattenTree(repo, parseCommit((repo.objects.get(peelToCommit(repo, pull.headSha)) as GitObj).data).tree);
  const paths = new Set([...baseTree.keys(), ...curBaseTree.keys(), ...headTree.keys()]);
  for (const path of paths) {
    const o = baseTree.get(path)?.oid;
    const c = curBaseTree.get(path)?.oid;
    const h = headTree.get(path)?.oid;
    if (c !== o && h !== o && c !== h) return true;
  }
  return false;
}

function squashMerge(repo: Repo, login: string, pull: Pull): string {
  const curBaseTip = peelToCommit(repo, refTip(repo, pull.baseRef) ?? pull.baseSha);
  const curBaseTree = flattenTree(repo, parseCommit((repo.objects.get(curBaseTip) as GitObj).data).tree);
  const headTree = flattenTree(repo, parseCommit((repo.objects.get(peelToCommit(repo, pull.headSha)) as GitObj).data).tree);
  const merged = new Map(curBaseTree);
  for (const [path, e] of headTree) merged.set(path, e);
  for (const path of [...merged.keys()]) if (!headTree.has(path) && curBaseTree.has(path)) {
    // a path the head deleted relative to the merge base stays deleted only
    // when the base did not touch it since; keep it simple: head wins.
    if (!headTree.has(path)) merged.delete(path);
  }
  const treeOid = buildTreeFromMap(repo, merged);
  const commitOid = makeCommit(repo, treeOid, [curBaseTip], pull.title, login);
  repo.refs.set(`refs/heads/${pull.baseRef}`, commitOid);
  repo.version += 1;
  repo.packCache.clear();
  return commitOid;
}

async function handleRest(req: IncomingMessage, res: ServerResponse, login: string): Promise<void> {
  const url = urlOf(req);
  const method = req.method ?? 'GET';
  const path = url.pathname;
  const segs = path.split('/').filter((s) => s !== '');
  // segs: ['api','v3', ...rest]
  const rest = segs.slice(2);
  const bodyBuf = (method === 'POST' || method === 'PUT' || method === 'PATCH' || method === 'DELETE') ? await readBody(req) : Buffer.alloc(0);
  let body: unknown;
  if (bodyBuf.length > 0) {
    const parsed = parseJsonBody(bodyBuf);
    if (!parsed.ok) { errJson(res, 400, 'Invalid JSON body'); return; }
    body = parsed.value;
  }
  const obj = (body ?? {}) as Record<string, unknown>;
  const str = (v: unknown): string => (typeof v === 'string' ? v : '');

  // ---- API root / meta / user ----
  if (rest.length === 0) {
    if (method === 'GET') {
      jsonBody(res, 200, { current_user_url: '/api/v3/user', rate_limit_url: '/api/v3/rate_limit' }, { 'x-oauth-scopes': 'repo, read:org' });
      return;
    }
    errJson(res, 404, 'Not Found');
    return;
  }
  if (rest[0] === 'meta' && rest.length === 1) {
    if (method === 'GET') { jsonBody(res, 200, { installed_version: FORGE_VERSION }); return; }
    errJson(res, 404, 'Not Found');
    return;
  }
  if (rest[0] === 'user' && rest.length === 1) {
    if (method === 'GET') { jsonBody(res, 200, { login, id: 1000, type: 'User', name: login, email: `${login}@example.invalid` }); return; }
    errJson(res, 404, 'Not Found');
    return;
  }
  if (rest[0] === 'user' && rest[1] === 'repos') {
    if (method === 'GET') {
      const mine = [...repos.values()].filter((r) => r.owner === login).sort((a, b) => a.name.localeCompare(b.name));
      const { page, link } = paginate(mine.map(repoJson), url);
      jsonBody(res, 200, page, link ? { link } : {});
      return;
    }
    if (method === 'POST') {
      const name = str(obj.name);
      if (name === '') { errJson(res, 422, 'Repository name is required'); return; }
      if (repos.has(repoKey(login, name))) { errJson(res, 422, 'Repository already exists'); return; }
      const repo = createRepoInternal(login, name, str(obj.description), obj.private === true);
      jsonBody(res, 201, repoJson(repo));
      return;
    }
    errJson(res, 404, 'Not Found');
    return;
  }

  // ---- /repos/{owner}/{name}/... ----
  if (rest[0] !== 'repos' || rest.length < 3) { errJson(res, 404, 'Not Found'); return; }
  const owner = decodePath(rest[1] ?? '');
  const repoName = decodePath(rest[2] ?? '');
  const repo = lookupRepo(login, owner, repoName);
  if (!repo) { errJson(res, 404, 'Not Found'); return; }
  const tail = rest.slice(3);

  if (tail.length === 0) {
    if (method === 'GET') { jsonBody(res, 200, repoJson(repo)); return; }
    if (method === 'PATCH') {
      if (typeof obj.description === 'string') repo.description = obj.description;
      jsonBody(res, 200, repoJson(repo));
      return;
    }
    if (method === 'DELETE') {
      repos.delete(repoKey(owner, repoName));
      res.writeHead(204, { 'x-github-request-id': `req-${++reqCounter}` });
      res.end();
      return;
    }
    errJson(res, 404, 'Not Found');
    return;
  }

  // branches
  if (tail[0] === 'branches') {
    if (tail.length === 1 && method === 'GET') {
      const list = [...repo.refs.keys()].filter((r) => r.startsWith('refs/heads/')).sort()
        .map((r) => ({ name: r.slice('refs/heads/'.length), commit: { sha: repo.refs.get(r) ?? '' }, protected: false }));
      jsonBody(res, 200, list);
      return;
    }
    if (tail.length === 2 && method === 'GET') {
      const branch = decodePath(tail[1] ?? '');
      const tip = refTip(repo, branch);
      if (tip === undefined) { errJson(res, 404, 'Not Found'); return; }
      jsonBody(res, 200, { name: branch, commit: { sha: tip }, protected: false });
      return;
    }
    errJson(res, 404, 'Not Found');
    return;
  }

  // git refs (Git Data API)
  if (tail[0] === 'git' && tail[1] === 'refs') {
    if (method === 'POST' && tail.length === 2) {
      const ref = str(obj.ref);
      const sha = str(obj.sha);
      if (!ref.startsWith('refs/') || !isOid(sha) || !repo.objects.has(sha)) { errJson(res, 422, 'Invalid ref or sha'); return; }
      if (repo.refs.has(ref)) { errJson(res, 422, 'Reference already exists'); return; }
      repo.refs.set(ref, sha);
      repo.version += 1;
      repo.packCache.clear();
      jsonBody(res, 201, { ref, object: { sha, type: 'commit' } });
      return;
    }
    if (method === 'GET' && tail.length >= 3) {
      const refPath = tail.slice(2).map(decodePath).join('/');
      const ref = `refs/${refPath}`;
      const tip = repo.refs.get(ref);
      if (tip === undefined) { errJson(res, 404, 'Not Found'); return; }
      jsonBody(res, 200, { ref, object: { sha: tip, type: 'commit' } });
      return;
    }
    errJson(res, 404, 'Not Found');
    return;
  }

  // commits
  if (tail[0] === 'commits' && tail.length === 1 && method === 'GET') {
    const shaParam = url.searchParams.get('sha');
    let tip: string | undefined;
    if (shaParam) tip = refTip(repo, shaParam) ?? (isOid(shaParam) ? shaParam : undefined);
    else tip = headOid(repo);
    if (tip === undefined || !repo.objects.has(peelToCommit(repo, tip))) { jsonBody(res, 200, []); return; }
    const list = commitList(repo, tip).map((oid) => {
      const c = parseCommit((repo.objects.get(oid) as GitObj).data);
      return { sha: oid, commit: { message: c.message, author: { name: repo.owner, email: `${repo.owner}@example.invalid` }, committer: { name: repo.owner, email: `${repo.owner}@example.invalid` } }, parents: c.parents.map((p) => ({ sha: p })) };
    });
    jsonBody(res, 200, list);
    return;
  }

  // contents
  if (tail[0] === 'contents') {
    const contentPath = tail.slice(1).map(decodePath).join('/');
    const refParam = url.searchParams.get('ref');
    const branch = refParam ?? repo.defaultBranch;
    const tip = refParam ? (refTip(repo, refParam) ?? (isOid(refParam) ? refParam : undefined)) : headOid(repo);
    if (method === 'GET') {
      if (tip === undefined) { errJson(res, 404, 'Not Found'); return; }
      const treeOid = parseCommit((repo.objects.get(peelToCommit(repo, tip)) as GitObj).data).tree;
      const flat = flattenTree(repo, treeOid);
      if (contentPath === '') {
        const entries = parseTree((repo.objects.get(treeOid) as GitObj).data).map((e) => ({
          type: e.mode === '40000' ? 'dir' : 'file',
          name: e.name,
          path: e.name,
          sha: e.oid,
        }));
        jsonBody(res, 200, entries);
        return;
      }
      const file = flat.get(contentPath);
      if (file) {
        const data = (repo.objects.get(file.oid) as GitObj).data;
        jsonBody(res, 200, { type: 'file', encoding: 'base64', content: data.toString('base64'), sha: file.oid, size: data.length, name: contentPath.split('/').pop() ?? contentPath, path: contentPath });
        return;
      }
      // directory: walk the tree to its oid, then list its entries directly.
      const dirOid = contentPath === '' ? treeOid : treeOidAt(repo, treeOid, contentPath);
      if (dirOid !== null) {
        const treeObj = repo.objects.get(dirOid);
        if (treeObj) {
          const entries = parseTree(treeObj.data).map((e) => ({
            type: e.mode === '40000' ? 'dir' : 'file',
            name: e.name,
            path: contentPath === '' ? e.name : `${contentPath}/${e.name}`,
            sha: e.oid,
          }));
          jsonBody(res, 200, entries);
          return;
        }
      }
      errJson(res, 404, 'Not Found');
      return;
    }
    if (method === 'PUT') {
      const message = str(obj.message) || 'Update file';
      const contentB64 = str(obj.content);
      if (contentB64 === '') { errJson(res, 422, 'content is required'); return; }
      const data = b64decode(contentB64);
      const putBranch = typeof obj.branch === 'string' && obj.branch !== '' ? obj.branch : repo.defaultBranch;
      const currentTip = refTip(repo, putBranch);
      const currentSha = currentTip !== undefined ? flattenTree(repo, parseCommit((repo.objects.get(peelToCommit(repo, currentTip)) as GitObj).data).tree).get(contentPath)?.oid : undefined;
      const isUpdate = currentSha !== undefined;
      if (isUpdate && typeof obj.sha === 'string' && obj.sha !== '' && obj.sha !== currentSha) { errJson(res, 409, 'sha does not match the current file'); return; }
      const commitOid = commitContents(repo, login, putBranch, contentPath, data, message);
      const blobOid = hashObject('blob', data);
      jsonBody(res, isUpdate ? 200 : 201, {
        content: { name: contentPath.split('/').pop() ?? contentPath, path: contentPath, sha: blobOid, size: data.length, encoding: 'base64' },
        commit: { sha: commitOid, message },
      });
      return;
    }
    if (method === 'DELETE') {
      const currentTip = refTip(repo, branch);
      if (currentTip === undefined) { errJson(res, 404, 'Not Found'); return; }
      const flat = flattenTree(repo, parseCommit((repo.objects.get(peelToCommit(repo, currentTip)) as GitObj).data).tree);
      if (!flat.has(contentPath)) { errJson(res, 404, 'Not Found'); return; }
      const commitOid = commitContents(repo, login, branch, contentPath, Buffer.alloc(0), str(obj.message) || 'Delete file', true);
      jsonBody(res, 200, { commit: { sha: commitOid } });
      return;
    }
    errJson(res, 404, 'Not Found');
    return;
  }

  // labels
  if (tail[0] === 'labels') {
    if (method === 'POST' && tail.length === 1) {
      const name = str(obj.name);
      if (name === '') { errJson(res, 422, 'Label name is required'); return; }
      let label = repo.labels.get(name);
      if (!label) {
        label = { id: nextObjectId++, name, color: str(obj.color) || 'ededed' };
        repo.labels.set(name, label);
      }
      jsonBody(res, 201, { id: label.id, name: label.name, color: label.color });
      return;
    }
    if (method === 'GET' && tail.length === 1) {
      jsonBody(res, 200, [...repo.labels.values()].map((l) => ({ id: l.id, name: l.name, color: l.color })));
      return;
    }
    errJson(res, 404, 'Not Found');
    return;
  }

  // issues
  if (tail[0] === 'issues') {
    if (tail.length === 1) {
      if (method === 'GET') {
        let list = [...repo.issues.values()].sort((a, b) => a.createdSeq - b.createdSeq);
        const state = url.searchParams.get('state') ?? 'open';
        if (state !== 'all') list = list.filter((i) => i.state === state);
        const sort = url.searchParams.get('sort') ?? 'created';
        const dir = url.searchParams.get('direction') ?? 'desc';
        if (sort === 'created') list.sort((a, b) => (dir === 'asc' ? a.createdSeq - b.createdSeq : b.createdSeq - a.createdSeq));
        const { page } = paginate(list, url);
        jsonBody(res, 200, page.map((i) => issueJson(repo, i)));
        return;
      }
      if (method === 'POST') {
        const title = str(obj.title);
        if (title === '') { errJson(res, 422, 'Title is required'); return; }
        const labelNames: string[] = Array.isArray(obj.labels)
          ? (obj.labels as unknown[]).map((l) => (typeof l === 'string' ? l : str((l as Record<string, unknown>).name)))
          : [];
        for (const ln of labelNames) {
          if (!repo.labels.has(ln)) { errJson(res, 422, `Label "${ln}" does not exist`); return; }
        }
        const number = repo.nextNum++;
        const issue: Issue = {
          id: nextObjectId++, number, title, body: str(obj.body), state: 'open',
          labels: labelNames.map((ln) => repo.labels.get(ln) as Label),
          createdAt: nextTs(), updatedAt: nextTs(), createdSeq: seq,
        };
        repo.issues.set(number, issue);
        jsonBody(res, 201, issueJson(repo, issue));
        return;
      }
      errJson(res, 404, 'Not Found');
      return;
    }
    const num = Number(tail[1]);
    if (!Number.isInteger(num)) { errJson(res, 404, 'Not Found'); return; }
    if (tail.length === 2) {
      const issue = repo.issues.get(num);
      if (!issue) { errJson(res, 404, 'Not Found'); return; }
      if (method === 'GET') { jsonBody(res, 200, issueJson(repo, issue)); return; }
      if (method === 'PATCH') {
        if (obj.state === 'open' || obj.state === 'closed') issue.state = obj.state;
        if (typeof obj.title === 'string') issue.title = obj.title;
        if (typeof obj.body === 'string') issue.body = obj.body;
        issue.updatedAt = nextTs();
        jsonBody(res, 200, issueJson(repo, issue));
        return;
      }
      errJson(res, 404, 'Not Found');
      return;
    }
    if (tail[2] === 'comments') {
      const issue = repo.issues.get(num);
      if (!issue) { errJson(res, 404, 'Not Found'); return; }
      if (method === 'GET') {
        jsonBody(res, 200, (repo.comments.get(num) ?? []).map((c) => ({ id: c.id, node_id: commentGlobalId(repo, c), body: c.body, user: { login: repo.owner, type: 'User' }, created_at: c.createdAt })));
        return;
      }
      if (method === 'POST') {
        const comment: Comment = { id: repo.nextCommentId++, body: str(obj.body), createdAt: nextTs() };
        const list = repo.comments.get(num) ?? [];
        list.push(comment);
        repo.comments.set(num, list);
        jsonBody(res, 201, { id: comment.id, node_id: commentGlobalId(repo, comment), body: comment.body, user: { login: repo.owner, type: 'User' }, created_at: comment.createdAt });
        return;
      }
      errJson(res, 404, 'Not Found');
      return;
    }
    errJson(res, 404, 'Not Found');
    return;
  }

  // pulls
  if (tail[0] === 'pulls') {
    if (tail.length === 1) {
      if (method === 'GET') {
        let list = [...repo.pulls.values()].sort((a, b) => a.createdSeq - b.createdSeq);
        const state = url.searchParams.get('state') ?? 'open';
        if (state === 'open') list = list.filter((p) => p.state === 'open');
        else if (state === 'closed') list = list.filter((p) => p.state === 'closed');
        const { page } = paginate(list, url);
        jsonBody(res, 200, page.map((p) => pullJson(repo, p)));
        return;
      }
      if (method === 'POST') {
        const title = str(obj.title);
        const head = str(obj.head);
        const base = str(obj.base) || repo.defaultBranch;
        if (title === '' || head === '') { errJson(res, 422, 'title and head are required'); return; }
        const headTip = refTip(repo, head);
        const baseTip = refTip(repo, base);
        if (headTip === undefined || baseTip === undefined) { errJson(res, 422, 'head or base branch does not exist'); return; }
        for (const p of repo.pulls.values()) {
          if (p.state === 'open' && p.headRef === head && p.baseRef === base) { errJson(res, 422, 'A pull request already exists for this head and base'); return; }
        }
        const number = repo.nextNum++;
        const pull: Pull = {
          id: nextObjectId++, number, title, body: str(obj.body), state: 'open',
          headRef: head, baseRef: base,
          headSha: peelToCommit(repo, headTip), baseSha: peelToCommit(repo, baseTip),
          merged: false, mergeable: true, mergeCommitSha: null, mergedAt: null,
          createdAt: nextTs(), createdSeq: seq,
        };
        pull.mergeable = !pullConflict(repo, pull);
        repo.pulls.set(number, pull);
        jsonBody(res, 201, pullJson(repo, pull));
        return;
      }
      errJson(res, 404, 'Not Found');
      return;
    }
    const num = Number(tail[1]);
    if (!Number.isInteger(num)) { errJson(res, 404, 'Not Found'); return; }
    const pull = repo.pulls.get(num);
    if (tail.length === 3 && tail[2] === 'files') {
      if (!pull) { errJson(res, 404, 'Not Found'); return; }
      if (method === 'GET') { jsonBody(res, 200, pullFiles(repo, pull)); return; }
      errJson(res, 404, 'Not Found');
      return;
    }
    if (tail.length === 3 && tail[2] === 'merge') {
      if (!pull) { errJson(res, 404, 'Not Found'); return; }
      if (method !== 'PUT') { errJson(res, 404, 'Not Found'); return; }
      if (pull.state === 'closed') { errJson(res, 405, 'Pull request is already closed'); return; }
      if (pullConflict(repo, pull)) { errJson(res, 405, 'Merge conflict'); return; }
      const mergeSha = squashMerge(repo, login, pull);
      pull.state = 'closed';
      pull.merged = true;
      pull.mergeCommitSha = mergeSha;
      pull.mergedAt = nextTs();
      pull.mergeable = true;
      jsonBody(res, 200, { sha: mergeSha, merged: true, message: `Pull request #${pull.number} merged` });
      return;
    }
    if (tail.length === 2) {
      if (!pull) { errJson(res, 404, 'Not Found'); return; }
      if (method === 'GET') { jsonBody(res, 200, pullJson(repo, pull)); return; }
      errJson(res, 404, 'Not Found');
      return;
    }
    errJson(res, 404, 'Not Found');
    return;
  }

  errJson(res, 404, 'Not Found');
}

// ---------------------------------------------------------------------------
// git smart HTTP
// ---------------------------------------------------------------------------

function sortedRefs(repo: Repo): Array<{ name: string; oid: string }> {
  return [...repo.refs.entries()].sort((a, b) => a[0].localeCompare(b[0])).map(([name, oid]) => ({ name, oid }));
}

function peeledOid(repo: Repo, oid: string): string | null {
  const obj = repo.objects.get(oid);
  if (!obj) return null;
  if (obj.type === 'tag') return peelToCommit(repo, oid);
  return null;
}

function v0Advertisement(repo: Repo, service: string): Buffer {
  const capsUpload = 'multi_ack_detailed multi_ack thin-pack side-band side-band-64k ofs-delta shallow deepen-since deepen-not no-progress include-tag agent=' + AGENT + ' symref=HEAD:refs/heads/main object-format=sha1';
  const capsReceive = 'report-status side-band-64k delete-refs ofs-delta agent=' + AGENT + ' symref=HEAD:refs/heads/main object-format=sha1';
  const caps = service === 'git-receive-pack' ? capsReceive : capsUpload;
  const parts: Buffer[] = [pktLine(`# service=${service}\n`), pktFlush()];
  const refs = sortedRefs(repo);
  const headTip = headOid(repo);
  const lines: string[] = [];
  if (refs.length === 0) {
    lines.push(`${ZERO_OID} capabilities^{}\0${caps}\n`);
  } else {
    const headLine = headTip !== undefined ? `${headTip} HEAD\0${caps}\n` : null;
    if (headLine) lines.push(headLine);
    for (const r of refs) {
      lines.push(`${r.oid} ${r.name}\n`);
      const peeled = peeledOid(repo, r.oid);
      if (peeled !== null) lines.push(`${peeled} ${r.name}^{}\n`);
    }
  }
  for (const l of lines) parts.push(pktLine(l));
  parts.push(pktFlush());
  return Buffer.concat(parts);
}

function v2Advertisement(): Buffer {
  return Buffer.concat([
    pktLine('version 2\n'),
    pktLine('ls-refs=unborn\n'),
    pktLine('fetch=shallow filter\n'),
    pktLine('server-option\n'),
    pktLine('object-format=sha1\n'),
    pktLine(`agent=${AGENT}\n`),
    pktFlush(),
  ]);
}

/** Objects for a fetch: depth-limited closure of wants minus what the client
 *  already holds (haves' closure, stopping at the client's shallow boundary). */
function fetchSelection(repo: Repo, wants: string[], haves: string[], depth: number | null, shallowReq: string[]): { objects: GitObj[]; shallow: string[]; unshallow: string[] } {
  const shallowSet = new Set(shallowReq);
  // wanted commits with generation
  const gen = new Map<string, number>();
  const queue: Array<[string, number]> = [];
  const addRoot = (oid: string): void => {
    const c = peelToCommit(repo, oid);
    if (isOid(c) && !gen.has(c)) { gen.set(c, 0); queue.push([c, 0]); }
  };
  for (const w of wants) {
    const obj = repo.objects.get(w);
    if (obj?.type === 'tag') { addRoot(w); continue; }
    addRoot(w);
  }
  const includedCommits = new Set<string>();
  const boundary = new Set<string>();
  while (queue.length > 0) {
    const [oid, g] = queue.shift() as [string, number];
    includedCommits.add(oid);
    const obj = repo.objects.get(oid);
    if (!obj || obj.type !== 'commit') continue;
    const parents = parseCommit(obj.data).parents;
    if (depth !== null && g + 1 >= depth) {
      if (parents.length > 0) boundary.add(oid);
      continue;
    }
    for (const p of parents) if (!gen.has(p)) { gen.set(p, g + 1); queue.push([p, g + 1]); }
  }
  // held closure: haves, not descending past a shallow boundary commit
  const held = new Set<string>();
  const hqueue: string[] = [];
  for (const h of haves) {
    const c = peelToCommit(repo, h);
    if (isOid(c)) hqueue.push(c);
    const o = repo.objects.get(h);
    if (o?.type === 'tag') held.add(h);
  }
  const heldCommits = new Set<string>();
  while (hqueue.length > 0) {
    const oid = hqueue.shift() as string;
    if (heldCommits.has(oid)) continue;
    heldCommits.add(oid);
    if (shallowSet.has(oid)) continue;
    const obj = repo.objects.get(oid);
    if (!obj || obj.type !== 'commit') continue;
    for (const p of parseCommit(obj.data).parents) hqueue.push(p);
  }
  // held closure: haves' trees/blobs only — never descend past a shallow
  // boundary commit, and never follow parent links (the held set stops at
  // the boundary; reachableObjects would leak ancestors into it).
  for (const c of heldCommits) for (const o of treeObjects(repo, c)) held.add(o);
  // wanted objects: included commits + their trees/blobs (+ wanted tags)
  const wanted = new Set<string>();
  for (const c of includedCommits) for (const o of treeObjects(repo, c)) wanted.add(o);
  for (const w of wants) {
    const obj = repo.objects.get(w);
    if (obj?.type === 'tag') wanted.add(w);
  }
  const objects: GitObj[] = [];
  for (const oid of wanted) {
    if (held.has(oid)) continue;
    const o = repo.objects.get(oid);
    if (o) objects.push(o);
  }
  const shallow = [...boundary].sort();
  const unshallow = shallowReq.filter((s) => includedCommits.has(s) && !boundary.has(s)).sort();
  return { objects, shallow, unshallow };
}

function sidebandPack(pack: Buffer): Buffer[] {
  const out: Buffer[] = [];
  const CHUNK = 65515;
  for (let i = 0; i < pack.length; i += CHUNK) {
    const slice = pack.subarray(i, Math.min(pack.length, i + CHUNK));
    out.push(pktLine(Buffer.concat([Buffer.from([1]), slice])));
  }
  return out;
}

function v2FetchResponse(repo: Repo, wants: string[], haves: string[], depth: number | null, shallowReq: string[]): Buffer {
  const sel = fetchSelection(repo, wants, haves, depth, shallowReq);
  const pack = writePack(sel.objects);
  const cacheKey = `${repo.version}|${[...wants].sort().join(',')}|${[...haves].sort().join(',')}|${depth}|${[...shallowReq].sort().join(',')}`;
  let packBuf = repo.packCache.get(cacheKey);
  if (!packBuf) { packBuf = pack; repo.packCache.set(cacheKey, packBuf); }
  const parts: Buffer[] = [];
  if (haves.length > 0) {
    parts.push(pktLine('acknowledgments\n'), pktLine('NAK\n'), pktDelim());
  }
  if (sel.shallow.length > 0 || sel.unshallow.length > 0) {
    parts.push(pktLine('shallow-info\n'));
    for (const s of sel.shallow) parts.push(pktLine(`shallow ${s}\n`));
    for (const s of sel.unshallow) parts.push(pktLine(`unshallow ${s}\n`));
    parts.push(pktDelim());
  }
  const wantedRefs: Array<{ oid: string; ref: string }> = [];
  for (const r of sortedRefs(repo)) if (wants.includes(r.oid)) wantedRefs.push({ oid: r.oid, ref: r.name });
  if (wantedRefs.length > 0) {
    parts.push(pktLine('wanted-refs\n'));
    for (const r of wantedRefs) parts.push(pktLine(`${r.oid} ${r.ref}\n`));
    parts.push(pktDelim());
  }
  parts.push(pktLine('packfile\n'));
  parts.push(...sidebandPack(packBuf));
  parts.push(pktFlush());
  return Buffer.concat(parts);
}

function v0FetchResponse(repo: Repo, wants: string[], haves: string[], depth: number | null, shallowReq: string[]): Buffer {
  const sel = fetchSelection(repo, wants, haves, depth, shallowReq);
  const pack = writePack(sel.objects);
  const parts: Buffer[] = [];
  if (haves.length > 0) parts.push(pktLine('NAK\n'));
  for (const s of sel.shallow) parts.push(pktLine(`shallow ${s}\n`));
  for (const s of sel.unshallow) parts.push(pktLine(`unshallow ${s}\n`));
  parts.push(...sidebandPack(pack));
  parts.push(pktFlush());
  return Buffer.concat(parts);
}

async function handleGit(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const url = urlOf(req);
  const method = req.method ?? 'GET';
  const m = /^\/([^/]+)\/([^/]+)\.git\/(info\/refs|git-upload-pack|git-receive-pack)$/.exec(url.pathname);
  if (!m) {
    res.writeHead(404, { 'content-type': 'application/json; charset=utf-8', 'x-github-request-id': `req-${++reqCounter}` });
    res.end(JSON.stringify({ message: 'Not Found' }));
    return;
  }
  const owner = decodePath(m[1] ?? '');
  const repoName = decodePath(m[2] ?? '');
  const action = m[3] ?? '';
  const auth = authed(req);
  // git is driven by the suite with the same bearer token; still answer 404
  // for a repo that is not the token owner's, never 403.
  const repo = auth.ok ? lookupRepo(auth.login, owner, repoName) : null;
  if (!repo) {
    res.writeHead(404, { 'content-type': 'application/json; charset=utf-8', 'x-github-request-id': `req-${++reqCounter}` });
    res.end(JSON.stringify({ message: 'Not Found' }));
    return;
  }

  if (action === 'info/refs' && method === 'GET') {
    const service = url.searchParams.get('service') ?? '';
    if (service !== 'git-upload-pack' && service !== 'git-receive-pack') {
      res.writeHead(400, { 'content-type': 'text/plain' });
      res.end('bad service');
      return;
    }
    const isV2 = service === 'git-upload-pack' && (req.headers['git-protocol'] ?? '') === 'version=2';
    const body = isV2 ? v2Advertisement() : v0Advertisement(repo, service);
    res.writeHead(200, {
      'content-type': `application/x-${service}-advertisement`,
      'content-length': body.length,
      'x-github-request-id': `req-${++reqCounter}`,
    });
    res.end(body);
    return;
  }

  if (action === 'git-upload-pack' && method === 'POST') {
    let body: Buffer;
    try { body = await readBody(req); } catch { res.writeHead(400); res.end(); return; }
    const isV2 = (req.headers['git-protocol'] ?? '') === 'version=2';
    let response: Buffer;
    try {
      const { packets } = decodePktLines(body);
      const lines = packets.filter((p) => p.kind === 'data').map((p) => p.payload.toString('utf8'));
      if (isV2) {
        const first = lines[0] ?? '';
        if (first.startsWith('command=ls-refs')) {
          const args = lines.slice(1);
          const prefixes: string[] = [];
          let peel = false;
          let symrefs = false;
          let unborn = false;
          for (const a of args) {
            const t = a.replace(/\n$/, '');
            if (t === 'peel') peel = true;
            else if (t === 'symrefs') symrefs = true;
            else if (t === 'unborn') unborn = true;
            else if (t.startsWith('ref-prefix ')) prefixes.push(t.slice('ref-prefix '.length));
          }
          const out: Buffer[] = [];
          const refs = sortedRefs(repo);
          const headTip = headOid(repo);
          const keep = (name: string): boolean => prefixes.length === 0 || prefixes.some((p) => name.startsWith(p));
          // HEAD is listed when no prefix filter is given, or when 'HEAD'
          // itself matches one of the requested prefixes.
          const wantHead = prefixes.length === 0 || prefixes.some((p) => 'HEAD'.startsWith(p));
          if (wantHead) {
            if (headTip !== undefined) out.push(pktLine(`${headTip} HEAD${symrefs ? ' symref-target:refs/heads/main' : ''}\n`));
            else if (unborn) out.push(pktLine('unborn HEAD symref-target:refs/heads/main\n'));
          }
          for (const r of refs) {
            if (!keep(r.name)) continue;
            let line = `${r.oid} ${r.name}`;
            if (peel) {
              const peeled = peeledOid(repo, r.oid);
              if (peeled !== null) line += ` peeled:${peeled}`;
            }
            out.push(pktLine(`${line}\n`));
          }
          out.push(pktFlush());
          response = Buffer.concat(out);
        } else if (first.startsWith('command=fetch')) {
          const args = lines.slice(1);
          const wants: string[] = [];
          const haves: string[] = [];
          const shallowReq: string[] = [];
          let depth: number | null = null;
          for (const a of args) {
            const t = a.replace(/\n$/, '');
            if (t.startsWith('want ')) wants.push(t.slice(5).trim());
            else if (t.startsWith('have ')) haves.push(t.slice(5).trim());
            else if (t.startsWith('shallow ')) shallowReq.push(t.slice(8).trim());
            else if (t.startsWith('deepen ')) { const n = Number(t.slice(7).trim()); if (Number.isFinite(n)) depth = n; }
          }
          response = v2FetchResponse(repo, wants, haves, depth, shallowReq);
        } else throw new Error(`unknown v2 command ${JSON.stringify(first)}`);
      } else {
        // v0 fetch
        const wants: string[] = [];
        const haves: string[] = [];
        const shallowReq: string[] = [];
        let depth: number | null = null;
        let section = 0;
        for (const p of packets) {
          if (p.kind === 'flush') { section += 1; continue; }
          if (p.kind !== 'data') continue;
          const t = p.payload.toString('utf8').replace(/\n$/, '');
          if (t.startsWith('want ')) wants.push(t.slice(5).split(' ')[0] as string);
          else if (t.startsWith('have ')) haves.push(t.slice(5).trim());
          else if (t.startsWith('shallow ')) shallowReq.push(t.slice(8).trim());
          else if (t.startsWith('deepen ')) { const n = Number(t.slice(7).trim()); if (Number.isFinite(n)) depth = n; }
        }
        void section;
        response = v0FetchResponse(repo, wants, haves, depth, shallowReq);
      }
    } catch {
      res.writeHead(400, { 'content-type': 'text/plain' });
      res.end('bad request');
      return;
    }
    res.writeHead(200, {
      'content-type': 'application/x-git-upload-pack-result',
      'content-length': response.length,
      'x-github-request-id': `req-${++reqCounter}`,
    });
    res.end(response);
    return;
  }

  if (action === 'git-receive-pack' && method === 'POST') {
    let body: Buffer;
    try { body = await readBody(req); } catch { res.writeHead(400); res.end(); return; }
    const { packets, consumed } = decodePktLines(body);
    const commands: Array<{ oldOid: string; newOid: string; ref: string; caps: string }> = [];
    let unpackError: string | null = null;
    let packObjects = new Map<string, GitObj>();
    try {
      for (const p of packets) {
        if (p.kind === 'flush') break;
        if (p.kind !== 'data') continue;
        const text = p.payload.toString('utf8').replace(/\n$/, '');
        const nul = text.indexOf('\0');
        const main = nul >= 0 ? text.slice(0, nul) : text;
        const caps = nul >= 0 ? text.slice(nul + 1) : '';
        const parts = main.split(' ');
        if (parts.length >= 3 && isOid(parts[0]) && isOid(parts[1])) {
          commands.push({ oldOid: parts[0] as string, newOid: parts[1] as string, ref: parts.slice(2).join(' '), caps });
        }
      }
      const packBytes = body.subarray(consumed);
      if (packBytes.length > 0) {
        packObjects = readPack(packBytes, (oid) => repo.objects.get(oid));
      }
    } catch (e) {
      unpackError = e instanceof Error ? e.message : String(e);
    }
    const sideband = commands.length > 0 && commands[0]?.caps.includes('side-band-64k') === true;
    const reportLines: string[] = [];
    if (unpackError !== null) {
      reportLines.push(`unpack ${unpackError}\n`);
      for (const c of commands) reportLines.push(`ng ${c.ref} unpack failed\n`);
    } else {
      for (const [oid, o] of packObjects) if (!repo.objects.has(oid)) repo.objects.set(oid, o);
      if (packObjects.size > 0) { repo.version += 1; repo.packCache.clear(); }
      reportLines.push('unpack ok\n');
      for (const c of commands) {
        const current = repo.refs.get(c.ref);
        let ok = false;
        let reason = '';
        if (c.newOid === ZERO_OID) {
          // delete
          if (current === undefined) { reason = 'remote ref does not exist'; }
          else if (c.oldOid !== ZERO_OID && c.oldOid !== current) { reason = 'non-fast-forward'; }
          else { repo.refs.delete(c.ref); ok = true; }
        } else if (c.oldOid === ZERO_OID) {
          // create
          if (current !== undefined) { reason = 'already exists'; }
          else if (!repo.objects.has(c.newOid)) { reason = 'object not found'; }
          else { repo.refs.set(c.ref, c.newOid); ok = true; }
        } else {
          // update
          if (current === undefined) { reason = 'remote ref does not exist'; }
          else if (c.oldOid !== current) { reason = 'non-fast-forward'; }
          else if (!repo.objects.has(c.newOid)) { reason = 'object not found'; }
          else if (!isAncestor(repo, c.oldOid, c.newOid)) { reason = 'non-fast-forward'; }
          else { repo.refs.set(c.ref, c.newOid); ok = true; }
        }
        if (ok) { repo.version += 1; repo.packCache.clear(); }
        reportLines.push(ok ? `ok ${c.ref}\n` : `ng ${c.ref} ${reason}\n`);
      }
    }
    const out: Buffer[] = [];
    if (sideband) {
      // The report-status stream is itself pkt-lined *inside* band 1: the
      // client demuxes band 1, then parses the payload as pkt-lines.
      const inner = Buffer.concat([...reportLines.map((l) => pktLine(l)), pktFlush()]);
      const CHUNK = 65515;
      for (let i = 0; i < inner.length; i += CHUNK) {
        const slice = inner.subarray(i, Math.min(inner.length, i + CHUNK));
        out.push(pktLine(Buffer.concat([Buffer.from([1]), slice])));
      }
    } else {
      for (const line of reportLines) out.push(pktLine(line));
    }
    out.push(pktFlush());
    const response = Buffer.concat(out);
    res.writeHead(200, {
      'content-type': 'application/x-git-receive-pack-result',
      'content-length': response.length,
      'x-github-request-id': `req-${++reqCounter}`,
    });
    res.end(response);
    return;
  }

  res.writeHead(405, { 'content-type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify({ message: 'Method Not Allowed' }));
}

// ---------------------------------------------------------------------------
// GraphQL v4 (a small executor for the documents gh / github-mcp-server send)
// ---------------------------------------------------------------------------

type GqlValue =
  | { kind: 'var'; name: string }
  | { kind: 'string'; value: string }
  | { kind: 'int'; value: number }
  | { kind: 'bool'; value: boolean }
  | { kind: 'null' }
  | { kind: 'enum'; value: string }
  | { kind: 'list'; items: GqlValue[] }
  | { kind: 'object'; fields: Array<[string, GqlValue]> };

interface GqlSel {
  kind: 'field' | 'fragment' | 'spread';
  name?: string;
  alias?: string;
  args?: Map<string, GqlValue>;
  sel?: GqlSel[];
  typeCond?: string;
  spread?: string;
}
interface GqlOp { type: 'query' | 'mutation'; name?: string; vars: Map<string, string>; sel: GqlSel[]; }

function tokenizeGql(src: string): string[] {
  const tokens: string[] = [];
  let i = 0;
  while (i < src.length) {
    const c = src[i] as string;
    if (c === ' ' || c === '\t' || c === '\n' || c === '\r' || c === ',') { i += 1; continue; }
    if (c === '#') { while (i < src.length && src[i] !== '\n') i += 1; continue; }
    if (c === '.' && src.slice(i, i + 3) === '...') { tokens.push('...'); i += 3; continue; }
    if ('{}():!@$=[]'.includes(c)) { tokens.push(c); i += 1; continue; }
    if (c === '"') {
      let j = i + 1;
      let out = '';
      while (j < src.length && src[j] !== '"') {
        if (src[j] === '\\' && j + 1 < src.length) { const e = src[j + 1] as string; out += e === 'n' ? '\n' : e === 't' ? '\t' : e === 'r' ? '\r' : e; j += 2; }
        else { out += src[j] as string; j += 1; }
      }
      tokens.push(JSON.stringify(out));
      i = j + 1;
      continue;
    }
    let j = i;
    while (j < src.length && /[A-Za-z0-9_.-]/.test(src[j] as string)) j += 1;
    if (j === i) { i += 1; continue; }
    tokens.push(src.slice(i, j));
    i = j;
  }
  return tokens;
}

class GqlParser {
  private pos = 0;
  private readonly toks: string[];
  constructor(toks: string[]) { this.toks = toks; }
  peek(): string | undefined { return this.toks[this.pos]; }
  next(): string { return this.toks[this.pos++] as string; }
  expect(t: string): void { const got = this.next(); if (got !== t) throw new Error(`expected ${t}, got ${got}`); }
  parseDocument(): { ops: GqlOp[]; frags: Map<string, GqlSel[]> } {
    const ops: GqlOp[] = [];
    const frags = new Map<string, GqlSel[]>();
    while (this.pos < this.toks.length) {
      const t = this.next();
      if (t === 'fragment') {
        const name = this.next();
        this.expect('on');
        const typeCond = this.next();
        void typeCond;
        frags.set(name, this.parseSelection());
      } else if (t === 'query' || t === 'mutation') {
        let name: string | undefined;
        const vars = new Map<string, string>();
        if (this.peek() !== undefined && this.peek() !== '{' && this.peek() !== '(') name = this.next();
        if (this.peek() === '(') {
          this.expect('(');
          while (this.peek() !== ')') {
            this.expect('$');
            const vn = this.next();
            this.expect(':');
            let type = '';
            while (this.peek() !== undefined && this.peek() !== '=' && this.peek() !== ',' && this.peek() !== ')') type += this.next();
            vars.set(vn, type);
            if (this.peek() === '=') { this.next(); this.parseValue(); }
            if (this.peek() === ',') this.next();
          }
          this.expect(')');
        }
        ops.push({ type: t as 'query' | 'mutation', name, vars, sel: this.parseSelection() });
      } else if (t === '{') {
        this.pos -= 1;
        ops.push({ type: 'query', vars: new Map(), sel: this.parseSelection() });
      }
    }
    return { ops, frags };
  }
  parseSelection(): GqlSel[] {
    this.expect('{');
    const out: GqlSel[] = [];
    while (this.peek() !== '}' && this.peek() !== undefined) {
      if (this.peek() === '...') {
        this.next();
        const name = this.next();
        if (name === 'on') {
          const typeCond = this.next();
          out.push({ kind: 'fragment', typeCond, sel: this.parseSelection() });
        } else {
          out.push({ kind: 'spread', spread: name });
        }
        continue;
      }
      const first = this.next();
      let alias: string | undefined;
      let name = first;
      if (this.peek() === ':') { this.next(); alias = first; name = this.next(); }
      let args: Map<string, GqlValue> | undefined;
      if (this.peek() === '(') args = this.parseArgs();
      let sel: GqlSel[] | undefined;
      if (this.peek() === '{') sel = this.parseSelection();
      out.push({ kind: 'field', name, alias, args, sel });
    }
    this.expect('}');
    return out;
  }
  parseArgs(): Map<string, GqlValue> {
    this.expect('(');
    const args = new Map<string, GqlValue>();
    while (this.peek() !== ')') {
      const name = this.next();
      this.expect(':');
      args.set(name, this.parseValue());
      if (this.peek() === ',') this.next();
    }
    this.expect(')');
    return args;
  }
  parseValue(): GqlValue {
    const t = this.next();
    if (t === '$') return { kind: 'var', name: this.next() };
    if (t === '{') {
      const fields: Array<[string, GqlValue]> = [];
      while (this.peek() !== '}') {
        const name = this.next();
        this.expect(':');
        fields.push([name, this.parseValue()]);
        if (this.peek() === ',') this.next();
      }
      this.expect('}');
      return { kind: 'object', fields };
    }
    if (t === '[') {
      const items: GqlValue[] = [];
      while (this.peek() !== ']') { items.push(this.parseValue()); if (this.peek() === ',') this.next(); }
      this.expect(']');
      return { kind: 'list', items };
    }
    if (t === 'true') return { kind: 'bool', value: true };
    if (t === 'false') return { kind: 'bool', value: false };
    if (t === 'null') return { kind: 'null' };
    if (t.startsWith('"')) return { kind: 'string', value: JSON.parse(t) as string };
    if (/^-?\d+$/.test(t)) return { kind: 'int', value: Number(t) };
    if (/^-?\d+\.\d+$/.test(t)) return { kind: 'int', value: Number(t) };
    return { kind: 'enum', value: t };
  }
}

function resolveValue(v: GqlValue, vars: Record<string, unknown>): unknown {
  switch (v.kind) {
    case 'var': return vars[v.name];
    case 'string': case 'int': case 'bool': return v.value;
    case 'null': return null;
    case 'enum': return v.value;
    case 'list': return v.items.map((i) => resolveValue(i, vars));
    case 'object': {
      const out: Record<string, unknown> = {};
      for (const [k, val] of v.fields) out[k] = resolveValue(val, vars);
      return out;
    }
  }
}

const SCHEMA_FIELDS: Record<string, string[]> = {
  Issue: ['id', 'number', 'title', 'body', 'state', 'url', 'createdAt', 'updatedAt', 'author', 'labels', 'comments', 'repository'],
  PullRequest: ['id', 'number', 'title', 'body', 'state', 'merged', 'mergeable', 'headRefName', 'baseRefName', 'headRef', 'baseRef', 'files', 'url', 'createdAt', 'updatedAt', 'author'],
  Repository: ['id', 'databaseId', 'name', 'nameWithOwner', 'owner', 'defaultBranchRef', 'viewerPermission', 'hasIssuesEnabled', 'issue', 'issues', 'pullRequests', 'pullRequest', 'url', 'description', 'createdAt'],
  User: ['id', 'login', 'name', 'email', 'url'],
  Query: ['viewer', 'repository', 'node'],
  Mutation: ['createIssue', 'closeIssue', 'createPullRequest', 'mergePullRequest', 'addComment'],
};
const SEARCH_ENUMS = ['ISSUE', 'REPOSITORY', 'USER', 'DISCUSSION', 'COMMIT', 'CODE', 'WIKI', 'REGISTRY', 'PROJECT'];

interface GqlNode { __gql: string; [key: string]: unknown; }

function cursorFor(n: number): string { return Buffer.from(`cursor:${n}`, 'utf8').toString('base64'); }
function numberFromCursor(c: unknown): number | null {
  if (typeof c !== 'string' || c === '') return null;
  try {
    const m = /^cursor:(\d+)$/.exec(Buffer.from(c, 'base64').toString('utf8'));
    return m ? Number(m[1]) : null;
  } catch { return null; }
}

class GraphQLExecutor {
  private errors: Array<{ message: string }> = [];
  private readonly login: string;
  private readonly frags: Map<string, GqlSel[]>;
  constructor(login: string, frags: Map<string, GqlSel[]>) { this.login = login; this.frags = frags; }

  private issueNode(repo: Repo, issue: Issue): GqlNode {
    return { __gql: 'Issue', repo, issue };
  }
  private pullNode(repo: Repo, pull: Pull): GqlNode {
    return { __gql: 'PullRequest', repo, pull };
  }
  private repoNode(repo: Repo): GqlNode {
    return { __gql: 'Repository', repo };
  }

  private issueConnection(repo: Repo, args: Record<string, unknown>): GqlNode {
    let list = [...repo.issues.values()];
    const states = args.states as string[] | undefined;
    if (states && states.length > 0) {
      const want = new Set(states.map((s) => s.toLowerCase()));
      list = list.filter((i) => want.has(i.state));
    }
    const orderBy = args.orderBy as { field?: string; direction?: string } | undefined;
    const dir = orderBy?.direction === 'ASC' ? 1 : -1;
    list.sort((a, b) => dir * (a.number - b.number));
    const afterNum = numberFromCursor(args.after);
    if (afterNum !== null) list = list.filter((i) => (dir === 1 ? i.number > afterNum : i.number < afterNum));
    const first = typeof args.first === 'number' ? args.first : 100;
    const nodes = list.slice(0, first);
    const hasNext = list.length > nodes.length;
    return {
      __gql: 'IssueConnection',
      nodes: nodes.map((i) => this.issueNode(repo, i)),
      totalCount: list.length,
      pageInfo: {
        hasNextPage: hasNext,
        hasPreviousPage: false,
        endCursor: nodes.length > 0 ? cursorFor((nodes[nodes.length - 1] as Issue).number) : null,
        startCursor: nodes.length > 0 ? cursorFor((nodes[0] as Issue).number) : null,
      },
    };
  }

  private pullConnection(repo: Repo, args: Record<string, unknown>): GqlNode {
    let list = [...repo.pulls.values()];
    const states = args.states as string[] | undefined;
    if (states && states.length > 0) {
      const want = new Set(states.map((s) => s.toLowerCase()));
      list = list.filter((p) => want.has(p.state === 'open' ? 'open' : p.merged ? 'merged' : 'closed'));
    } else {
      list = list.filter((p) => p.state === 'open');
    }
    list.sort((a, b) => b.number - a.number);
    const afterNum = numberFromCursor(args.after);
    if (afterNum !== null) list = list.filter((p) => p.number < afterNum);
    const first = typeof args.first === 'number' ? args.first : 100;
    const nodes = list.slice(0, first);
    return {
      __gql: 'PullRequestConnection',
      nodes: nodes.map((p) => this.pullNode(repo, p)),
      totalCount: list.length,
      pageInfo: {
        hasNextPage: list.length > nodes.length,
        hasPreviousPage: false,
        endCursor: nodes.length > 0 ? cursorFor((nodes[nodes.length - 1] as Pull).number) : null,
        startCursor: nodes.length > 0 ? cursorFor((nodes[0] as Pull).number) : null,
      },
    };
  }

  private createIssueInternal(repo: Repo, title: string, bodyText: string): Issue {
    const number = repo.nextNum++;
    const issue: Issue = {
      id: nextObjectId++, number, title, body: bodyText, state: 'open', labels: [],
      createdAt: nextTs(), updatedAt: nextTs(), createdSeq: seq,
    };
    repo.issues.set(number, issue);
    return issue;
  }

  private createPullInternal(repo: Repo, title: string, bodyText: string, head: string, base: string): Pull | null {
    const headTip = refTip(repo, head);
    const baseTip = refTip(repo, base);
    if (headTip === undefined || baseTip === undefined) return null;
    for (const p of repo.pulls.values()) {
      if (p.state === 'open' && p.headRef === head && p.baseRef === base) return null;
    }
    const number = repo.nextNum++;
    const pull: Pull = {
      id: nextObjectId++, number, title, body: bodyText, state: 'open',
      headRef: head, baseRef: base,
      headSha: peelToCommit(repo, headTip), baseSha: peelToCommit(repo, baseTip),
      merged: false, mergeable: true, mergeCommitSha: null, mergedAt: null,
      createdAt: nextTs(), createdSeq: seq,
    };
    pull.mergeable = !pullConflict(repo, pull);
    repo.pulls.set(number, pull);
    return pull;
  }

  private mergePullInternal(repo: Repo, pull: Pull): boolean {
    if (pull.state === 'closed') return false;
    if (pullConflict(repo, pull)) return false;
    const mergeSha = squashMerge(repo, this.login, pull);
    pull.state = 'closed';
    pull.merged = true;
    pull.mergeCommitSha = mergeSha;
    pull.mergedAt = nextTs();
    pull.mergeable = true;
    return true;
  }

  executeSelection(node: unknown, sel: GqlSel[], vars: Record<string, unknown>): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    for (const item of sel) {
      if (item.kind === 'spread') {
        const frag = this.frags.get(item.spread ?? '');
        if (frag) Object.assign(out, this.executeSelection(node, frag, vars));
        continue;
      }
      if (item.kind === 'fragment') {
        Object.assign(out, this.executeSelection(node, item.sel ?? [], vars));
        continue;
      }
      const key = item.alias ?? (item.name as string);
      const args: Record<string, unknown> = {};
      if (item.args) for (const [k, v] of item.args) args[k] = resolveValue(v, vars);
      const value = this.resolveField(node, item.name as string, args, item.sel ?? [], vars);
      if (value !== undefined) out[key] = value;
    }
    return out;
  }

  private resolveField(node: unknown, name: string, args: Record<string, unknown>, sel: GqlSel[], vars: Record<string, unknown>): unknown {
    if (node === null || node === undefined) return null;
    if (typeof node === 'object' && '__gql' in (node as Record<string, unknown>)) {
      const n = node as GqlNode;
      const typeName = n.__gql as string;
      const known = SCHEMA_FIELDS[typeName];
      if (typeName === 'Query' || typeName === 'Mutation') {
        // handled below; fall through to root handling
      } else if (known && !known.includes(name) && name !== '__typename') {
        this.errors.push({ message: `Cannot query field "${name}" on type "${typeName}".` });
        return undefined;
      }
      switch (typeName) {
        case 'User': {
          if (name === 'login') return n.login;
          if (name === 'id') return `U_${b64url(String(n.login ?? ''))}`;
          if (name === 'name') return n.login;
          if (name === 'email') return `${String(n.login ?? '')}@example.invalid`;
          if (name === 'url') return `https://example.invalid/${String(n.login ?? '')}`;
          return null;
        }
        case 'Repository': {
          const repo = n.repo as Repo;
          if (name === 'id') return repoGlobalId(repo);
          if (name === 'databaseId') return repo.id;
          if (name === 'name') return repo.name;
          if (name === 'nameWithOwner') return `${repo.owner}/${repo.name}`;
          if (name === 'owner') return this.executeSelection({ __gql: 'User', login: repo.owner }, sel, vars);
          if (name === 'defaultBranchRef') {
            const tip = headOid(repo);
            if (tip === undefined) return null;
            return this.executeSelection({ __gql: 'Ref', name: repo.defaultBranch, oid: tip }, sel, vars);
          }
          if (name === 'viewerPermission') return 'ADMIN';
          if (name === 'hasIssuesEnabled') return true;
          if (name === 'url') return `https://example.invalid/${repo.owner}/${repo.name}`;
          if (name === 'description') return repo.description;
          if (name === 'createdAt') return nextTs();
          if (name === 'issue') {
            const issue = repo.issues.get(Number(args.number));
            return issue ? this.executeSelection(this.issueNode(repo, issue), sel, vars) : null;
          }
          if (name === 'issues') return this.executeSelection(this.issueConnection(repo, args), sel, vars);
          if (name === 'pullRequest') {
            const pull = repo.pulls.get(Number(args.number));
            return pull ? this.executeSelection(this.pullNode(repo, pull), sel, vars) : null;
          }
          if (name === 'pullRequests') return this.executeSelection(this.pullConnection(repo, args), sel, vars);
          return null;
        }
        case 'Ref': {
          if (name === 'name') return n.name;
          if (name === 'target') return { oid: n.oid };
          return null;
        }
        case 'Issue': {
          const repo = n.repo as Repo;
          const issue = n.issue as Issue;
          if (name === 'id') return issueGlobalId(repo, issue);
          if (name === 'number') return issue.number;
          if (name === 'title') return issue.title;
          if (name === 'body') return issue.body;
          if (name === 'state') return issue.state === 'open' ? 'OPEN' : 'CLOSED';
          if (name === 'url') return `https://example.invalid/${repo.owner}/${repo.name}/issues/${issue.number}`;
          if (name === 'createdAt') return issue.createdAt;
          if (name === 'updatedAt') return issue.updatedAt;
          if (name === 'author') return this.executeSelection({ __gql: 'User', login: repo.owner }, sel, vars);
          if (name === 'repository') return this.executeSelection(this.repoNode(repo), sel, vars);
          if (name === 'labels') {
            return this.executeSelection({ __gql: 'LabelConnection', labels: issue.labels }, sel, vars);
          }
          if (name === 'comments') {
            const comments = repo.comments.get(issue.number) ?? [];
            return this.executeSelection({ __gql: 'CommentConnection', repo, comments }, sel, vars);
          }
          return null;
        }
        case 'LabelConnection': {
          if (name === 'nodes') return (n.labels as Label[]).map((l) => this.executeSelection({ __gql: 'Label', label: l }, sel, vars));
          if (name === 'totalCount') return (n.labels as Label[]).length;
          return null;
        }
        case 'Label': {
          const l = n.label as Label;
          if (name === 'name') return l.name;
          if (name === 'color') return l.color;
          if (name === 'id') return `L_${b64url(String(l.id))}`;
          return null;
        }
        case 'CommentConnection': {
          if (name === 'nodes') {
            return (n.comments as Comment[]).map((c) => this.executeSelection({ __gql: 'Comment', repo: n.repo as Repo, comment: c }, sel, vars));
          }
          if (name === 'totalCount') return (n.comments as Comment[]).length;
          return null;
        }
        case 'Comment': {
          const c = n.comment as Comment;
          const repo = n.repo as Repo;
          if (name === 'id') return commentGlobalId(repo, c);
          if (name === 'body') return c.body;
          if (name === 'author') return this.executeSelection({ __gql: 'User', login: repo.owner }, sel, vars);
          return null;
        }
        case 'IssueConnection': {
          if (name === 'nodes') return (n.nodes as GqlNode[]).map((child) => this.executeSelection(child, sel, vars));
          if (name === 'totalCount') return n.totalCount;
          if (name === 'pageInfo') return this.executeSelection({ __gql: 'PageInfo', pageInfo: n.pageInfo }, sel, vars);
          return null;
        }
        case 'PullRequestConnection': {
          if (name === 'nodes') return (n.nodes as GqlNode[]).map((child) => this.executeSelection(child, sel, vars));
          if (name === 'totalCount') return n.totalCount;
          if (name === 'pageInfo') return this.executeSelection({ __gql: 'PageInfo', pageInfo: n.pageInfo }, sel, vars);
          return null;
        }
        case 'PageInfo': {
          const pi = n.pageInfo as Record<string, unknown>;
          if (name === 'hasNextPage') return pi.hasNextPage ?? false;
          if (name === 'hasPreviousPage') return pi.hasPreviousPage ?? false;
          if (name === 'endCursor') return pi.endCursor ?? null;
          if (name === 'startCursor') return pi.startCursor ?? null;
          return null;
        }
        case 'PullRequest': {
          const repo = n.repo as Repo;
          const pull = n.pull as Pull;
          if (name === 'id') return pullGlobalId(repo, pull);
          if (name === 'number') return pull.number;
          if (name === 'title') return pull.title;
          if (name === 'body') return pull.body;
          if (name === 'state') return pull.merged ? 'MERGED' : pull.state === 'open' ? 'OPEN' : 'CLOSED';
          if (name === 'merged') return pull.merged;
          if (name === 'mergeable') return pullConflict(repo, pull) ? 'CONFLICTING' : 'MERGEABLE';
          if (name === 'headRefName') return pull.headRef;
          if (name === 'baseRefName') return pull.baseRef;
          if (name === 'headRef') return this.executeSelection({ __gql: 'Ref', name: pull.headRef, oid: pull.headSha }, sel, vars);
          if (name === 'baseRef') return this.executeSelection({ __gql: 'Ref', name: pull.baseRef, oid: pull.baseSha }, sel, vars);
          if (name === 'url') return `https://example.invalid/${repo.owner}/${repo.name}/pull/${pull.number}`;
          if (name === 'createdAt') return pull.createdAt;
          if (name === 'updatedAt') return pull.createdAt;
          if (name === 'author') return this.executeSelection({ __gql: 'User', login: repo.owner }, sel, vars);
          if (name === 'mergeCommit') return pull.mergeCommitSha ? { oid: pull.mergeCommitSha } : null;
          if (name === 'files') {
            const files = pullFiles(repo, pull);
            const first = typeof args.first === 'number' ? args.first : 100;
            const nodesItem = sel.find((s) => s.kind === 'field' && s.name === 'nodes');
            const nodes = files.slice(0, first).map((f) => this.executeSelection({ __gql: 'PullFile', file: f }, nodesItem?.sel ?? [], vars));
            return { nodes, totalCount: files.length };
          }
          return null;
        }
        case 'PullFile': {
          const f = n.file as Record<string, unknown>;
          if (name === 'path') return f.filename;
          if (name === 'filename') return f.filename;
          if (name === 'additions') return f.additions;
          if (name === 'deletions') return f.deletions;
          if (name === 'changeType') return (f.status as string) === 'added' ? 'ADDED' : (f.status as string) === 'removed' ? 'DELETED' : 'MODIFIED';
          return null;
        }
        case 'Type': {
          const t = n.typeName as string;
          if (name === 'name') return t;
          if (name === 'fields') {
            const fields = SCHEMA_FIELDS[t] ?? [];
            return fields.map((f) => ({ name: f }));
          }
          if (name === 'enumValues') {
            if (t === 'SearchType') return SEARCH_ENUMS.map((e) => ({ name: e }));
            return [];
          }
          return null;
        }
        default:
          return null;
      }
    }
    return null;
  }

  executeRoot(op: GqlOp, vars: Record<string, unknown>): Record<string, unknown> {
    this.errors = [];
    const root: GqlNode = { __gql: op.type === 'mutation' ? 'Mutation' : 'Query' };
    if (op.type === 'query') {
      const out: Record<string, unknown> = {};
      for (const item of op.sel) {
        if (item.kind !== 'field') { Object.assign(out, this.executeSelection(root, [item], vars)); continue; }
        const key = item.alias ?? (item.name as string);
        const args: Record<string, unknown> = {};
        if (item.args) for (const [k, v] of item.args) args[k] = resolveValue(v, vars);
        if (item.name === 'viewer') {
          out[key] = this.executeSelection({ __gql: 'User', login: this.login }, item.sel ?? [], vars);
        } else if (item.name === 'repository') {
          const repo = lookupRepo(this.login, String(args.owner ?? ''), String(args.name ?? ''));
          out[key] = repo ? this.executeSelection(this.repoNode(repo), item.sel ?? [], vars) : null;
        } else if (item.name === 'node') {
          const decoded = decodeGlobalId(String(args.id ?? ''));
          if (!decoded) { out[key] = null; continue; }
          if (decoded.kind === 'R') out[key] = this.executeSelection(this.repoNode(decoded.repo), item.sel ?? [], vars);
          else if (decoded.kind === 'I') {
            const issue = decoded.repo.issues.get(decoded.number);
            out[key] = issue ? this.executeSelection(this.issueNode(decoded.repo, issue), item.sel ?? [], vars) : null;
          } else if (decoded.kind === 'PR') {
            const pull = decoded.repo.pulls.get(decoded.number);
            out[key] = pull ? this.executeSelection(this.pullNode(decoded.repo, pull), item.sel ?? [], vars) : null;
          } else out[key] = null;
        } else if (item.name === '__type') {
          const typeName = String(args.name ?? '');
          const known = SCHEMA_FIELDS[typeName] !== undefined || typeName === 'SearchType';
          out[key] = known ? this.executeSelection({ __gql: 'Type', typeName }, item.sel ?? [], vars) : null;
        } else if (item.name === '__schema') {
          out[key] = { types: Object.keys(SCHEMA_FIELDS).map((t) => ({ name: t })) };
        } else {
          this.errors.push({ message: `Cannot query field "${item.name}" on type "Query".` });
        }
      }
      return out;
    }
    // mutations
    const out: Record<string, unknown> = {};
    for (const item of op.sel) {
      if (item.kind !== 'field') continue;
      const key = item.alias ?? (item.name as string);
      const args: Record<string, unknown> = {};
      if (item.args) for (const [k, v] of item.args) args[k] = resolveValue(v, vars);
      const input = (args.input ?? {}) as Record<string, unknown>;
      if (item.name === 'createIssue') {
        const decoded = decodeGlobalId(String(input.repositoryId ?? ''));
        if (!decoded) { this.errors.push({ message: 'createIssue: unknown repository id' }); out[key] = null; continue; }
        const issue = this.createIssueInternal(decoded.repo, String(input.title ?? ''), String(input.body ?? ''));
        out[key] = this.executeSelection({ __gql: 'CreateIssuePayload', repo: decoded.repo, issue }, item.sel ?? [], vars);
      } else if (item.name === 'closeIssue') {
        const decoded = decodeGlobalId(String(input.issueId ?? ''));
        if (!decoded || decoded.kind !== 'I') { this.errors.push({ message: 'closeIssue: unknown issue id' }); out[key] = null; continue; }
        const issue = decoded.repo.issues.get(decoded.number);
        if (!issue) { out[key] = null; continue; }
        issue.state = 'closed';
        issue.updatedAt = nextTs();
        out[key] = this.executeSelection({ __gql: 'CloseIssuePayload', repo: decoded.repo, issue }, item.sel ?? [], vars);
      } else if (item.name === 'createPullRequest') {
        const decoded = decodeGlobalId(String(input.repositoryId ?? ''));
        if (!decoded) { this.errors.push({ message: 'createPullRequest: unknown repository id' }); out[key] = null; continue; }
        const pull = this.createPullInternal(decoded.repo, String(input.title ?? ''), String(input.body ?? ''), String(input.headRefName ?? ''), String(input.baseRefName ?? ''));
        if (!pull) { this.errors.push({ message: 'createPullRequest: head or base branch does not exist, or a pull request already exists' }); out[key] = null; continue; }
        out[key] = this.executeSelection({ __gql: 'CreatePullPayload', repo: decoded.repo, pull }, item.sel ?? [], vars);
      } else if (item.name === 'mergePullRequest') {
        const decoded = decodeGlobalId(String(input.pullRequestId ?? ''));
        if (!decoded || decoded.kind !== 'PR') { this.errors.push({ message: 'mergePullRequest: unknown pull request id' }); out[key] = null; continue; }
        const pull = decoded.repo.pulls.get(decoded.number);
        if (!pull) { out[key] = null; continue; }
        this.mergePullInternal(decoded.repo, pull);
        out[key] = this.executeSelection({ __gql: 'MergePullPayload', repo: decoded.repo, pull }, item.sel ?? [], vars);
      } else if (item.name === 'addComment') {
        const decoded = decodeGlobalId(String(input.subjectId ?? ''));
        if (!decoded || decoded.kind !== 'I') { this.errors.push({ message: 'addComment: unknown subject id' }); out[key] = null; continue; }
        const comment: Comment = { id: decoded.repo.nextCommentId++, body: String(input.body ?? ''), createdAt: nextTs() };
        const list = decoded.repo.comments.get(decoded.number) ?? [];
        list.push(comment);
        decoded.repo.comments.set(decoded.number, list);
        out[key] = this.executeSelection({ __gql: 'AddCommentPayload', repo: decoded.repo, comment }, item.sel ?? [], vars);
      } else {
        this.errors.push({ message: `Cannot query field "${item.name}" on type "Mutation".` });
      }
    }
    return out;
  }

  /** Payload wrappers (issue / pullRequest / commentEdge selections). */
  executePayload(node: GqlNode, sel: GqlSel[], vars: Record<string, unknown>): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    for (const item of sel) {
      if (item.kind !== 'field') continue;
      const key = item.alias ?? (item.name as string);
      if (node.__gql === 'CreateIssuePayload' || node.__gql === 'CloseIssuePayload') {
        if (item.name === 'issue') out[key] = this.executeSelection(this.issueNode(node.repo as Repo, node.issue as Issue), item.sel ?? [], vars);
        else if (item.name === 'clientMutationId') out[key] = null;
      } else if (node.__gql === 'CreatePullPayload' || node.__gql === 'MergePullPayload') {
        if (item.name === 'pullRequest') out[key] = this.executeSelection(this.pullNode(node.repo as Repo, node.pull as Pull), item.sel ?? [], vars);
        else if (item.name === 'clientMutationId') out[key] = null;
      } else if (node.__gql === 'AddCommentPayload') {
        if (item.name === 'commentEdge') {
          out[key] = this.executeSelection({ __gql: 'CommentEdge', repo: node.repo as Repo, comment: node.comment as Comment }, item.sel ?? [], vars);
        } else if (item.name === 'clientMutationId') out[key] = null;
      }
    }
    return out;
  }
}

// The payload nodes above are resolved through executeSelection only when
// their __gql is in SCHEMA_FIELDS; intercept them in executeSelection by
// routing payload types here (kept separate to stay readable).
const PAYLOAD_TYPES = new Set(['CreateIssuePayload', 'CloseIssuePayload', 'CreatePullPayload', 'MergePullPayload', 'AddCommentPayload', 'CommentEdge']);

async function handleGraphQL(req: IncomingMessage, res: ServerResponse, login: string): Promise<void> {
  const bodyBuf = await readBody(req);
  const parsed = parseJsonBody(bodyBuf);
  if (!parsed.ok) { errJson(res, 400, 'Invalid JSON body'); return; }
  const runOne = (doc: unknown): Record<string, unknown> => {
    if (typeof doc !== 'object' || doc === null) return { data: null, errors: [{ message: 'Invalid GraphQL request' }] };
    const d = doc as Record<string, unknown>;
    const query = typeof d.query === 'string' ? d.query : '';
    const variables = (d.variables ?? {}) as Record<string, unknown>;
    if (query.trim() === '') return { data: null, errors: [{ message: 'Empty query' }] };
    try {
      const parser = new GqlParser(tokenizeGql(query));
      const { ops, frags } = parser.parseDocument();
      if (ops.length === 0) return { data: null, errors: [{ message: 'No operation found' }] };
      const op = ops[0] as GqlOp;
      const exec = new GraphQLExecutor(login, frags);
      // payload selections need the executor's payload routing: patch the
      // executor's selection runner for payload wrapper nodes.
      const orig = exec.executeSelection.bind(exec);
      (exec as unknown as Record<string, unknown>).executeSelection = (node: unknown, sel: GqlSel[], vars: Record<string, unknown>): Record<string, unknown> => {
        if (typeof node === 'object' && node !== null && PAYLOAD_TYPES.has(String((node as Record<string, unknown>).__gql ?? ''))) {
          if ((node as Record<string, unknown>).__gql === 'CommentEdge') {
            const out: Record<string, unknown> = {};
            for (const item of sel) {
              if (item.kind !== 'field') continue;
              const key = item.alias ?? (item.name as string);
              if (item.name === 'node') {
                const c = (node as Record<string, unknown>).comment as Comment;
                const repo = (node as Record<string, unknown>).repo as Repo;
                out[key] = orig({ __gql: 'Comment', repo, comment: c }, item.sel ?? [], vars);
              }
            }
            return out;
          }
          return exec.executePayload(node as GqlNode, sel, vars);
        }
        return orig(node, sel, vars);
      };
      const data = exec.executeRoot(op, variables);
      const errors = (exec as unknown as { errors: Array<{ message: string }> }).errors;
      return errors.length > 0 ? { data, errors } : { data };
    } catch (e) {
      return { data: null, errors: [{ message: e instanceof Error ? e.message : String(e) }] };
    }
  };
  if (Array.isArray(parsed.value)) {
    jsonBody(res, 200, (parsed.value as unknown[]).map(runOne));
  } else {
    jsonBody(res, 200, runOne(parsed.value));
  }
}

// ---------------------------------------------------------------------------
// MCP (JSON-RPC 2.0 Streamable HTTP)
// ---------------------------------------------------------------------------

const MCP_TOOLS: Array<{ name: string; description: string; required: string[]; properties: Record<string, { type: string; description: string }> }> = [
  {
    name: 'create_repo',
    description: 'Create a new repository owned by the authenticated user.',
    required: ['name'],
    properties: {
      name: { type: 'string', description: 'Name of the repository to create.' },
      description: { type: 'string', description: 'Short description of the repository.' },
      private: { type: 'boolean', description: 'Whether the repository is private.' },
    },
  },
  {
    name: 'get_repo',
    description: 'Get a repository by owner and name.',
    required: ['owner', 'repo'],
    properties: {
      owner: { type: 'string', description: 'Owner login of the repository.' },
      repo: { type: 'string', description: 'Name of the repository.' },
    },
  },
  {
    name: 'create_issue',
    description: 'Create an issue in a repository.',
    required: ['owner', 'repo', 'title'],
    properties: {
      owner: { type: 'string', description: 'Owner login of the repository.' },
      repo: { type: 'string', description: 'Name of the repository.' },
      title: { type: 'string', description: 'Title of the issue.' },
      body: { type: 'string', description: 'Body of the issue.' },
    },
  },
  {
    name: 'list_issues',
    description: 'List issues in a repository.',
    required: ['owner', 'repo'],
    properties: {
      owner: { type: 'string', description: 'Owner login of the repository.' },
      repo: { type: 'string', description: 'Name of the repository.' },
      state: { type: 'string', description: 'Issue state filter: open, closed, or all.' },
    },
  },
  {
    name: 'create_pull_request',
    description: 'Create a pull request in a repository.',
    required: ['owner', 'repo', 'title', 'head', 'base'],
    properties: {
      owner: { type: 'string', description: 'Owner login of the repository.' },
      repo: { type: 'string', description: 'Name of the repository.' },
      title: { type: 'string', description: 'Title of the pull request.' },
      head: { type: 'string', description: 'Head branch name.' },
      base: { type: 'string', description: 'Base branch name.' },
    },
  },
  {
    name: 'merge_pull_request',
    description: 'Merge a pull request in a repository.',
    required: ['owner', 'repo', 'pull_number'],
    properties: {
      owner: { type: 'string', description: 'Owner login of the repository.' },
      repo: { type: 'string', description: 'Name of the repository.' },
      pull_number: { type: 'integer', description: 'Number of the pull request.' },
    },
  },
];

function mcpToolList(): Record<string, unknown>[] {
  return MCP_TOOLS.map((t) => ({
    name: t.name,
    description: t.description,
    inputSchema: {
      type: 'object',
      properties: t.properties,
      required: t.required,
      additionalProperties: false,
    },
  }));
}

function mcpResult(id: unknown, result: Record<string, unknown>): Record<string, unknown> {
  return { jsonrpc: '2.0', id: id ?? null, result };
}
function mcpError(id: unknown, code: number, message: string): Record<string, unknown> {
  return { jsonrpc: '2.0', id: id ?? null, error: { code, message } };
}

async function handleMcp(req: IncomingMessage, res: ServerResponse, login: string): Promise<void> {
  const raw = (await readBody(req)).toString('utf8');
  let msg: unknown;
  try {
    msg = JSON.parse(raw);
  } catch {
    jsonBody(res, 400, { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } });
    return;
  }
  if (typeof msg !== 'object' || msg === null) {
    jsonBody(res, 400, { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } });
    return;
  }
  const m = msg as Record<string, unknown>;
  const id = m.id ?? null;
  const method = typeof m.method === 'string' ? m.method : '';

  // Notifications (no id) are acknowledged with 202 and no body.
  if (method.startsWith('notifications/')) {
    res.writeHead(202);
    res.end();
    return;
  }
  if (method === 'ping') { jsonBody(res, 200, mcpResult(id, {})); return; }
  if (method === 'server/discover') {
    jsonBody(res, 200, mcpResult(id, {
      supportedVersions: ['2026-07-28', '2025-11-25'],
      serverInfo: { name: APP_NAME, version: APP_VERSION },
      capabilities: { tools: {} },
    }));
    return;
  }
  if (method === 'initialize') {
    const params = (m.params ?? {}) as Record<string, unknown>;
    const version = typeof params.protocolVersion === 'string' ? params.protocolVersion : '2026-07-28';
    res.setHeader('Mcp-Session-Id', `sess-${++reqCounter}`);
    jsonBody(res, 200, mcpResult(id, {
      protocolVersion: version,
      capabilities: { tools: {} },
      serverInfo: { name: APP_NAME, version: APP_VERSION },
    }));
    return;
  }
  if (method === 'tools/list') {
    jsonBody(res, 200, mcpResult(id, { tools: mcpToolList() }));
    return;
  }
  if (method === 'tools/call') {
    const params = (m.params ?? {}) as Record<string, unknown>;
    const toolName = String(params.name ?? '');
    const args = (params.arguments ?? {}) as Record<string, unknown>;
    const tool = MCP_TOOLS.find((t) => t.name === toolName);
    if (!tool) { jsonBody(res, 200, mcpError(id, -32601, `Unknown tool: ${toolName}`)); return; }
    const missing = tool.required.filter((r) => args[r] === undefined || args[r] === null || args[r] === '');
    if (missing.length > 0) {
      jsonBody(res, 200, mcpResult(id, {
        content: [{ type: 'text', text: JSON.stringify({ error: `Missing required argument: ${missing[0]}` }) }],
        structuredContent: { error: `Missing required argument: ${missing[0]}` },
        isError: true,
      }));
      return;
    }
    try {
      const owner = String(args.owner ?? login);
      const repoName = String(args.repo ?? args.name ?? '');
      let payload: Record<string, unknown>;
      if (toolName === 'create_repo') {
        const name = String(args.name ?? '');
        const description = typeof args.description === 'string' ? args.description : '';
        if (!name) throw new Error('invalid repository name');
        if (repos.has(repoKey(login, name))) throw new Error('Repository already exists');
        const repo = createRepoInternal(login, name, description, args.private === true);
        payload = repoJson(repo);
      } else if (toolName === 'get_repo') {
        const repo = lookupRepo(login, owner, repoName);
        if (!repo) throw new Error(`Repository not found: ${owner}/${repoName}`);
        payload = repoJson(repo);
      } else if (toolName === 'create_issue') {
        const repo = lookupRepo(login, owner, repoName);
        if (!repo) throw new Error(`Repository not found: ${owner}/${repoName}`);
        const exec = new GraphQLExecutor(login, new Map());
        const issue = (exec as unknown as { createIssueInternal: (r: Repo, t: string, b: string) => Issue }).createIssueInternal(repo, String(args.title ?? ''), String(args.body ?? ''));
        payload = issueJson(repo, issue);
      } else if (toolName === 'list_issues') {
        const repo = lookupRepo(login, owner, repoName);
        if (!repo) throw new Error(`Repository not found: ${owner}/${repoName}`);
        const state = typeof args.state === 'string' ? args.state : 'open';
        let list = [...repo.issues.values()].sort((a, b) => b.number - a.number);
        if (state !== 'all') list = list.filter((i) => i.state === state);
        payload = { issues: list.map((i) => issueJson(repo, i)) };
      } else if (toolName === 'create_pull_request') {
        const repo = lookupRepo(login, owner, repoName);
        if (!repo) throw new Error(`Repository not found: ${owner}/${repoName}`);
        const exec = new GraphQLExecutor(login, new Map());
        const pull = (exec as unknown as { createPullInternal: (r: Repo, t: string, b: string, h: string, ba: string) => Pull | null }).createPullInternal(repo, String(args.title ?? ''), String(args.body ?? ''), String(args.head ?? ''), String(args.base ?? ''));
        if (!pull) throw new Error('Pull request could not be created (unknown branch or duplicate)');
        payload = pullJson(repo, pull);
      } else if (toolName === 'merge_pull_request') {
        const repo = lookupRepo(login, owner, repoName);
        if (!repo) throw new Error(`Repository not found: ${owner}/${repoName}`);
        const pull = repo.pulls.get(Number(args.pull_number));
        if (!pull) throw new Error(`Pull request not found: ${args.pull_number}`);
        const exec = new GraphQLExecutor(login, new Map());
        const ok = (exec as unknown as { mergePullInternal: (r: Repo, p: Pull) => boolean }).mergePullInternal(repo, pull);
        if (!ok) throw new Error('Pull request could not be merged (conflict or already closed)');
        payload = pullJson(repo, pull);
      } else {
        throw new Error(`Unknown tool: ${toolName}`);
      }
      const text = JSON.stringify(payload);
      jsonBody(res, 200, mcpResult(id, {
        content: [{ type: 'text', text }],
        structuredContent: payload,
      }));
    } catch (e) {
      jsonBody(res, 200, mcpResult(id, {
        content: [{ type: 'text', text: JSON.stringify({ error: e instanceof Error ? e.message : String(e) }) }],
        structuredContent: { error: e instanceof Error ? e.message : String(e) },
        isError: true,
      }));
    }
    return;
  }
  jsonBody(res, 200, mcpError(id, -32601, `Method not found: ${method}`));
}

// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------

export function createApp(): Server {
  return createServer(async (req, res) => {
    try {
      const url = urlOf(req);
      const path = url.pathname;
      if (req.method === 'GET' && path === '/healthz') {
        jsonBody(res, 200, { ok: true });
        return;
      }
      if (path === '/api/graphql' && req.method === 'POST') {
        const auth = authed(req);
        if (!auth.ok) { errJson(res, 401, 'Requires authentication'); return; }
        await handleGraphQL(req, res, auth.login);
        return;
      }
      if (path === '/mcp' && req.method === 'POST') {
        const auth = authed(req);
        if (!auth.ok) { errJson(res, 401, 'Requires authentication'); return; }
        await handleMcp(req, res, auth.login);
        return;
      }
      if (path.startsWith('/api/v3')) {
        const auth = authed(req);
        if (!auth.ok) { errJson(res, 401, 'Requires authentication'); return; }
        await handleRest(req, res, auth.login);
        return;
      }
      if (path.includes('.git/')) {
        await handleGit(req, res);
        return;
      }
      errJson(res, 404, 'Not Found');
    } catch (e) {
      // Never crash the process on a bad request.
      console.error('[kece-forge] request error:', e instanceof Error ? e.stack ?? e.message : String(e));
      try { errJson(res, 500, 'Internal Server Error'); } catch { /* already sent */ }
      void e;
    }
  });
}
