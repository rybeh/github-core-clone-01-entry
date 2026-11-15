// The forge's HTTP surface: git smart HTTP, the REST v3 subset, a GraphQL placeholder and
// the MCP endpoint, all over the one store in store.ts. main.ts owns the env lifecycle;
// this file is the server the suite scores, and the file to grow.
//
// Scope (see ../notes/state.md for the build plan): repositories CRUD + pagination, labels,
// issues full surface (create/list/get/PATCH/comments), contents API writing real commits,
// branches/commits reads, pull requests (create/list/get/files, squash merge with per-path
// conflict detection against the merge base), git v0 clone/push with a real client, MCP
// handshake with the six required tools wired to the same store, and the GraphQL v4
// evaluator in graphql.ts (parser, introspection schema, resolvers and mutations over the
// same store; a pull's GraphQL mergeable is computed from squashTree), and git protocol
// v2 for upload-pack (capability advertisement, ls-refs, fetch with have negotiation).

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { Store, type Issue, type PullRequest, type Repo } from './store.ts';
import {
  advertisement,
  advertisementV2,
  bumpRefsVersion,
  commitMessage,
  createCommit,
  flattenTree,
  mergeBase,
  parseCommit,
  receivePack,
  subtreeAt,
  uploadPack,
  uploadPackV2,
  writeTree,
} from './git.ts';
import { executeGraphQLOperation, type GraphQLDeps } from './graphql.ts';

const JSON_TYPE = 'application/json; charset=utf-8';

interface Ctx {
  store: Store;
  token: string;
}

function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function sendJson(ctx: Ctx, res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  const text = `${JSON.stringify(body)}\n`;
  ctx.store.requestSeq += 1;
  res.writeHead(status, {
    'content-type': JSON_TYPE,
    'content-length': Buffer.byteLength(text),
    'x-github-request-id': `FORGE-${ctx.store.requestSeq}`,
    ...headers,
  });
  res.end(text);
}

function sendRaw(res: ServerResponse, status: number, body: Buffer, contentType: string): void {
  res.writeHead(status, { 'content-type': contentType, 'content-length': body.length });
  res.end(body);
}

// ---------------------------------------------------------------- shapes

function repoJson(ctx: Ctx, repo: Repo): Record<string, unknown> {
  const login = ctx.store.login();
  return {
    id: repo.id,
    name: repo.name,
    full_name: `${login}/${repo.name}`,
    owner: { login, id: 1000, type: 'User' },
    private: repo.isPrivate,
    description: repo.description,
    default_branch: repo.defaultBranch,
    html_url: `/${login}/${repo.name}`,
    clone_url: `/${login}/${repo.name}.git`,
  };
}

function issueJson(repo: Repo, issue: Issue): Record<string, unknown> {
  return {
    id: issue.id,
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    labels: issue.labels.map((name) => ({ name, color: repo.labels.get(name) ?? 'ededed' })),
    comments: issue.comments.length,
  };
}

function commentJson(comment: { id: number; body: string }): Record<string, unknown> {
  return { id: comment.id, body: comment.body };
}

// ---------------------------------------------------------------- pull requests

/** The fixed epoch REST-created commits count from (see Store.commitSeq). */
const COMMIT_EPOCH = 1_762_905_600;

/** A branch name from a ref-ish input: strips a refs/heads/ prefix when one is present. */
function branchName(raw: string): string {
  return raw.startsWith('refs/heads/') ? raw.slice('refs/heads/'.length) : raw;
}

function pullJson(ctx: Ctx, repo: Repo, pull: PullRequest): Record<string, unknown> {
  const login = ctx.store.login();
  const headSha = repo.refs.get(`refs/heads/${pull.headRef}`) ?? pull.headSha;
  const baseSha = repo.refs.get(`refs/heads/${pull.baseRef}`) ?? pull.baseSha;
  return {
    id: pull.id,
    number: pull.number,
    state: pull.state,
    title: pull.title,
    body: pull.body,
    user: { login, id: 1000, type: 'User' },
    head: { ref: pull.headRef, sha: headSha, label: `${login}:${pull.headRef}` },
    base: { ref: pull.baseRef, sha: baseSha, label: `${login}:${pull.baseRef}` },
    merged: pull.merged,
    merged_at: pull.mergedAt,
    merge_commit_sha: pull.mergeCommitSha,
    mergeable: pull.state === 'open',
    html_url: `/${login}/${repo.name}/pull/${pull.number}`,
  };
}

/** Open a pull request; null when either branch does not name an existing ref. */
function openPullRequest(store: Store, repo: Repo, input: { title: string; body: string; head: string; base: string }): PullRequest | null {
  const headSha = repo.refs.get(`refs/heads/${input.head}`);
  const baseSha = repo.refs.get(`refs/heads/${input.base}`);
  if (headSha === undefined || baseSha === undefined) return null;
  const pull: PullRequest = {
    id: store.nextPullId,
    number: repo.nextIssueNumber,
    title: input.title,
    body: input.body,
    state: 'open',
    headRef: input.head,
    baseRef: input.base,
    headSha,
    baseSha,
    merged: false,
    mergedAt: null,
    mergeCommitSha: null,
  };
  store.nextPullId += 1;
  repo.nextIssueNumber += 1;
  repo.pulls.push(pull);
  return pull;
}

/** The root tree of a commit, or '' when the sha is not a commit in the store. */
function treeOfCommit(repo: Repo, sha: string): string {
  const obj = repo.objects.get(sha);
  return obj !== undefined && obj.type === 'commit' ? parseCommit(obj.data).tree : '';
}

function splitLines(text: string): string[] {
  if (text === '') return [];
  const lines = text.split('\n');
  if (lines[lines.length - 1] === '') lines.pop();
  return lines;
}

/** Added/removed line counts between two file contents, by longest common subsequence. */
function lineDiff(oldText: string, newText: string): { additions: number; deletions: number } {
  const a = splitLines(oldText);
  const b = splitLines(newText);
  if (a.length * b.length > 4_000_000) {
    // Too large for an LCS table; the counts stay plausible whole-side totals.
    return { additions: b.length, deletions: a.length };
  }
  const dp = new Array<number>(b.length + 1).fill(0);
  for (let i = a.length - 1; i >= 0; i -= 1) {
    let diag = 0; // dp of the row below at j+1, carried across the inner loop
    for (let j = b.length - 1; j >= 0; j -= 1) {
      const above = dp[j] as number;
      dp[j] = a[i] === b[j] ? diag + 1 : Math.max(above, dp[j + 1] as number);
      diag = above;
    }
  }
  const common = dp[0] as number;
  return { additions: b.length - common, deletions: a.length - common };
}

export interface PullFile {
  filename: string;
  status: 'added' | 'removed' | 'modified';
  additions: number;
  deletions: number;
  changes: number;
  sha: string | null;
}

/** The files a pull request changes: head tree against the merge-base tree. */
function pullFiles(repo: Repo, pull: PullRequest): PullFile[] {
  const headTip = repo.refs.get(`refs/heads/${pull.headRef}`) ?? pull.headSha;
  const baseTip = repo.refs.get(`refs/heads/${pull.baseRef}`) ?? pull.baseSha;
  const base = mergeBase(repo, headTip, baseTip);
  const baseFiles = base === null ? new Map<string, string>() : flattenTree(repo, treeOfCommit(repo, base));
  const headFiles = flattenTree(repo, treeOfCommit(repo, headTip));
  const files: PullFile[] = [];
  const paths = new Set<string>([...baseFiles.keys(), ...headFiles.keys()]);
  for (const path of paths) {
    const before = baseFiles.get(path);
    const after = headFiles.get(path);
    if (before === after) continue;
    const oldText = before === undefined ? '' : (repo.objects.get(before)?.data.toString('utf8') ?? '');
    const newText = after === undefined ? '' : (repo.objects.get(after)?.data.toString('utf8') ?? '');
    const { additions, deletions } = lineDiff(oldText, newText);
    files.push({
      filename: path,
      status: before === undefined ? 'added' : after === undefined ? 'removed' : 'modified',
      additions,
      deletions,
      changes: additions + deletions,
      sha: after ?? null,
    });
  }
  files.sort((x, y) => (x.filename < y.filename ? -1 : x.filename > y.filename ? 1 : 0));
  return files;
}

type SquashOutcome = { kind: 'ok'; tree: string } | { kind: 'conflict' } | { kind: 'missing' };

/**
 * The tree a squash merge of the pull would produce: the head side's changes since the
 * merge base, applied onto the current base tip. A path both sides changed since the
 * merge base — to different results — is a conflict.
 */
function squashTree(repo: Repo, pull: PullRequest): SquashOutcome {
  const headTip = repo.refs.get(`refs/heads/${pull.headRef}`);
  const baseTip = repo.refs.get(`refs/heads/${pull.baseRef}`);
  if (headTip === undefined || baseTip === undefined) return { kind: 'missing' };
  const base = mergeBase(repo, headTip, baseTip);
  const baseFiles = base === null ? new Map<string, string>() : flattenTree(repo, treeOfCommit(repo, base));
  const headFiles = flattenTree(repo, treeOfCommit(repo, headTip));
  const tipFiles = flattenTree(repo, treeOfCommit(repo, baseTip));
  const merged = new Map(tipFiles);
  const paths = new Set<string>([...baseFiles.keys(), ...headFiles.keys()]);
  for (const path of paths) {
    const inBase = baseFiles.get(path);
    const inHead = headFiles.get(path);
    if (inHead === inBase) continue; // the head side did not change this path
    const inTip = tipFiles.get(path);
    if (inTip !== inBase && inTip !== inHead) return { kind: 'conflict' };
    if (inHead === undefined) merged.delete(path);
    else merged.set(path, inHead);
  }
  return { kind: 'ok', tree: writeTree(repo, merged) };
}

type MergeResult = { ok: true; sha: string } | { ok: false; reason: 'already' | 'conflict' | 'missing' };

/**
 * Squash-merge a pull request: one commit on the base ref whose parent is the base tip
 * and whose tree is the three-way result. The commit timestamp (and so merged_at) comes
 * from the store's commit sequence — no wall clock reaches the state.
 */
function mergePullRequest(store: Store, repo: Repo, pull: PullRequest): MergeResult {
  if (pull.state === 'closed') return { ok: false, reason: 'already' };
  const outcome = squashTree(repo, pull);
  if (outcome.kind !== 'ok') return { ok: false, reason: outcome.kind };
  const baseTip = repo.refs.get(`refs/heads/${pull.baseRef}`) as string;
  store.commitSeq += 1;
  const time = COMMIT_EPOCH + store.commitSeq;
  const sha = createCommit(repo, outcome.tree, [baseTip], pull.title, time);
  repo.refs.set(`refs/heads/${pull.baseRef}`, sha);
  bumpRefsVersion(repo);
  pull.state = 'closed';
  pull.merged = true;
  pull.mergeCommitSha = sha;
  pull.mergedAt = new Date(time * 1000).toISOString();
  return { ok: true, sha };
}

/** Parse a JSON request body; null when it is not a JSON object (the caller answers 400). */
async function readJsonBody(req: IncomingMessage): Promise<Record<string, unknown> | null> {
  const raw = await readBody(req);
  try {
    const parsed: unknown = JSON.parse(raw.toString('utf8'));
    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/** The commit a ref-ish names: a branch name, a raw commit sha, or the default branch. */
function resolveTip(repo: Repo, ref: string | undefined): string | null {
  if (ref === undefined || ref === '') return repo.refs.get(repo.headRef()) ?? null;
  const byBranch = repo.refs.get(`refs/heads/${ref}`);
  if (byBranch !== undefined) return byBranch;
  const obj = repo.objects.get(ref);
  return obj !== undefined && obj.type === 'commit' ? ref : null;
}

// ---------------------------------------------------------------- MCP tools

const MCP_TOOLS = [
  {
    name: 'create_repo',
    description: 'Create a new repository for the authenticated user.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'The repository name.' },
        description: { type: 'string' },
        private: { type: 'boolean' },
      },
      required: ['name'],
    },
  },
  {
    name: 'get_repo',
    description: 'Get a repository by owner and name.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string' },
        repo: { type: 'string' },
        full_name: { type: 'string', description: 'owner/repo, accepted instead of owner and repo.' },
      },
      required: [],
    },
  },
  {
    name: 'create_issue',
    description: 'Create an issue in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string' },
        repo: { type: 'string' },
        title: { type: 'string' },
        body: { type: 'string' },
      },
      required: ['owner', 'repo', 'title'],
    },
  },
  {
    name: 'list_issues',
    description: 'List the issues of a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string' },
        repo: { type: 'string' },
        state: { type: 'string', enum: ['open', 'closed', 'all'] },
      },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'create_pull_request',
    description: 'Open a pull request from a head branch to a base branch.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string' },
        repo: { type: 'string' },
        title: { type: 'string' },
        head: { type: 'string' },
        base: { type: 'string' },
        body: { type: 'string' },
      },
      required: ['owner', 'repo', 'title', 'head', 'base'],
    },
  },
  {
    name: 'merge_pull_request',
    description: 'Merge a pull request by number.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string' },
        repo: { type: 'string' },
        pull_number: { type: 'number' },
      },
      required: ['owner', 'repo', 'pull_number'],
    },
  },
] as const;

/** owner/repo from tool arguments: explicit owner+repo, or a full_name of "owner/repo". */
function toolRepoArgs(args: Record<string, unknown>): { owner: string; repo: string } | null {
  let owner = typeof args.owner === 'string' ? args.owner : '';
  let repo = typeof args.repo === 'string' ? args.repo : '';
  if ((owner === '' || repo === '') && typeof args.full_name === 'string') {
    const slash = args.full_name.indexOf('/');
    if (slash > 0) {
      owner = args.full_name.slice(0, slash);
      repo = args.full_name.slice(slash + 1);
    }
  }
  return owner !== '' && repo !== '' ? { owner, repo } : null;
}

function toolText(value: unknown): Record<string, unknown> {
  return { content: [{ type: 'text', text: JSON.stringify(value) }], isError: false };
}

function toolError(message: string): Record<string, unknown> {
  return { content: [{ type: 'text', text: message }], isError: true };
}

/**
 * The contents API: files as commits in the repo's own git store. A PUT writes a blob,
 * rebuilds the tree chain and commits on the target branch (an unborn branch starts with
 * this commit); GET reads a file or lists a directory at a ref; DELETE removes the file
 * with a commit. Commit timestamps come from the store's sequence, never the clock.
 * Returns true when the request was answered.
 */
async function contentsRoute(
  ctx: Ctx,
  res: ServerResponse,
  repo: Repo,
  filePath: string,
  method: string,
  req: IncomingMessage,
  url: URL,
): Promise<boolean> {
  const { store } = ctx;
  if (filePath === '') return false;

  if (method === 'GET') {
    const tip = resolveTip(repo, url.searchParams.get('ref') ?? undefined);
    if (tip === null) {
      sendJson(ctx, res, 404, { message: 'Not Found' });
      return true;
    }
    const commit = repo.objects.get(tip);
    if (commit === undefined || commit.type !== 'commit') {
      sendJson(ctx, res, 404, { message: 'Not Found' });
      return true;
    }
    const rootTree = parseCommit(commit.data).tree;
    const files = flattenTree(repo, rootTree);
    const blobSha = files.get(filePath);
    if (blobSha !== undefined) {
      const blob = repo.objects.get(blobSha);
      if (blob === undefined) {
        sendJson(ctx, res, 404, { message: 'Not Found' });
        return true;
      }
      const slash = filePath.lastIndexOf('/');
      sendJson(ctx, res, 200, {
        type: 'file',
        name: slash < 0 ? filePath : filePath.slice(slash + 1),
        path: filePath,
        sha: blobSha,
        size: blob.data.length,
        encoding: 'base64',
        content: blob.data.toString('base64'),
      });
      return true;
    }
    const prefix = `${filePath}/`;
    const children = new Map<string, { type: 'file' | 'dir'; sha: string }>();
    for (const [path, sha] of files) {
      if (!path.startsWith(prefix)) continue;
      const rest = path.slice(prefix.length);
      const slash = rest.indexOf('/');
      if (slash < 0) {
        children.set(rest, { type: 'file', sha });
      } else {
        const dirName = rest.slice(0, slash);
        if (!children.has(dirName)) {
          const sub = subtreeAt(repo, rootTree, `${prefix}${dirName}`);
          children.set(dirName, { type: 'dir', sha: sub ?? '' });
        }
      }
    }
    if (children.size === 0) {
      sendJson(ctx, res, 404, { message: 'Not Found' });
      return true;
    }
    const entries = [...children.entries()]
      .map(([name, child]) => ({ type: child.type, name, path: `${prefix}${name}`, sha: child.sha, size: 0 }))
      .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    sendJson(ctx, res, 200, entries);
    return true;
  }

  if (method === 'PUT' || method === 'DELETE') {
    const body = await readJsonBody(req);
    if (body === null) {
      sendJson(ctx, res, 400, { message: 'Problems parsing JSON' });
      return true;
    }
    const branch = typeof body.branch === 'string' && body.branch !== '' ? body.branch : repo.defaultBranch;
    const refName = `refs/heads/${branch}`;
    const tip = repo.refs.get(refName) ?? null;
    const files = new Map<string, string>();
    if (tip !== null) {
      const commit = repo.objects.get(tip);
      if (commit !== undefined && commit.type === 'commit') {
        for (const [path, sha] of flattenTree(repo, parseCommit(commit.data).tree)) files.set(path, sha);
      }
    }
    const message = typeof body.message === 'string' ? body.message : '';
    const givenSha = typeof body.sha === 'string' ? body.sha : undefined;
    const existing = files.get(filePath);

    if (method === 'DELETE') {
      if (existing === undefined) {
        sendJson(ctx, res, 404, { message: 'Not Found' });
        return true;
      }
      if (givenSha !== undefined && givenSha !== existing) {
        sendJson(ctx, res, 409, { message: 'Conflict' });
        return true;
      }
      files.delete(filePath);
      const tree = writeTree(repo, files);
      store.commitSeq += 1;
      const commitSha = createCommit(repo, tree, tip === null ? [] : [tip], message, 1_762_905_600 + store.commitSeq);
      repo.refs.set(refName, commitSha);
      bumpRefsVersion(repo);
      sendJson(ctx, res, 200, { content: null, commit: { sha: commitSha, message } });
      return true;
    }

    // PUT: create or update one file.
    if (existing !== undefined && givenSha !== undefined && givenSha !== existing) {
      sendJson(ctx, res, 409, { message: 'Conflict' });
      return true;
    }
    const content = typeof body.content === 'string' ? body.content : '';
    const bytes = Buffer.from(content.replace(/[\r\n\t ]+/g, ''), 'base64');
    const blobSha = repo.writeObject('blob', bytes);
    files.set(filePath, blobSha);
    const tree = writeTree(repo, files);
    store.commitSeq += 1;
    const commitSha = createCommit(repo, tree, tip === null ? [] : [tip], message, 1_762_905_600 + store.commitSeq);
    repo.refs.set(refName, commitSha);
    bumpRefsVersion(repo);
    const slash = filePath.lastIndexOf('/');
    sendJson(ctx, res, existing === undefined ? 201 : 200, {
      content: {
        type: 'file',
        name: slash < 0 ? filePath : filePath.slice(slash + 1),
        path: filePath,
        sha: blobSha,
        size: bytes.length,
        encoding: 'base64',
      },
      commit: { sha: commitSha, message },
    });
    return true;
  }

  return false;
}

// ---------------------------------------------------------------- the server

export function createApp(): Server {
  const ctx: Ctx = { store: new Store(), token: process.env.MAKEFUN_SHOP_TOKEN ?? '' };
  const { store } = ctx;

  const authorized = (req: IncomingMessage): boolean => {
    if (ctx.token === '') return true; // local runs without a token configured
    return req.headers.authorization === `Bearer ${ctx.token}`;
  };

  const resolveRepo = (ownerSeg: string, name: string): Repo | null => {
    const repo = store.repos.get(name);
    if (repo === undefined) return null;
    return store.ownerMatches(ownerSeg, repo) ? repo : null;
  };

  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    void (async () => {
      const url = new URL(req.url ?? '/', 'http://entry');
      const path = url.pathname;
      const method = req.method ?? 'GET';

      // Boot probe: no token, called twice by the env.
      if (method === 'GET' && path === '/healthz') {
        sendJson(ctx, res, 200, { ok: true });
        return;
      }

      // ------------------------------------------------ git smart HTTP
      const gitMatch = /^\/([^/]+)\/([^/]+)\.git\/(info\/refs|git-upload-pack|git-receive-pack)$/.exec(path);
      if (gitMatch !== null) {
        const [, ownerSeg, repoName, tail] = gitMatch as unknown as [string, string, string, string];
        const repo = store.repos.get(repoName);
        // Protocol v2 is negotiated per request through the Git-Protocol header and
        // exists only for upload-pack; receive-pack is v0 whatever the header says.
        const wantsV2 = (req.headers['git-protocol'] ?? '').includes('version=2');
        if (tail === 'info/refs' && method === 'GET') {
          const service = url.searchParams.get('service');
          if (repo === undefined || (service !== 'git-upload-pack' && service !== 'git-receive-pack')) {
            sendRaw(res, 404, Buffer.from('not found\n'), 'text/plain');
            return;
          }
          if (!store.ownerMatches(ownerSeg, repo)) {
            sendRaw(res, 404, Buffer.from('not found\n'), 'text/plain');
            return;
          }
          const body = service === 'git-upload-pack' && wantsV2 ? advertisementV2() : advertisement(repo, service);
          sendRaw(res, 200, body, `application/x-${service}-advertisement`);
          return;
        }
        if (method === 'POST' && (tail === 'git-upload-pack' || tail === 'git-receive-pack')) {
          if (repo === undefined || !store.ownerMatches(ownerSeg, repo)) {
            sendRaw(res, 404, Buffer.from('not found\n'), 'text/plain');
            return;
          }
          const body = await readBody(req);
          const out =
            tail === 'git-receive-pack'
              ? receivePack(repo, body)
              : wantsV2
                ? uploadPackV2(repo, body)
                : uploadPack(repo, body);
          sendRaw(res, 200, out, `application/x-${tail}-result`);
          return;
        }
        sendRaw(res, 404, Buffer.from('not found\n'), 'text/plain');
        return;
      }

      // ------------------------------------------------ everything below needs the token
      const isApi = path === '/api/v3' || path.startsWith('/api/v3/') || path === '/api/graphql' || path === '/mcp';
      if (isApi && !authorized(req)) {
        sendJson(ctx, res, 401, { message: 'Unauthorized' });
        return;
      }

      // ------------------------------------------------ REST v3
      if (path === '/api/v3' || path === '/api/v3/') {
        if (method === 'GET') {
          sendJson(ctx, res, 200, { current_user_url: '/api/v3/user', rate_limit_url: '/api/v3/rate_limit' }, { 'x-oauth-scopes': 'repo, read:org' });
          return;
        }
      }

      if (path === '/api/v3/meta' && method === 'GET') {
        sendJson(ctx, res, 200, { installed_version: '1.0.0' });
        return;
      }

      if (path === '/api/v3/user' && method === 'GET') {
        sendJson(ctx, res, 200, { login: store.login(), id: 1000, type: 'User' });
        return;
      }

      if (path === '/api/v3/user/repos' && method === 'POST') {
        const raw = await readBody(req);
        let body: Record<string, unknown>;
        try {
          body = JSON.parse(raw.toString('utf8')) as Record<string, unknown>;
        } catch {
          sendJson(ctx, res, 400, { message: 'Problems parsing JSON' });
          return;
        }
        const name = typeof body.name === 'string' ? body.name : '';
        if (name === '') {
          sendJson(ctx, res, 422, { message: 'Repository creation failed.' });
          return;
        }
        const repo = store.createRepo(name);
        if (repo === null) {
          // GitHub's wording, and load-bearing: the env's git client tolerates a 422 on
          // re-creating a repository only when the body says the name already exists —
          // the GraphQL fixture pushes its branches through that client against a
          // repository the REST fixture already created.
          sendJson(ctx, res, 422, {
            message: 'Repository creation failed: name already exists on this account',
            errors: [{ resource: 'Repository', code: 'custom', field: 'name', message: 'name already exists on this account' }],
          });
          return;
        }
        repo.isPrivate = body.private === true;
        repo.description = typeof body.description === 'string' ? body.description : '';
        sendJson(ctx, res, 201, repoJson(ctx, repo));
        return;
      }

      if (path === '/api/v3/user/repos' && method === 'GET') {
        const perPage = Math.max(1, Number.parseInt(url.searchParams.get('per_page') ?? '30', 10) || 30);
        const page = Math.max(1, Number.parseInt(url.searchParams.get('page') ?? '1', 10) || 1);
        const all = [...store.repos.values()];
        const slice = all.slice((page - 1) * perPage, page * perPage);
        const headers: Record<string, string> = {};
        if (page * perPage < all.length) {
          const host = req.headers.host ?? 'entry';
          headers.link = `<http://${host}/api/v3/user/repos?per_page=${perPage}&page=${page + 1}>; rel="next"`;
        }
        sendJson(ctx, res, 200, slice.map((repo) => repoJson(ctx, repo)), headers);
        return;
      }

      const repoMatch = /^\/api\/v3\/repos\/([^/]+)\/([^/]+)(\/.*)?$/.exec(path);
      if (repoMatch !== null) {
        const [, ownerSeg, repoName, tailRaw] = repoMatch as unknown as [string, string, string, string | undefined];
        const tail = tailRaw ?? '';
        const repo = resolveRepo(ownerSeg, repoName);
        if (repo === null) {
          sendJson(ctx, res, 404, { message: 'Not Found' });
          return;
        }
        if (tail === '' || tail === '/') {
          if (method === 'GET') {
            sendJson(ctx, res, 200, repoJson(ctx, repo));
            return;
          }
          if (method === 'PATCH') {
            const raw = await readBody(req);
            try {
              const body = JSON.parse(raw.toString('utf8')) as Record<string, unknown>;
              if (typeof body.description === 'string') repo.description = body.description;
              if (typeof body.private === 'boolean') repo.isPrivate = body.private;
            } catch {
              sendJson(ctx, res, 400, { message: 'Problems parsing JSON' });
              return;
            }
            sendJson(ctx, res, 200, repoJson(ctx, repo));
            return;
          }
          if (method === 'DELETE') {
            store.repos.delete(repo.name);
            store.requestSeq += 1;
            res.writeHead(204, { 'x-github-request-id': `FORGE-${store.requestSeq}` });
            res.end();
            return;
          }
        }
        if (tail === '/labels' && method === 'POST') {
          const body = await readJsonBody(req);
          if (body === null) {
            sendJson(ctx, res, 400, { message: 'Problems parsing JSON' });
            return;
          }
          const name = typeof body.name === 'string' ? body.name : '';
          if (name === '' || repo.labels.has(name)) {
            sendJson(ctx, res, 422, { message: 'Validation Failed' });
            return;
          }
          const color = typeof body.color === 'string' ? body.color : 'ededed';
          repo.labels.set(name, color);
          sendJson(ctx, res, 201, { id: repo.labels.size, name, color, default: false });
          return;
        }
        if (tail === '/labels' && method === 'GET') {
          sendJson(ctx, res, 200, [...repo.labels.entries()].map(([name, color]) => ({ name, color, default: false })));
          return;
        }
        if (tail === '/issues' && method === 'POST') {
          const body = await readJsonBody(req);
          if (body === null) {
            sendJson(ctx, res, 400, { message: 'Problems parsing JSON' });
            return;
          }
          const labelNames = Array.isArray(body.labels) ? body.labels.filter((x): x is string => typeof x === 'string') : [];
          if (labelNames.some((name) => !repo.labels.has(name))) {
            sendJson(ctx, res, 422, { message: 'Validation Failed' });
            return;
          }
          const issue: Issue = {
            id: store.nextIssueId,
            number: repo.nextIssueNumber,
            title: typeof body.title === 'string' ? body.title : '',
            body: typeof body.body === 'string' ? body.body : '',
            state: 'open',
            labels: labelNames,
            comments: [],
          };
          store.nextIssueId += 1;
          repo.nextIssueNumber += 1;
          repo.issues.push(issue);
          sendJson(ctx, res, 201, issueJson(repo, issue));
          return;
        }
        if (tail === '/issues' && method === 'GET') {
          const state = url.searchParams.get('state') ?? 'open';
          const direction = url.searchParams.get('direction') ?? 'desc';
          const perPage = Math.max(1, Number.parseInt(url.searchParams.get('per_page') ?? '30', 10) || 30);
          const page = Math.max(1, Number.parseInt(url.searchParams.get('page') ?? '1', 10) || 1);
          const list = repo.issues.filter((issue) => state === 'all' || issue.state === state);
          // Issues are stored in creation order and numbers increment with creation, so
          // sorting by number is sorting by creation, in either direction.
          list.sort((a, b) => (direction === 'asc' ? a.number - b.number : b.number - a.number));
          sendJson(ctx, res, 200, list.slice((page - 1) * perPage, page * perPage).map((issue) => issueJson(repo, issue)));
          return;
        }
        const issueMatch = /^\/issues\/(\d+)(\/comments)?$/.exec(tail);
        if (issueMatch !== null) {
          const number = Number.parseInt(issueMatch[1] as string, 10);
          const issue = repo.issues.find((candidate) => candidate.number === number);
          if (issue === undefined) {
            sendJson(ctx, res, 404, { message: 'Not Found' });
            return;
          }
          if (issueMatch[2] === '/comments') {
            if (method === 'GET') {
              sendJson(ctx, res, 200, issue.comments.map(commentJson));
              return;
            }
            if (method === 'POST') {
              const body = await readJsonBody(req);
              if (body === null) {
                sendJson(ctx, res, 400, { message: 'Problems parsing JSON' });
                return;
              }
              const comment = { id: store.nextCommentId, body: typeof body.body === 'string' ? body.body : '' };
              store.nextCommentId += 1;
              issue.comments.push(comment);
              sendJson(ctx, res, 201, commentJson(comment));
              return;
            }
          } else {
            if (method === 'GET') {
              sendJson(ctx, res, 200, issueJson(repo, issue));
              return;
            }
            if (method === 'PATCH') {
              const body = await readJsonBody(req);
              if (body === null) {
                sendJson(ctx, res, 400, { message: 'Problems parsing JSON' });
                return;
              }
              if (Array.isArray(body.labels)) {
                const labelNames = body.labels.filter((x): x is string => typeof x === 'string');
                if (labelNames.some((name) => !repo.labels.has(name))) {
                  sendJson(ctx, res, 422, { message: 'Validation Failed' });
                  return;
                }
                issue.labels = labelNames;
              }
              if (body.state === 'open' || body.state === 'closed') issue.state = body.state;
              if (typeof body.title === 'string') issue.title = body.title;
              if (typeof body.body === 'string') issue.body = body.body;
              sendJson(ctx, res, 200, issueJson(repo, issue));
              return;
            }
          }
        }
        if (tail === '/pulls' && method === 'POST') {
          const body = await readJsonBody(req);
          if (body === null) {
            sendJson(ctx, res, 400, { message: 'Problems parsing JSON' });
            return;
          }
          const head = typeof body.head === 'string' ? branchName(body.head) : '';
          const base = typeof body.base === 'string' && body.base !== '' ? branchName(body.base) : repo.defaultBranch;
          if (head === '' || head === base) {
            sendJson(ctx, res, 422, { message: 'Validation Failed' });
            return;
          }
          const pull = openPullRequest(store, repo, {
            title: typeof body.title === 'string' ? body.title : '',
            body: typeof body.body === 'string' ? body.body : '',
            head,
            base,
          });
          if (pull === null) {
            sendJson(ctx, res, 422, { message: 'Validation Failed' });
            return;
          }
          sendJson(ctx, res, 201, pullJson(ctx, repo, pull));
          return;
        }
        if (tail === '/pulls' && method === 'GET') {
          const state = url.searchParams.get('state') ?? 'open';
          const perPage = Math.max(1, Number.parseInt(url.searchParams.get('per_page') ?? '30', 10) || 30);
          const page = Math.max(1, Number.parseInt(url.searchParams.get('page') ?? '1', 10) || 1);
          const list = repo.pulls.filter((pull) => state === 'all' || pull.state === state);
          list.sort((a, b) => b.number - a.number);
          sendJson(ctx, res, 200, list.slice((page - 1) * perPage, page * perPage).map((pull) => pullJson(ctx, repo, pull)));
          return;
        }
        const pullMatch = /^\/pulls\/(\d+)(\/files|\/merge)?$/.exec(tail);
        if (pullMatch !== null) {
          const number = Number.parseInt(pullMatch[1] as string, 10);
          const pull = repo.pulls.find((candidate) => candidate.number === number);
          if (pull === undefined) {
            sendJson(ctx, res, 404, { message: 'Not Found' });
            return;
          }
          const sub = pullMatch[2] ?? '';
          if (sub === '/files' && method === 'GET') {
            sendJson(ctx, res, 200, pullFiles(repo, pull));
            return;
          }
          if (sub === '/merge' && method === 'PUT') {
            const raw = await readBody(req);
            if (raw.length > 0) {
              try {
                JSON.parse(raw.toString('utf8'));
              } catch {
                sendJson(ctx, res, 400, { message: 'Problems parsing JSON' });
                return;
              }
            }
            const result = mergePullRequest(store, repo, pull);
            if (!result.ok) {
              sendJson(ctx, res, 405, { message: result.reason === 'conflict' ? 'Pull Request is not mergeable: merge conflict' : 'Pull Request is not mergeable' });
              return;
            }
            sendJson(ctx, res, 200, { sha: result.sha, merged: true, message: 'Pull Request successfully merged' });
            return;
          }
          if (sub === '') {
            if (method === 'GET') {
              sendJson(ctx, res, 200, pullJson(ctx, repo, pull));
              return;
            }
            if (method === 'PATCH') {
              const body = await readJsonBody(req);
              if (body === null) {
                sendJson(ctx, res, 400, { message: 'Problems parsing JSON' });
                return;
              }
              if (typeof body.title === 'string') pull.title = body.title;
              if (typeof body.body === 'string') pull.body = body.body;
              if (body.state === 'closed' && pull.state === 'open') pull.state = 'closed';
              if (body.state === 'open' && pull.state === 'closed' && !pull.merged) pull.state = 'open';
              sendJson(ctx, res, 200, pullJson(ctx, repo, pull));
              return;
            }
          }
        }
        if (tail === '/git/refs' && method === 'POST') {
          const body = await readJsonBody(req);
          if (body === null) {
            sendJson(ctx, res, 400, { message: 'Problems parsing JSON' });
            return;
          }
          const ref = typeof body.ref === 'string' ? body.ref : '';
          const sha = typeof body.sha === 'string' ? body.sha : '';
          const target = repo.objects.get(sha);
          if (!ref.startsWith('refs/') || target === undefined || target.type !== 'commit') {
            sendJson(ctx, res, 422, { message: 'Validation Failed' });
            return;
          }
          if (repo.refs.has(ref)) {
            sendJson(ctx, res, 422, { message: 'Reference already exists' });
            return;
          }
          repo.refs.set(ref, sha);
          bumpRefsVersion(repo);
          sendJson(ctx, res, 201, { ref, object: { sha, type: 'commit' } });
          return;
        }
        if (tail === '/branches' && method === 'GET') {
          const branches = [...repo.refs.entries()]
            .filter(([ref]) => ref.startsWith('refs/heads/'))
            .map(([ref, sha]) => ({ name: ref.slice('refs/heads/'.length), commit: { sha }, protected: false }))
            .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
          sendJson(ctx, res, 200, branches);
          return;
        }
        if (tail === '/commits' && method === 'GET') {
          const tip = resolveTip(repo, url.searchParams.get('sha') ?? undefined);
          const commits: Record<string, unknown>[] = [];
          if (tip !== null) {
            const seen = new Set<string>();
            const queue = [tip];
            while (queue.length > 0) {
              const sha = queue.shift() as string;
              if (seen.has(sha)) continue;
              const obj = repo.objects.get(sha);
              if (obj === undefined || obj.type !== 'commit') continue;
              seen.add(sha);
              commits.push({ sha, commit: { message: commitMessage(obj.data) } });
              queue.push(...parseCommit(obj.data).parents);
            }
          }
          sendJson(ctx, res, 200, commits);
          return;
        }
        if (tail.startsWith('/contents/')) {
          const filePath = tail
            .slice('/contents/'.length)
            .split('/')
            .map((piece) => {
              try {
                return decodeURIComponent(piece);
              } catch {
                return piece;
              }
            })
            .join('/');
          const handled = await contentsRoute(ctx, res, repo, filePath, method, req, url);
          if (handled) return;
        }
        sendJson(ctx, res, 404, { message: 'Not Found' });
        return;
      }

      // ------------------------------------------------ GraphQL v4
      if (path === '/api/graphql' && method === 'POST') {
        const raw = await readBody(req);
        let parsed: unknown;
        try {
          parsed = JSON.parse(raw.toString('utf8'));
        } catch {
          sendJson(ctx, res, 400, { errors: [{ message: 'Problems parsing JSON' }] });
          return;
        }
        // The executor runs over the same store and the same pull-request operations as
        // REST and MCP, so the surfaces can never disagree about an object.
        const deps: GraphQLDeps = {
          store,
          resolveRepo,
          openPull: (repo, input) => openPullRequest(store, repo, input),
          mergePull: (repo, pull) => {
            const result = mergePullRequest(store, repo, pull);
            return { ok: result.ok };
          },
          pullFiles: (repo, pull) => pullFiles(repo, pull),
          squashKind: (repo, pull) => squashTree(repo, pull).kind,
        };
        // A JSON array body is GitHub's operation batching: one envelope per operation,
        // in request order. Anything else is a single operation document.
        if (Array.isArray(parsed)) {
          sendJson(ctx, res, 200, parsed.map((entry) => executeGraphQLOperation(deps, entry)));
          return;
        }
        sendJson(ctx, res, 200, executeGraphQLOperation(deps, parsed));
        return;
      }

      // ------------------------------------------------ MCP
      if (path === '/mcp' && method === 'POST') {
        const raw = await readBody(req);
        let rpc: Record<string, unknown>;
        try {
          rpc = JSON.parse(raw.toString('utf8')) as Record<string, unknown>;
        } catch {
          sendJson(ctx, res, 400, { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } });
          return;
        }
        const id = rpc.id ?? null;
        const rpcMethod = typeof rpc.method === 'string' ? rpc.method : '';
        const params = (typeof rpc.params === 'object' && rpc.params !== null ? rpc.params : {}) as Record<string, unknown>;
        const reply = (result: unknown): void => sendJson(ctx, res, 200, { jsonrpc: '2.0', id, result });
        const replyError = (code: number, message: string): void =>
          sendJson(ctx, res, 200, { jsonrpc: '2.0', id, error: { code, message } });

        if (rpcMethod.startsWith('notifications/')) {
          res.writeHead(202);
          res.end();
          return;
        }
        if (rpcMethod === 'initialize') {
          const requested = typeof params.protocolVersion === 'string' ? params.protocolVersion : '2025-11-25';
          reply({ protocolVersion: requested, capabilities: { tools: {} }, serverInfo: { name: 'forge', version: '0.1.0' } });
          return;
        }
        if (rpcMethod === 'server/discover') {
          reply({
            supportedVersions: ['2026-07-28', '2025-11-25'],
            capabilities: { tools: {} },
            serverInfo: { name: 'forge', version: '0.1.0' },
          });
          return;
        }
        if (rpcMethod === 'ping') {
          reply({});
          return;
        }
        if (rpcMethod === 'tools/list') {
          reply({ tools: MCP_TOOLS });
          return;
        }
        if (rpcMethod === 'tools/call') {
          const toolName = typeof params.name === 'string' ? params.name : '';
          const args = (typeof params.arguments === 'object' && params.arguments !== null ? params.arguments : {}) as Record<string, unknown>;
          const bare = (toolName.includes('__') ? toolName.slice(toolName.lastIndexOf('__') + 2) : toolName).toLowerCase();
          const known = MCP_TOOLS.some((tool) => tool.name === bare);
          if (!known) {
            replyError(-32602, `unknown tool: ${toolName}`);
            return;
          }
          if (bare === 'create_repo') {
            const name = typeof args.name === 'string' ? args.name : '';
            if (name === '') {
              reply(toolError('create_repo requires a name'));
              return;
            }
            const repo = store.createRepo(name);
            if (repo === null) {
              reply(toolError(`repository ${name} already exists`));
              return;
            }
            repo.isPrivate = args.private === true;
            repo.description = typeof args.description === 'string' ? args.description : '';
            reply(toolText(repoJson(ctx, repo)));
            return;
          }
          if (bare === 'get_repo') {
            const target = toolRepoArgs(args);
            const repo = target === null ? null : resolveRepo(target.owner, target.repo);
            reply(repo === null ? toolError('repository not found') : toolText(repoJson(ctx, repo)));
            return;
          }
          if (bare === 'create_issue') {
            const target = toolRepoArgs(args);
            const repo = target === null ? null : resolveRepo(target.owner, target.repo);
            if (repo === null) {
              reply(toolError('repository not found'));
              return;
            }
            if (typeof args.title !== 'string' || args.title === '') {
              reply(toolError('create_issue requires a title'));
              return;
            }
            const issue: Issue = {
              id: store.nextIssueId,
              number: repo.nextIssueNumber,
              title: args.title,
              body: typeof args.body === 'string' ? args.body : '',
              state: 'open',
              labels: [],
              comments: [],
            };
            store.nextIssueId += 1;
            repo.nextIssueNumber += 1;
            repo.issues.push(issue);
            reply(toolText(issueJson(repo, issue)));
            return;
          }
          if (bare === 'list_issues') {
            const target = toolRepoArgs(args);
            const repo = target === null ? null : resolveRepo(target.owner, target.repo);
            if (repo === null) {
              reply(toolError('repository not found'));
              return;
            }
            const state = typeof args.state === 'string' ? args.state : 'open';
            const list = repo.issues.filter((issue) => state === 'all' || issue.state === state);
            reply(toolText(list.map((issue) => issueJson(repo, issue))));
            return;
          }
          if (bare === 'create_pull_request') {
            const target = toolRepoArgs(args);
            const repo = target === null ? null : resolveRepo(target.owner, target.repo);
            if (repo === null) {
              reply(toolError('repository not found'));
              return;
            }
            const title = typeof args.title === 'string' ? args.title : '';
            const head = typeof args.head === 'string' ? branchName(args.head) : '';
            const base = typeof args.base === 'string' && args.base !== '' ? branchName(args.base) : repo.defaultBranch;
            if (title === '' || head === '' || head === base) {
              reply(toolError('create_pull_request requires a title and a head branch different from the base'));
              return;
            }
            const pull = openPullRequest(store, repo, {
              title,
              body: typeof args.body === 'string' ? args.body : '',
              head,
              base,
            });
            if (pull === null) {
              reply(toolError('head or base branch not found'));
              return;
            }
            reply(toolText(pullJson(ctx, repo, pull)));
            return;
          }
          if (bare === 'merge_pull_request') {
            const target = toolRepoArgs(args);
            const repo = target === null ? null : resolveRepo(target.owner, target.repo);
            if (repo === null) {
              reply(toolError('repository not found'));
              return;
            }
            const number = typeof args.pull_number === 'number' ? args.pull_number : typeof args.number === 'number' ? args.number : Number.NaN;
            const pull = repo.pulls.find((candidate) => candidate.number === number);
            if (pull === undefined) {
              reply(toolError('pull request not found'));
              return;
            }
            const result = mergePullRequest(store, repo, pull);
            if (!result.ok) {
              reply(toolError(result.reason === 'conflict' ? 'merge conflict' : 'pull request is not mergeable'));
              return;
            }
            reply(toolText({ ...pullJson(ctx, repo, pull), sha: result.sha }));
            return;
          }
          reply(toolError(`tool ${bare} is not implemented yet`));
          return;
        }
        replyError(-32601, `method not found: ${rpcMethod}`);
        return;
      }

      // ------------------------------------------------ everything else
      sendJson(ctx, res, 404, { message: 'Not Found' });
    })().catch((err: unknown) => {
      if (!res.headersSent) {
        sendJson(ctx, res, 500, { message: err instanceof Error ? err.message : String(err) });
      } else {
        res.end();
      }
    });
  });
  // Keep pooled client sockets alive across a whole benchmark phase (the defaults
  // close an idle socket after 5 s, which costs a reconnect whenever the env pauses
  // between workloads); headers still get a bounded minute, requests five minutes.
  server.keepAliveTimeout = 30_000;
  server.headersTimeout = 60_000;
  return server;
}
