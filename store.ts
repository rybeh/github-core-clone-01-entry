// The forge's own store: repositories, their git objects and refs, issues and labels.
// Everything lives in memory and is built only from suite requests, in request order, with
// counters instead of clocks so a replayed trial walks the exact same states.

import { createHash } from 'node:crypto';

export type GitObjectType = 'commit' | 'tree' | 'blob' | 'tag';

export interface GitObject {
  readonly type: GitObjectType;
  /** The object's raw content (for a commit/tree, the git serialisation; for a blob, the file bytes). */
  readonly data: Buffer;
}

/** The git object id: sha1 of "<type> <length>\0" followed by the content. */
export function objectId(type: GitObjectType, data: Buffer): string {
  const hash = createHash('sha1');
  hash.update(`${type} ${data.length}\0`, 'utf8');
  hash.update(data);
  return hash.digest('hex');
}

export interface IssueComment {
  id: number;
  body: string;
}

export interface Issue {
  id: number;
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  labels: string[];
  comments: IssueComment[];
}

export interface PullRequest {
  id: number;
  /** Per-repository number, drawn from the same sequence as issue numbers (as on GitHub). */
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  /** Branch names (without the refs/heads/ prefix). */
  headRef: string;
  baseRef: string;
  /** Branch tips at creation time; reads prefer the live tips when the refs still exist. */
  headSha: string;
  baseSha: string;
  merged: boolean;
  /** ISO timestamp of the merge commit, derived from the store's commit sequence. */
  mergedAt: string | null;
  mergeCommitSha: string | null;
}

export class Repo {
  readonly id: number;
  readonly name: string;
  description = '';
  isPrivate = false;
  defaultBranch = 'main';
  /** sha hex -> object, every object this repository holds. */
  readonly objects = new Map<string, GitObject>();
  /** Full ref name (refs/heads/main) -> commit sha hex. */
  readonly refs = new Map<string, string>();
  readonly issues: Issue[] = [];
  readonly pulls: PullRequest[] = [];
  /** Label name -> color, in creation order. A label must exist here before an issue carries it. */
  readonly labels = new Map<string, string>();
  /** The next issue/pull-request number: one sequence per repository, as on GitHub. */
  nextIssueNumber = 1;

  constructor(id: number, name: string) {
    this.id = id;
    this.name = name;
  }

  headRef(): string {
    return `refs/heads/${this.defaultBranch}`;
  }

  writeObject(type: GitObjectType, data: Buffer): string {
    const sha = objectId(type, data);
    if (!this.objects.has(sha)) this.objects.set(sha, { type, data });
    return sha;
  }
}

export class Store {
  /** Repositories by name (names are unique for the one token login). */
  readonly repos = new Map<string, Repo>();
  /**
   * The login the trial's token names. The suite never sends it directly: it is bound lazily
   * from the first {owner} path segment that addresses an existing repository (see
   * ownerMatches), which is the only channel the wire contract leaves open.
   */
  viewerLogin: string | null = null;
  nextRepoId = 1;
  nextIssueId = 1;
  nextPullId = 1;
  nextCommentId = 1;
  /**
   * Sequence for the timestamps written into REST-created commits. Commit objects need a
   * timestamp; a counter over a fixed epoch keeps the bytes (and therefore the shas the
   * checks compare) identical between a live trial and its replay — no wall clock in state.
   */
  commitSeq = 0;
  /** Monotonic counter for X-GitHub-Request-Id values: non-empty, and replay-stable. */
  requestSeq = 0;

  createRepo(name: string): Repo | null {
    if (this.repos.has(name)) return null;
    const repo = new Repo(this.nextRepoId, name);
    this.nextRepoId += 1;
    this.repos.set(name, repo);
    return repo;
  }

  /**
   * Whether `segment` may address `repo` as its owner. The first segment that addresses an
   * existing repository binds as the viewer login; after that, any other segment is a 404.
   */
  ownerMatches(segment: string, repo: Repo): boolean {
    void repo;
    if (this.viewerLogin === null) {
      this.viewerLogin = segment;
      return true;
    }
    return segment === this.viewerLogin;
  }

  /** The login to render in owner fields: the bound login, or a placeholder before binding. */
  login(): string {
    return this.viewerLogin ?? 'viewer';
  }
}
