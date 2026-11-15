// Git smart HTTP, implemented in-process on node:zlib and node:crypto (the trial pod has no
// git binary): pkt-line framing, ref advertisement, packfile build and parse with delta
// resolution, upload-pack (v0 and protocol v2: ls-refs + fetch commands) and receive-pack
// (v0) with report-status.

import { createHash } from 'node:crypto';
import { deflateSync, inflateSync } from 'node:zlib';
import { objectId, type GitObject, type GitObjectType, type Repo } from './store.ts';

export const ZERO_SHA = '0'.repeat(40);

const TYPE_NUM: Record<GitObjectType, number> = { commit: 1, tree: 2, blob: 3, tag: 4 };
const NUM_TYPE: Record<number, GitObjectType> = { 1: 'commit', 2: 'tree', 3: 'blob', 4: 'tag' };

// ---------------------------------------------------------------- pkt-lines

/** One pkt-line: 4 hex digits of total length, then the payload. */
export function pktLine(payload: Buffer | string): Buffer {
  const body = typeof payload === 'string' ? Buffer.from(payload, 'utf8') : payload;
  const length = body.length + 4;
  if (length > 0xffff) throw new Error(`pkt-line payload too large: ${body.length}`);
  return Buffer.concat([Buffer.from(length.toString(16).padStart(4, '0'), 'ascii'), body]);
}

export const PKT_FLUSH = Buffer.from('0000', 'ascii');

export interface PktRead {
  /** Payload of the line, or null for a flush packet. */
  payload: Buffer | null;
  /** Offset just past this line. */
  next: number;
}

/** Read one pkt-line starting at `offset`; null when fewer than 4 bytes remain. */
export function readPkt(buf: Buffer, offset: number): PktRead | null {
  if (offset + 4 > buf.length) return null;
  const length = Number.parseInt(buf.toString('ascii', offset, offset + 4), 16);
  if (Number.isNaN(length) || length < 4) {
    if (length === 0) return { payload: null, next: offset + 4 };
    throw new Error(`invalid pkt-line length at ${offset}`);
  }
  if (offset + length > buf.length) throw new Error('pkt-line overruns the body');
  return { payload: buf.subarray(offset + 4, offset + length), next: offset + length };
}

// ---------------------------------------------------------------- object graph

export interface CommitInfo {
  tree: string;
  parents: string[];
}

export function parseCommit(data: Buffer): CommitInfo {
  const text = data.toString('utf8');
  const headerEnd = text.indexOf('\n\n');
  const header = headerEnd >= 0 ? text.slice(0, headerEnd) : text;
  let tree = '';
  const parents: string[] = [];
  for (const line of header.split('\n')) {
    if (line.startsWith('tree ')) tree = line.slice(5).trim();
    else if (line.startsWith('parent ')) parents.push(line.slice(7).trim());
  }
  return { tree, parents };
}

export interface TagInfo {
  /** The object the tag points at (usually a commit). */
  object: string;
  /** The type of that object, as written in the tag header. */
  type: string;
}

export function parseTag(data: Buffer): TagInfo {
  const text = data.toString('utf8');
  const headerEnd = text.indexOf('\n\n');
  const header = headerEnd >= 0 ? text.slice(0, headerEnd) : text;
  let object = '';
  let type = '';
  for (const line of header.split('\n')) {
    if (line.startsWith('object ')) object = line.slice(7).trim();
    else if (line.startsWith('type ')) type = line.slice(5).trim();
  }
  return { object, type };
}

/** Follow a chain of tag objects to the non-tag object it ultimately names. */
export function peelTarget(repo: Repo, sha: string): string {
  let current = sha;
  for (let hops = 0; hops < 32; hops += 1) {
    const obj = repo.objects.get(current);
    if (obj === undefined || obj.type !== 'tag') return current;
    current = parseTag(obj.data).object;
  }
  return current;
}

/** Every tree/blob sha under a tree object, recursively (the tree itself first). */
function collectTree(repo: Repo, treeSha: string, into: Set<string>): void {
  if (into.has(treeSha)) return;
  const obj = repo.objects.get(treeSha);
  if (obj === undefined || obj.type !== 'tree') return;
  into.add(treeSha);
  const data = obj.data;
  let pos = 0;
  while (pos < data.length) {
    const space = data.indexOf(0x20, pos);
    const nul = data.indexOf(0x00, space);
    const sha = data.toString('hex', nul + 1, nul + 21);
    const child = repo.objects.get(sha);
    if (child !== undefined && child.type === 'tree') collectTree(repo, sha, into);
    else if (child !== undefined) into.add(sha);
    pos = nul + 21;
  }
}

export interface Closure {
  /** Object shas to pack, in deterministic walk order. */
  objects: string[];
  /** Commits at the depth boundary whose parents are excluded (empty without a depth). */
  shallow: string[];
}

/**
 * The object closure of `tips`: the commits reachable within `depth` generations (all of
 * them when depth is undefined) plus every tree and blob those commits reach.
 */
export function collectClosure(repo: Repo, tips: readonly string[], depth?: number): Closure {
  const generation = new Map<string, number>();
  const queue: string[] = [];
  /** Tag objects named by the tips (and any non-commit target), packed alongside the walk. */
  const extras = new Set<string>();
  for (const tip of tips) {
    // A tip may name a tag object: the tag itself is part of the closure, and the walk
    // continues from the object it names, at the same generation.
    let current = tip;
    let obj = repo.objects.get(current);
    while (obj !== undefined && obj.type === 'tag') {
      extras.add(current);
      current = parseTag(obj.data).object;
      obj = repo.objects.get(current);
    }
    if (obj !== undefined && obj.type === 'commit' && !generation.has(current)) {
      generation.set(current, 0);
      queue.push(current);
    } else if (obj !== undefined && obj.type === 'tree') {
      collectTree(repo, current, extras);
    } else if (obj !== undefined) {
      extras.add(current);
    }
  }
  const shallow = new Set<string>();
  for (let head = 0; head < queue.length; head += 1) {
    const sha = queue[head] as string;
    const gen = generation.get(sha) as number;
    const obj = repo.objects.get(sha) as GitObject;
    const { parents } = parseCommit(obj.data);
    if (depth !== undefined && gen + 1 >= depth) {
      if (parents.length > 0) shallow.add(sha);
      continue;
    }
    for (const parent of parents) {
      if (!generation.has(parent)) {
        const parentObj = repo.objects.get(parent);
        if (parentObj !== undefined && parentObj.type === 'commit') {
          generation.set(parent, gen + 1);
          queue.push(parent);
        }
      }
    }
  }
  const objects = new Set<string>();
  for (const sha of queue) {
    objects.add(sha);
    const obj = repo.objects.get(sha) as GitObject;
    collectTree(repo, parseCommit(obj.data).tree, objects);
  }
  for (const sha of extras) objects.add(sha);
  return { objects: [...objects], shallow: [...shallow].sort() };
}

/**
 * The objects a fetching client already holds, given its `have` lines and the shallow
 * boundary it declared. A have the client holds in full excludes its whole closure; a have
 * on the client's shallow boundary excludes only the commit itself and its tree — the
 * client does not hold that commit's parents, so they stay sendable (the deepen case).
 */
export function collectHeld(repo: Repo, haves: readonly string[], clientShallow: ReadonlySet<string>): Set<string> {
  const held = new Set<string>();
  for (const have of haves) {
    let current = have;
    let obj = repo.objects.get(current);
    while (obj !== undefined && obj.type === 'tag') {
      held.add(current);
      current = parseTag(obj.data).object;
      obj = repo.objects.get(current);
    }
    if (obj === undefined || obj.type !== 'commit') continue;
    if (clientShallow.has(current)) {
      held.add(current);
      collectTree(repo, parseCommit(obj.data).tree, held);
    } else {
      for (const sha of collectClosure(repo, [current]).objects) held.add(sha);
    }
  }
  return held;
}

/**
 * The nearest common ancestor of two commits: the first commit met walking back from `b`
 * (breadth-first, parents in stored order) that is also an ancestor of `a`. Null when the
 * histories share nothing. Deterministic in the store's objects, so merges and file diffs
 * agree between a live trial and its replay.
 */
export function mergeBase(repo: Repo, a: string, b: string): string | null {
  const ancestorsOfA = new Set<string>();
  const queueA = [a];
  while (queueA.length > 0) {
    const sha = queueA.shift() as string;
    if (ancestorsOfA.has(sha)) continue;
    const obj = repo.objects.get(sha);
    if (obj === undefined || obj.type !== 'commit') continue;
    ancestorsOfA.add(sha);
    queueA.push(...parseCommit(obj.data).parents);
  }
  const seen = new Set<string>();
  const queue = [b];
  while (queue.length > 0) {
    const sha = queue.shift() as string;
    if (seen.has(sha)) continue;
    seen.add(sha);
    if (ancestorsOfA.has(sha)) return sha;
    const obj = repo.objects.get(sha);
    if (obj !== undefined && obj.type === 'commit') queue.push(...parseCommit(obj.data).parents);
  }
  return null;
}

/** True when `ancestor` is `descendant` itself or reachable from it through parents. */
export function isAncestor(repo: Repo, ancestor: string, descendant: string): boolean {
  const seen = new Set<string>();
  const stack = [descendant];
  while (stack.length > 0) {
    const sha = stack.pop() as string;
    if (sha === ancestor) return true;
    if (seen.has(sha)) continue;
    seen.add(sha);
    const obj = repo.objects.get(sha);
    if (obj !== undefined && obj.type === 'commit') stack.push(...parseCommit(obj.data).parents);
  }
  return false;
}

// ---------------------------------------------------------------- tree/commit authoring
// The contents API writes real commits into the store, so the forge needs the write side of
// the object model too: flatten a tree to a path map, rebuild nested trees from a path map,
// and serialise a commit. Everything is a pure function of the store, so REST-created
// history is byte-identical between a live trial and its replay.

export interface TreeEntry {
  mode: string;
  name: string;
  sha: string;
}

/** The entries of one tree object, in stored order. */
export function parseTree(data: Buffer): TreeEntry[] {
  const entries: TreeEntry[] = [];
  let pos = 0;
  while (pos < data.length) {
    const space = data.indexOf(0x20, pos);
    const nul = data.indexOf(0x00, space);
    entries.push({
      mode: data.toString('ascii', pos, space),
      name: data.toString('utf8', space + 1, nul),
      sha: data.toString('hex', nul + 1, nul + 21),
    });
    pos = nul + 21;
  }
  return entries;
}

/** Every blob under a tree, as a map of slash-joined path -> blob sha. */
export function flattenTree(repo: Repo, treeSha: string): Map<string, string> {
  const out = new Map<string, string>();
  const walk = (sha: string, prefix: string): void => {
    const obj = repo.objects.get(sha);
    if (obj === undefined || obj.type !== 'tree') return;
    for (const entry of parseTree(obj.data)) {
      const child = repo.objects.get(entry.sha);
      if (child !== undefined && child.type === 'tree') walk(entry.sha, `${prefix}${entry.name}/`);
      else out.set(`${prefix}${entry.name}`, entry.sha);
    }
  };
  walk(treeSha, '');
  return out;
}

/** The sha of the subtree at `dirPath` under `rootTreeSha` ('' is the root), or null. */
export function subtreeAt(repo: Repo, rootTreeSha: string, dirPath: string): string | null {
  if (dirPath === '') return rootTreeSha;
  let current = rootTreeSha;
  for (const segment of dirPath.split('/')) {
    const obj = repo.objects.get(current);
    if (obj === undefined || obj.type !== 'tree') return null;
    const entry = parseTree(obj.data).find((candidate) => candidate.name === segment);
    if (entry === undefined) return null;
    current = entry.sha;
  }
  return current;
}

/**
 * Write nested trees holding exactly `files` (path -> blob sha) and return the root tree
 * sha. Entries are ordered the git way: by name, directories compared as name + '/'.
 */
export function writeTree(repo: Repo, files: ReadonlyMap<string, string>): string {
  const build = (entries: ReadonlyMap<string, string>): string => {
    const filesHere = new Map<string, string>();
    const dirs = new Map<string, Map<string, string>>();
    for (const [path, sha] of entries) {
      const slash = path.indexOf('/');
      if (slash < 0) {
        filesHere.set(path, sha);
      } else {
        const dir = path.slice(0, slash);
        let sub = dirs.get(dir);
        if (sub === undefined) {
          sub = new Map<string, string>();
          dirs.set(dir, sub);
        }
        sub.set(path.slice(slash + 1), sha);
      }
    }
    const items: { sortKey: string; mode: string; name: string; sha: string }[] = [];
    for (const [name, sha] of filesHere) items.push({ sortKey: name, mode: '100644', name, sha });
    for (const [name, sub] of dirs) items.push({ sortKey: `${name}/`, mode: '40000', name, sha: build(sub) });
    items.sort((a, b) => (a.sortKey < b.sortKey ? -1 : a.sortKey > b.sortKey ? 1 : 0));
    const parts: Buffer[] = [];
    for (const item of items) {
      parts.push(Buffer.from(`${item.mode} ${item.name}\0`, 'utf8'));
      parts.push(Buffer.from(item.sha, 'hex'));
    }
    return repo.writeObject('tree', Buffer.concat(parts));
  };
  return build(files);
}

/** Serialise and store one commit; `time` is a caller-supplied deterministic timestamp. */
export function createCommit(repo: Repo, tree: string, parents: readonly string[], message: string, time: number): string {
  const lines = [`tree ${tree}`];
  for (const parent of parents) lines.push(`parent ${parent}`);
  lines.push(`author Forge <forge@localhost> ${time} +0000`);
  lines.push(`committer Forge <forge@localhost> ${time} +0000`);
  return repo.writeObject('commit', Buffer.from(`${lines.join('\n')}\n\n${message}`, 'utf8'));
}

/** The message body of a commit object (everything after the blank line). */
export function commitMessage(data: Buffer): string {
  const text = data.toString('utf8');
  const split = text.indexOf('\n\n');
  return split >= 0 ? text.slice(split + 2) : '';
}

// ---------------------------------------------------------------- packfiles

function packEntryHeader(type: GitObjectType, size: number): Buffer {
  const bytes: number[] = [];
  let first = (TYPE_NUM[type] << 4) | (size & 0x0f);
  size >>= 4;
  if (size > 0) first |= 0x80;
  bytes.push(first);
  while (size > 0) {
    let byte = size & 0x7f;
    size >>= 7;
    if (size > 0) byte |= 0x80;
    bytes.push(byte);
  }
  return Buffer.from(bytes);
}

/** A complete packfile holding the given objects as full (undeltified) entries. */
export function buildPack(repo: Repo, shas: readonly string[]): Buffer {
  const parts: Buffer[] = [];
  const header = Buffer.alloc(12);
  header.write('PACK', 0, 'ascii');
  header.writeUInt32BE(2, 4);
  header.writeUInt32BE(shas.length, 8);
  parts.push(header);
  for (const sha of shas) {
    const obj = repo.objects.get(sha);
    if (obj === undefined) throw new Error(`pack requested an unknown object ${sha}`);
    parts.push(packEntryHeader(obj.type, obj.data.length));
    parts.push(deflateSync(obj.data));
  }
  const body = Buffer.concat(parts);
  const trailer = createHash('sha1').update(body).digest();
  return Buffer.concat([body, trailer]);
}

function readDeltaVarint(buf: Buffer, pos: number): { value: number; next: number } {
  let value = 0;
  let shift = 0;
  let at = pos;
  for (;;) {
    const byte = buf[at] as number;
    at += 1;
    value |= (byte & 0x7f) << shift;
    shift += 7;
    if ((byte & 0x80) === 0) break;
  }
  return { value, next: at };
}

/** Apply a git delta buffer to its base content. */
export function applyDelta(base: Buffer, delta: Buffer): Buffer {
  let pos = 0;
  const source = readDeltaVarint(delta, pos);
  pos = source.next;
  const target = readDeltaVarint(delta, pos);
  pos = target.next;
  const parts: Buffer[] = [];
  let written = 0;
  while (pos < delta.length) {
    const op = delta[pos] as number;
    pos += 1;
    if (op & 0x80) {
      let offset = 0;
      let size = 0;
      for (let i = 0; i < 4; i += 1) {
        if (op & (1 << i)) {
          offset |= (delta[pos] as number) << (8 * i);
          pos += 1;
        }
      }
      for (let i = 0; i < 3; i += 1) {
        if (op & (0x10 << i)) {
          size |= (delta[pos] as number) << (8 * i);
          pos += 1;
        }
      }
      if (size === 0) size = 0x10000;
      parts.push(base.subarray(offset, offset + size));
      written += size;
    } else if (op > 0) {
      parts.push(delta.subarray(pos, pos + op));
      written += op;
      pos += op;
    } else {
      throw new Error('delta opcode 0 is reserved');
    }
  }
  const out = Buffer.concat(parts);
  if (out.length !== target.value) throw new Error(`delta produced ${out.length} bytes, expected ${target.value}`);
  return out;
}

interface PackEntry {
  start: number;
  typeNum: number;
  /** Inflated content: the object itself, or a delta against the base. */
  data: Buffer;
  baseStart?: number;
  baseSha?: string;
}

/**
 * Parse the packfile that starts at `offset` in `buf` and store every object in the repo,
 * resolving ofs-delta and ref-delta entries against the pack itself and the store.
 */
export function parsePackInto(repo: Repo, buf: Buffer, offset: number): number {
  if (buf.toString('ascii', offset, offset + 4) !== 'PACK') throw new Error('not a packfile');
  const count = buf.readUInt32BE(offset + 8);
  let pos = offset + 12;
  const entries: PackEntry[] = [];
  const byStart = new Map<number, PackEntry>();
  for (let i = 0; i < count; i += 1) {
    const start = pos;
    let byte = buf[pos] as number;
    pos += 1;
    const typeNum = (byte >> 4) & 7;
    let shift = 4;
    while (byte & 0x80) {
      byte = buf[pos] as number;
      pos += 1;
      shift += 7;
    }
    void shift;
    const entry: PackEntry = { start, typeNum, data: Buffer.alloc(0) };
    if (typeNum === 6) {
      // ofs-delta: the base is `off` bytes before this entry's start.
      let b = buf[pos] as number;
      pos += 1;
      let off = b & 0x7f;
      while (b & 0x80) {
        b = buf[pos] as number;
        pos += 1;
        off = ((off + 1) << 7) | (b & 0x7f);
      }
      entry.baseStart = start - off;
    } else if (typeNum === 7) {
      entry.baseSha = buf.toString('hex', pos, pos + 20);
      pos += 20;
    }
    const inflated = inflateSync(buf.subarray(pos), { info: true }) as unknown as {
      buffer: Buffer;
      engine: { bytesWritten: number };
    };
    entry.data = inflated.buffer;
    pos += inflated.engine.bytesWritten;
    entries.push(entry);
    byStart.set(start, entry);
  }
  const trailer = buf.subarray(pos, pos + 20);
  const digest = createHash('sha1').update(buf.subarray(offset, pos)).digest();
  if (!trailer.equals(digest)) throw new Error('packfile checksum mismatch');

  const resolved = new Map<number, string>();
  const resolve = (entry: PackEntry): string => {
    const memo = resolved.get(entry.start);
    if (memo !== undefined) return memo;
    let sha: string;
    if (entry.typeNum >= 1 && entry.typeNum <= 4) {
      sha = repo.writeObject(NUM_TYPE[entry.typeNum] as GitObjectType, entry.data);
    } else if (entry.typeNum === 6 || entry.typeNum === 7) {
      let baseObj: GitObject | undefined;
      if (entry.typeNum === 6) {
        const baseEntry = byStart.get(entry.baseStart as number);
        if (baseEntry === undefined) throw new Error('ofs-delta base is not in the pack');
        baseObj = repo.objects.get(resolve(baseEntry));
      } else {
        baseObj = repo.objects.get(entry.baseSha as string);
        if (baseObj === undefined) {
          // The base may itself be an entry of this pack: resolve entries in order until it lands.
          for (const candidate of entries) {
            if (repo.objects.has(entry.baseSha as string)) break;
            resolve(candidate);
          }
          baseObj = repo.objects.get(entry.baseSha as string);
        }
      }
      if (baseObj === undefined) throw new Error('delta base is missing');
      sha = repo.writeObject(baseObj.type, applyDelta(baseObj.data, entry.data));
    } else {
      throw new Error(`unknown pack entry type ${entry.typeNum}`);
    }
    resolved.set(entry.start, sha);
    return sha;
  };
  for (const entry of entries) resolve(entry);
  return count;
}

// ---------------------------------------------------------------- serving caches
// Git objects are content-addressed and immutable, and a fetch response is a pure
// function of (wants, depth, haves, shallow boundary) over that immutable graph — so
// pack bytes and whole fetch responses can be cached per repository and reused
// byte-for-byte. Ref-dependent answers (advertisements, ls-refs) are keyed by a refs
// version that every ref mutation bumps. A cache hit returns exactly the bytes the
// uncached path would have built, so live/replay determinism is untouched.

/** A byte-bounded FIFO cache of immutable response/pack buffers. */
class ByteCache {
  private readonly entries = new Map<string, Buffer>();
  private bytes = 0;
  private readonly maxBytes: number;

  constructor(maxBytes: number) {
    this.maxBytes = maxBytes;
  }

  get(key: string): Buffer | undefined {
    return this.entries.get(key);
  }

  set(key: string, value: Buffer): void {
    if (value.length > this.maxBytes) return;
    const existing = this.entries.get(key);
    if (existing !== undefined) {
      this.bytes -= existing.length;
      this.entries.delete(key);
    }
    this.entries.set(key, value);
    this.bytes += value.length;
    while (this.bytes > this.maxBytes) {
      const oldest = this.entries.keys().next();
      if (oldest.done) break;
      const evicted = this.entries.get(oldest.value) as Buffer;
      this.entries.delete(oldest.value);
      this.bytes -= evicted.length;
    }
  }
}

interface RepoGitState {
  /** Bumped on every ref mutation; keys the ref-dependent caches. */
  refsVersion: number;
  /** v0 advertisements and ls-refs answers, keyed with refsVersion. */
  adv: ByteCache;
  /** Pack bytes keyed by the exact object list they were built from. */
  pack: ByteCache;
  /** Whole v2 fetch responses keyed by the negotiation parameters. */
  fetch: ByteCache;
}

const gitStates = new WeakMap<Repo, RepoGitState>();

function gitState(repo: Repo): RepoGitState {
  let state = gitStates.get(repo);
  if (state === undefined) {
    state = {
      refsVersion: 0,
      adv: new ByteCache(4 * 1024 * 1024),
      pack: new ByteCache(32 * 1024 * 1024),
      fetch: new ByteCache(32 * 1024 * 1024),
    };
    gitStates.set(repo, state);
  }
  return state;
}

/** Record that the repo's refs changed; ref-dependent cached answers go stale. */
export function bumpRefsVersion(repo: Repo): void {
  gitState(repo).refsVersion += 1;
}

/** buildPack through the per-repo pack cache (the object list is the full determinant). */
function buildPackCached(repo: Repo, shas: readonly string[]): Buffer {
  if (shas.length === 0) return buildPack(repo, shas);
  const state = gitState(repo);
  const key = shas.join(',');
  const hit = state.pack.get(key);
  if (hit !== undefined) return hit;
  const pack = buildPack(repo, shas);
  state.pack.set(key, pack);
  return pack;
}

// ---------------------------------------------------------------- advertisement

const UPLOAD_CAPS = 'multi_ack_detailed no-done side-band-64k thin-pack ofs-delta shallow';
const RECEIVE_CAPS = 'report-status delete-refs side-band-64k ofs-delta';

/** The v0 ref advertisement for one service, preamble included. */
export function advertisement(repo: Repo, service: 'git-upload-pack' | 'git-receive-pack'): Buffer {
  const state = gitState(repo);
  const cacheKey = `adv:${service}:${state.refsVersion}`;
  const cached = state.adv.get(cacheKey);
  if (cached !== undefined) return cached;
  const caps = service === 'git-upload-pack' ? UPLOAD_CAPS : RECEIVE_CAPS;
  const symref = `symref=HEAD:${repo.headRef()}`;
  const parts: Buffer[] = [pktLine(`# service=${service}\n`), PKT_FLUSH];
  const names = [...repo.refs.keys()].sort();
  if (names.length === 0) {
    parts.push(pktLine(`${ZERO_SHA} capabilities^{}\0${caps} ${symref}`));
  } else {
    const headSha = repo.refs.get(repo.headRef());
    let first = true;
    if (headSha !== undefined) {
      parts.push(pktLine(`${headSha} HEAD\0${caps} ${symref}`));
      first = false;
    }
    for (const name of names) {
      const sha = repo.refs.get(name) as string;
      parts.push(pktLine(first ? `${sha} ${name}\0${caps} ${symref}` : `${sha} ${name}`));
      first = false;
      const peeled = peelTarget(repo, sha);
      if (peeled !== sha) parts.push(pktLine(`${peeled} ${name}^{}`));
    }
  }
  parts.push(PKT_FLUSH);
  const body = Buffer.concat(parts);
  state.adv.set(cacheKey, body);
  return body;
}

// ---------------------------------------------------------------- upload-pack

interface Negotiation {
  wants: string[];
  haves: string[];
  /** The client's declared shallow boundary commits (`shallow` lines). */
  shallowClient: string[];
  depth?: number;
  caps: string;
  /** Offset just past the pkt-line section (the packfile start for receive-pack). */
  packOffset: number;
}

function parseNegotiation(body: Buffer): Negotiation {
  const wants: string[] = [];
  const haves: string[] = [];
  const shallowClient: string[] = [];
  let depth: number | undefined;
  let caps = '';
  let offset = 0;
  for (;;) {
    const read = readPkt(body, offset);
    if (read === null) {
      offset = body.length;
      break;
    }
    offset = read.next;
    if (read.payload === null) continue;
    const line = read.payload.toString('utf8').replace(/\n$/, '');
    if (line.startsWith('want ')) {
      const rest = line.slice(5);
      const space = rest.indexOf(' ');
      if (space >= 0) {
        wants.push(rest.slice(0, space));
        if (caps === '') caps = rest.slice(space + 1);
      } else {
        wants.push(rest);
      }
    } else if (line.startsWith('have ')) {
      haves.push(line.slice(5).trim());
    } else if (line.startsWith('shallow ')) {
      shallowClient.push(line.slice(8).trim());
    } else if (line.startsWith('deepen ')) {
      depth = Number.parseInt(line.slice(7), 10);
    } else if (line === 'done') {
      break;
    }
  }
  return { wants, haves, shallowClient, depth, caps, packOffset: offset };
}

/** The haves that name a commit this repository actually holds (the common history). */
function commonHaves(repo: Repo, haves: readonly string[]): string[] {
  return haves.filter((have) => {
    const obj = repo.objects.get(peelTarget(repo, have));
    return obj !== undefined && obj.type === 'commit';
  });
}

/** Wrap a packfile in side-band-64k band-1 pkt-lines, flush-terminated. */
function sideBandWrap(data: Buffer): Buffer {
  const parts: Buffer[] = [];
  const CHUNK = 65514;
  for (let at = 0; at < data.length; at += CHUNK) {
    parts.push(pktLine(Buffer.concat([Buffer.from([1]), data.subarray(at, at + CHUNK)])));
  }
  parts.push(PKT_FLUSH);
  return Buffer.concat(parts);
}

/** Answer one git-upload-pack POST body with the response body (v0 negotiation). */
export function uploadPack(repo: Repo, body: Buffer): Buffer {
  const neg = parseNegotiation(body);
  const wants = neg.wants.filter((sha) => repo.objects.has(sha));
  if (wants.length === 0) return Buffer.alloc(0);
  const closure = collectClosure(repo, wants, neg.depth);
  const acks = commonHaves(repo, neg.haves);
  const held = collectHeld(repo, acks, new Set(neg.shallowClient));
  const pack = buildPackCached(repo, closure.objects.filter((sha) => !held.has(sha)));
  const parts: Buffer[] = [];
  // Stateless (HTTP) shallow negotiation: fetch-pack consumes the shallow list once per
  // negotiation round — after the initial flush and again after "done" — each time as a
  // flush-terminated block BEFORE the NAK (fetch-pack.c consume_shallow_list). A fresh
  // shallow clone therefore needs the list twice, both times ahead of the single NAK.
  // (A fetch carrying many have-blocks would need one copy per round; the suite's shallow
  // traffic is fresh clones, and full multi-round support is a build-phase item.)
  const shallowRounds = neg.depth !== undefined ? 2 : closure.shallow.length > 0 ? 1 : 0;
  for (let round = 0; round < shallowRounds; round += 1) {
    for (const sha of closure.shallow) parts.push(pktLine(`shallow ${sha}\n`));
    parts.push(PKT_FLUSH);
  }
  if (acks.length > 0) {
    // The final round of a multi_ack negotiation: one ACK for the newest common commit.
    parts.push(pktLine(`ACK ${acks[acks.length - 1]} ready\n`));
  } else {
    parts.push(pktLine('NAK\n'));
  }
  if (neg.caps.includes('side-band-64k')) {
    parts.push(sideBandWrap(pack));
  } else {
    parts.push(pack);
  }
  return Buffer.concat(parts);
}

// ---------------------------------------------------------------- receive-pack

export interface RefUpdate {
  oldSha: string;
  newSha: string;
  ref: string;
}

/** Answer one git-receive-pack POST body: apply the updates, answer report-status. */
export function receivePack(repo: Repo, body: Buffer): Buffer {
  // The command list is pkt-lines up to the first flush; the packfile follows.
  const commands: RefUpdate[] = [];
  let caps = '';
  let offset = 0;
  for (;;) {
    const read = readPkt(body, offset);
    if (read === null) {
      offset = body.length;
      break;
    }
    offset = read.next;
    if (read.payload === null) break;
    let line = read.payload.toString('utf8').replace(/\n$/, '');
    const nul = line.indexOf('\0');
    if (nul >= 0) {
      caps = line.slice(nul + 1);
      line = line.slice(0, nul);
    }
    const fields = line.split(' ');
    if (fields.length === 3) {
      commands.push({ oldSha: fields[0] as string, newSha: fields[1] as string, ref: fields[2] as string });
    }
  }

  let unpackError: string | null = null;
  if (offset < body.length && body.length - offset >= 12) {
    try {
      parsePackInto(repo, body, offset);
    } catch (err) {
      unpackError = err instanceof Error ? err.message : String(err);
    }
  }

  const results: { ref: string; ok: boolean; reason: string }[] = [];
  for (const cmd of commands) {
    if (unpackError !== null) {
      results.push({ ref: cmd.ref, ok: false, reason: 'unpacker error' });
      continue;
    }
    const current = repo.refs.get(cmd.ref) ?? ZERO_SHA;
    if (current !== cmd.oldSha) {
      results.push({ ref: cmd.ref, ok: false, reason: 'failed to lock ref' });
      continue;
    }
    if (cmd.newSha === ZERO_SHA) {
      repo.refs.delete(cmd.ref);
      bumpRefsVersion(repo);
      results.push({ ref: cmd.ref, ok: true, reason: '' });
      continue;
    }
    const obj = repo.objects.get(cmd.newSha);
    if (obj === undefined) {
      results.push({ ref: cmd.ref, ok: false, reason: 'invalid object' });
      continue;
    }
    // A ref may name any object (a tag ref names a tag object). The fast-forward rule
    // binds commit-to-commit updates; moving a ref between tag objects is not an
    // ancestry question and is accepted, as in git.
    const oldObj = cmd.oldSha === ZERO_SHA ? undefined : repo.objects.get(cmd.oldSha);
    if (
      oldObj !== undefined &&
      oldObj.type === 'commit' &&
      obj.type === 'commit' &&
      !isAncestor(repo, cmd.oldSha, cmd.newSha)
    ) {
      results.push({ ref: cmd.ref, ok: false, reason: 'non-fast-forward' });
      continue;
    }
    repo.refs.set(cmd.ref, cmd.newSha);
    bumpRefsVersion(repo);
    results.push({ ref: cmd.ref, ok: true, reason: '' });
  }

  if (!caps.includes('report-status')) {
    return caps.includes('side-band-64k') ? PKT_FLUSH : Buffer.alloc(0);
  }
  const inner: Buffer[] = [pktLine(unpackError === null ? 'unpack ok\n' : `unpack ${unpackError}\n`)];
  for (const result of results) {
    inner.push(pktLine(result.ok ? `ok ${result.ref}\n` : `ng ${result.ref} ${result.reason}\n`));
  }
  inner.push(PKT_FLUSH);
  const report = Buffer.concat(inner);
  return caps.includes('side-band-64k') ? sideBandWrap(report) : report;
}

// ---------------------------------------------------------------- protocol v2
// upload-pack protocol v2: the advertisement is a capability list (no service preamble,
// no refs), and refs/objects move through commands POSTed to git-upload-pack —
// `command=ls-refs` and `command=fetch`, each a capability block, a delim packet, then
// argument lines and a flush. A fetch answers in named sections (acknowledgments,
// shallow-info, packfile) separated by delim packets, the packfile section last and
// flush-terminated, side-band-64k framed exactly like v0's.

export const PKT_DELIM = Buffer.from('0001', 'ascii');
export const PKT_RESPONSE_END = Buffer.from('0002', 'ascii');

/** The v2 capability advertisement: fully static, built once and shared by every answer. */
const ADVERTISEMENT_V2 = Buffer.concat([
  pktLine('version 2\n'),
  pktLine('agent=makefun-forge/1.0\n'),
  pktLine('ls-refs\n'),
  pktLine('fetch=shallow\n'),
  pktLine('object-format=sha1\n'),
  PKT_FLUSH,
]);

/** The v2 capability advertisement for git-upload-pack (answer to a version=2 request). */
export function advertisementV2(): Buffer {
  return ADVERTISEMENT_V2;
}

type V2PacketKind = 'data' | 'flush' | 'delim' | 'end';

interface V2Packet {
  kind: V2PacketKind;
  payload: Buffer;
}

/** Split a v2 request body into its packets, honouring the delim/response-end packets. */
function readV2Packets(body: Buffer): V2Packet[] {
  const packets: V2Packet[] = [];
  let offset = 0;
  while (offset + 4 <= body.length) {
    const length = Number.parseInt(body.toString('ascii', offset, offset + 4), 16);
    if (Number.isNaN(length) || length < 0) break;
    if (length === 0) {
      packets.push({ kind: 'flush', payload: Buffer.alloc(0) });
      offset += 4;
    } else if (length === 1) {
      packets.push({ kind: 'delim', payload: Buffer.alloc(0) });
      offset += 4;
    } else if (length === 2) {
      packets.push({ kind: 'end', payload: Buffer.alloc(0) });
      offset += 4;
    } else if (length === 3) {
      offset += 4; // a legacy packet kind with no payload; never sent by git
    } else {
      if (offset + length > body.length) break;
      packets.push({ kind: 'data', payload: body.subarray(offset + 4, offset + length) });
      offset += length;
    }
  }
  return packets;
}

/** The `command=ls-refs` answer: HEAD (when it matches the prefixes), then the refs. */
function lsRefsV2(repo: Repo, args: readonly string[]): Buffer {
  const state = gitState(repo);
  const cacheKey = `lsrefs:${state.refsVersion}:${args.join('\n')}`;
  const cached = state.adv.get(cacheKey);
  if (cached !== undefined) return cached;
  const peel = args.includes('peel');
  const symrefs = args.includes('symrefs');
  const unborn = args.includes('unborn');
  const prefixes = args
    .filter((arg) => arg.startsWith('ref-prefix '))
    .map((arg) => arg.slice('ref-prefix '.length));
  const matches = (name: string): boolean =>
    prefixes.length === 0 || prefixes.some((prefix) => name.startsWith(prefix));
  const parts: Buffer[] = [];
  const headRef = repo.headRef();
  const headSha = repo.refs.get(headRef);
  if (matches('HEAD')) {
    if (headSha !== undefined) {
      parts.push(pktLine(`${headSha} HEAD${symrefs ? ` symref-target:${headRef}` : ''}\n`));
    } else if (unborn) {
      parts.push(pktLine(`unborn HEAD${symrefs ? ` symref-target:${headRef}` : ''}\n`));
    }
  }
  for (const name of [...repo.refs.keys()].sort()) {
    if (!matches(name)) continue;
    const sha = repo.refs.get(name) as string;
    let line = `${sha} ${name}`;
    if (peel) {
      const target = peelTarget(repo, sha);
      if (target !== sha) line += ` peeled:${target}`;
    }
    parts.push(pktLine(`${line}\n`));
  }
  parts.push(PKT_FLUSH);
  const body = Buffer.concat(parts);
  state.adv.set(cacheKey, body);
  return body;
}

/** The `command=fetch` answer: acknowledgments, shallow-info, then the packfile section. */
function fetchV2(repo: Repo, args: readonly string[]): Buffer {
  const wants: string[] = [];
  const wantRefs: string[] = [];
  const haves: string[] = [];
  const shallowClient: string[] = [];
  let depth: number | undefined;
  let deepenRelative = false;
  let done = false;
  let waitForDone = false;
  for (const line of args) {
    if (line.startsWith('want ')) wants.push(line.slice(5).trim());
    else if (line.startsWith('want-ref ')) wantRefs.push(line.slice(9).trim());
    else if (line.startsWith('have ')) haves.push(line.slice(5).trim());
    else if (line.startsWith('shallow ')) shallowClient.push(line.slice(8).trim());
    else if (line.startsWith('deepen ')) depth = Number.parseInt(line.slice(7), 10);
    else if (line === 'deepen-relative') deepenRelative = true;
    else if (line === 'done') done = true;
    else if (line === 'wait-for-done') waitForDone = true;
    // thin-pack / no-progress / ofs-delta / include-tag / deepen-since / deepen-not /
    // filter: accepted; the pack is always complete (never thin) and carries no progress.
  }
  const acks = commonHaves(repo, haves);
  const ackSection = (): Buffer[] => {
    const section: Buffer[] = [pktLine('acknowledgments\n')];
    if (acks.length === 0) {
      section.push(pktLine('NAK\n'));
    } else {
      for (const ack of acks) section.push(pktLine(`ACK ${ack}\n`));
    }
    return section;
  };
  if (!done && waitForDone) {
    // The one shape that ends in a response-end packet: the client asked us to hold
    // the pack until a later done request, so this response is negotiation only.
    // (wait-for-done is not in our advertised fetch features, so git never sends it;
    // the suite's client always sends done and never sees a response-end packet.)
    const parts: Buffer[] = [];
    if (haves.length > 0) parts.push(...ackSection(), PKT_FLUSH);
    parts.push(PKT_RESPONSE_END);
    return Buffer.concat(parts);
  }
  for (const ref of wantRefs) {
    const sha = repo.refs.get(ref);
    if (sha !== undefined) wants.push(sha);
  }
  const validWants = wants.filter((sha) => repo.objects.has(sha));
  if (depth !== undefined && deepenRelative) {
    // deepen-relative: the number counts from the client's current shallow depth,
    // which is the generation of its boundary commits below the wants, plus one.
    const generation = new Map<string, number>();
    const queue: string[] = [];
    for (const tip of validWants) {
      const target = peelTarget(repo, tip);
      const obj = repo.objects.get(target);
      if (obj !== undefined && obj.type === 'commit' && !generation.has(target)) {
        generation.set(target, 0);
        queue.push(target);
      }
    }
    for (let head = 0; head < queue.length; head += 1) {
      const sha = queue[head] as string;
      const gen = generation.get(sha) as number;
      const obj = repo.objects.get(sha) as GitObject;
      for (const parent of parseCommit(obj.data).parents) {
        if (!generation.has(parent)) {
          const parentObj = repo.objects.get(parent);
          if (parentObj !== undefined && parentObj.type === 'commit') {
            generation.set(parent, gen + 1);
            queue.push(parent);
          }
        }
      }
    }
    let base = 0;
    for (const boundary of shallowClient) {
      const gen = generation.get(boundary);
      if (gen !== undefined) base = Math.max(base, gen + 1);
    }
    if (base > 0) depth += base;
  }
  // Whole-response cache. The answer is a pure function of the negotiation over the
  // immutable object graph, so it is cacheable exactly when every input is stable:
  // no want-ref indirection (refs move), every want already in the store (a missing
  // want could arrive later and change the closure), and every have recognised as a
  // held commit (an unrecognised have could arrive later and change the held set).
  const state = gitState(repo);
  let fetchCacheKey: string | null = null;
  if (wantRefs.length === 0 && validWants.length === wants.length && acks.length === haves.length) {
    fetchCacheKey = [
      'fetch',
      validWants.join(','),
      depth === undefined ? 'full' : String(depth),
      deepenRelative ? 'rel' : 'abs',
      acks.join(','),
      shallowClient.join(','),
      done ? 'done' : 'open',
    ].join(':');
    const cached = state.fetch.get(fetchCacheKey);
    if (cached !== undefined) return cached;
  }
  const closure = collectClosure(repo, validWants, depth);
  const held = collectHeld(repo, acks, new Set(shallowClient));
  const pack = buildPackCached(repo, closure.objects.filter((sha) => !held.has(sha)));
  // Response sections are separated by delim packets; the packfile section closes the
  // response with a flush (the shape git's own upload-pack sends, verified byte-level).
  // With done, git sends no acknowledgments section at all; without done, the section
  // is present and its `ready` line says the pack follows in this same response.
  const parts: Buffer[] = [];
  if (!done && haves.length > 0) {
    parts.push(...ackSection());
    parts.push(pktLine('ready\n'));
    parts.push(PKT_DELIM);
  }
  if (depth !== undefined) {
    const boundary = new Set(closure.shallow);
    const included = new Set(closure.objects);
    const unshallow = shallowClient.filter((sha) => included.has(sha) && !boundary.has(sha));
    if (boundary.size > 0 || unshallow.length > 0) {
      parts.push(pktLine('shallow-info\n'));
      for (const sha of closure.shallow) parts.push(pktLine(`shallow ${sha}\n`));
      for (const sha of unshallow) parts.push(pktLine(`unshallow ${sha}\n`));
      parts.push(PKT_DELIM);
    }
  }
  parts.push(pktLine('packfile\n'));
  parts.push(sideBandWrap(pack));
  const body = Buffer.concat(parts);
  if (fetchCacheKey !== null) state.fetch.set(fetchCacheKey, body);
  return body;
}

/** Answer one protocol-v2 git-upload-pack POST body (a command request). */
export function uploadPackV2(repo: Repo, body: Buffer): Buffer {
  let command = '';
  const args: string[] = [];
  let inArgs = false;
  for (const packet of readV2Packets(body)) {
    if (packet.kind === 'delim') {
      inArgs = true;
      continue;
    }
    if (packet.kind === 'flush' || packet.kind === 'end') break;
    const line = packet.payload.toString('utf8').replace(/\n$/, '');
    if (!inArgs) {
      if (line.startsWith('command=')) command = line.slice('command='.length);
      // agent= / object-format= capability lines: accepted, no effect.
    } else {
      args.push(line);
    }
  }
  if (command === 'ls-refs') return lsRefsV2(repo, args);
  if (command === 'fetch') return fetchV2(repo, args);
  return Buffer.concat([pktLine(`error unsupported command ${command}\n`), PKT_FLUSH]);
}
