// The GraphQL v4 surface: a small parser for the document subset gh and github-mcp-server
// send, a schema registry rich enough for their introspection probes, and an executor over
// the same store REST and MCP use. Nothing here is a canned answer: every field resolves
// against the live store, so a mutation made over GraphQL reads back over REST (and the
// reverse) because both surfaces share the one set of objects in store.ts.
//
// Global ids are base64 "<Type>:<store id>" — opaque (never the plain number the
// global-id-stability check rejects), stable (derived from the store's counters, no clock),
// and decodable, because the mutation inputs (repositoryId, issueId, pullRequestId,
// subjectId) are exactly those ids handed back.

import type { Issue, PullRequest, Repo, Store } from './store.ts';

export interface PullFileInfo {
  filename: string;
  status: string;
  additions: number;
  deletions: number;
}

/** The store operations the executor needs, supplied by app.ts over its own helpers. */
export interface GraphQLDeps {
  store: Store;
  resolveRepo(owner: string, name: string): Repo | null;
  openPull(repo: Repo, input: { title: string; body: string; head: string; base: string }): PullRequest | null;
  mergePull(repo: Repo, pull: PullRequest): { ok: boolean };
  pullFiles(repo: Repo, pull: PullRequest): PullFileInfo[];
  squashKind(repo: Repo, pull: PullRequest): 'ok' | 'conflict' | 'missing';
}

// ------------------------------------------------------------------ global ids

function globalId(type: string, id: number): string {
  return Buffer.from(`${type}:${id}`, 'utf8').toString('base64');
}

function parseGlobalId(raw: unknown): { type: string; id: number } | null {
  if (typeof raw !== 'string' || raw === '') return null;
  const text = Buffer.from(raw, 'base64').toString('utf8');
  const match = /^([A-Za-z]+):(\d+)$/.exec(text);
  if (match === null) return null;
  return { type: match[1] as string, id: Number.parseInt(match[2] as string, 10) };
}

function repoByNumericId(deps: GraphQLDeps, id: number): Repo | null {
  for (const repo of deps.store.repos.values()) if (repo.id === id) return repo;
  return null;
}

function findIssue(deps: GraphQLDeps, storeId: number): { repo: Repo; issue: Issue } | null {
  for (const repo of deps.store.repos.values()) {
    const issue = repo.issues.find((candidate) => candidate.id === storeId);
    if (issue !== undefined) return { repo, issue };
  }
  return null;
}

function findPull(deps: GraphQLDeps, storeId: number): { repo: Repo; pull: PullRequest } | null {
  for (const repo of deps.store.repos.values()) {
    const pull = repo.pulls.find((candidate) => candidate.id === storeId);
    if (pull !== undefined) return { repo, pull };
  }
  return null;
}

// ------------------------------------------------------------------ schema registry

interface ArgDef {
  name: string;
  type: string;
  defaultValue?: string;
}

interface FieldDef {
  name: string;
  type: string;
  args?: ArgDef[];
}

type TypeKind = 'OBJECT' | 'INTERFACE' | 'ENUM' | 'INPUT_OBJECT' | 'SCALAR';

interface TypeDef {
  kind: TypeKind;
  name: string;
  fields?: FieldDef[];
  enumValues?: string[];
  inputFields?: ArgDef[];
  interfaces?: string[];
  possibleTypes?: string[];
}

const field = (name: string, type: string, args?: ArgDef[]): FieldDef => ({ name, type, args });
const arg = (name: string, type: string): ArgDef => ({ name, type });

const TYPES: Record<string, TypeDef> = {};
function define(def: TypeDef): void {
  TYPES[def.name] = def;
}

define({ kind: 'SCALAR', name: 'String' });
define({ kind: 'SCALAR', name: 'Int' });
define({ kind: 'SCALAR', name: 'Float' });
define({ kind: 'SCALAR', name: 'Boolean' });
define({ kind: 'SCALAR', name: 'ID' });

define({ kind: 'ENUM', name: 'IssueState', enumValues: ['OPEN', 'CLOSED'] });
define({ kind: 'ENUM', name: 'PullRequestState', enumValues: ['OPEN', 'CLOSED', 'MERGED'] });
define({ kind: 'ENUM', name: 'MergeableState', enumValues: ['MERGEABLE', 'CONFLICTING', 'UNKNOWN'] });
define({ kind: 'ENUM', name: 'PullRequestMergeMethod', enumValues: ['MERGE', 'SQUASH', 'REBASE'] });
define({ kind: 'ENUM', name: 'RepositoryPermission', enumValues: ['ADMIN', 'MAINTAIN', 'WRITE', 'TRIAGE', 'READ'] });
define({ kind: 'ENUM', name: 'IssueOrderField', enumValues: ['CREATED_AT', 'UPDATED_AT', 'COMMENTS'] });
define({ kind: 'ENUM', name: 'OrderDirection', enumValues: ['ASC', 'DESC'] });
define({ kind: 'ENUM', name: 'SearchType', enumValues: ['ISSUE', 'REPOSITORY', 'USER', 'DISCUSSION'] });
define({
  kind: 'ENUM',
  name: '__DirectiveLocation',
  enumValues: ['QUERY', 'MUTATION', 'SUBSCRIPTION', 'FIELD', 'FRAGMENT_DEFINITION', 'FRAGMENT_SPREAD', 'INLINE_FRAGMENT', 'SCHEMA', 'FIELD_DEFINITION', 'ARGUMENT_DEFINITION', 'INPUT_FIELD_DEFINITION'],
});

define({
  kind: 'INTERFACE',
  name: 'Node',
  fields: [field('id', 'ID!')],
  possibleTypes: ['Repository', 'Issue', 'PullRequest', 'IssueComment', 'User'],
});

define({
  kind: 'OBJECT',
  name: 'Query',
  fields: [
    field('viewer', 'User!'),
    field('repository', 'Repository', [arg('owner', 'String!'), arg('name', 'String!')]),
    field('node', 'Node', [arg('id', 'ID!')]),
    field('__type', '__Type', [arg('name', 'String!')]),
    field('__schema', '__Schema!'),
  ],
});

define({
  kind: 'OBJECT',
  name: 'Mutation',
  fields: [
    field('createIssue', 'CreateIssuePayload', [arg('input', 'CreateIssueInput!')]),
    field('closeIssue', 'CloseIssuePayload', [arg('input', 'CloseIssueInput!')]),
    field('createPullRequest', 'CreatePullRequestPayload', [arg('input', 'CreatePullRequestInput!')]),
    field('mergePullRequest', 'MergePullRequestPayload', [arg('input', 'MergePullRequestInput!')]),
    field('addComment', 'AddCommentPayload', [arg('input', 'AddCommentInput!')]),
  ],
});

define({
  kind: 'OBJECT',
  name: 'User',
  interfaces: ['Node'],
  fields: [field('id', 'ID!'), field('login', 'String!'), field('name', 'String'), field('url', 'String')],
});

define({ kind: 'OBJECT', name: 'Ref', fields: [field('name', 'String!'), field('prefix', 'String!')] });

define({
  kind: 'OBJECT',
  name: 'Repository',
  interfaces: ['Node'],
  fields: [
    field('id', 'ID!'),
    field('databaseId', 'Int!'),
    field('name', 'String!'),
    field('nameWithOwner', 'String!'),
    field('owner', 'User!'),
    field('defaultBranchRef', 'Ref'),
    field('viewerPermission', 'RepositoryPermission'),
    field('hasIssuesEnabled', 'Boolean!'),
    field('description', 'String'),
    field('isPrivate', 'Boolean!'),
    field('url', 'String'),
    field('issue', 'Issue', [arg('number', 'Int!')]),
    field('issues', 'IssueConnection!', [
      arg('first', 'Int'),
      arg('after', 'String'),
      arg('states', '[IssueState!]'),
      arg('orderBy', 'IssueOrder'),
    ]),
    field('pullRequest', 'PullRequest', [arg('number', 'Int!')]),
    field('pullRequests', 'PullRequestConnection!', [arg('first', 'Int'), arg('states', '[PullRequestState!]')]),
  ],
});

define({
  kind: 'OBJECT',
  name: 'Issue',
  interfaces: ['Node'],
  fields: [
    field('id', 'ID!'),
    field('number', 'Int!'),
    field('title', 'String!'),
    field('state', 'IssueState!'),
    field('body', 'String'),
    field('url', 'String'),
  ],
});

define({
  kind: 'OBJECT',
  name: 'IssueConnection',
  fields: [field('nodes', '[Issue]'), field('edges', '[IssueEdge]'), field('pageInfo', 'PageInfo!'), field('totalCount', 'Int!')],
});
define({ kind: 'OBJECT', name: 'IssueEdge', fields: [field('node', 'Issue'), field('cursor', 'String!')] });
define({
  kind: 'OBJECT',
  name: 'PageInfo',
  fields: [
    field('hasNextPage', 'Boolean!'),
    field('hasPreviousPage', 'Boolean!'),
    field('startCursor', 'String'),
    field('endCursor', 'String'),
  ],
});

define({
  kind: 'OBJECT',
  name: 'PullRequest',
  interfaces: ['Node'],
  fields: [
    field('id', 'ID!'),
    field('number', 'Int!'),
    field('title', 'String!'),
    field('body', 'String'),
    field('state', 'PullRequestState!'),
    field('merged', 'Boolean!'),
    field('mergeable', 'MergeableState!'),
    field('headRefName', 'String!'),
    field('baseRefName', 'String!'),
    field('files', 'PullRequestChangedFileConnection!', [arg('first', 'Int')]),
    field('url', 'String'),
  ],
});

define({
  kind: 'OBJECT',
  name: 'PullRequestConnection',
  fields: [field('nodes', '[PullRequest]'), field('pageInfo', 'PageInfo!'), field('totalCount', 'Int!')],
});
define({
  kind: 'OBJECT',
  name: 'PullRequestChangedFileConnection',
  fields: [field('nodes', '[PullRequestChangedFile]'), field('totalCount', 'Int!')],
});
define({
  kind: 'OBJECT',
  name: 'PullRequestChangedFile',
  fields: [field('path', 'String!'), field('additions', 'Int!'), field('deletions', 'Int!'), field('changeType', 'String')],
});

define({
  kind: 'OBJECT',
  name: 'IssueComment',
  interfaces: ['Node'],
  fields: [field('id', 'ID!'), field('body', 'String')],
});
define({ kind: 'OBJECT', name: 'CommentEdge', fields: [field('node', 'IssueComment'), field('cursor', 'String!')] });

define({
  kind: 'OBJECT',
  name: 'CreateIssuePayload',
  fields: [field('issue', 'Issue'), field('clientMutationId', 'String')],
});
define({
  kind: 'OBJECT',
  name: 'CloseIssuePayload',
  fields: [field('issue', 'Issue'), field('clientMutationId', 'String')],
});
define({
  kind: 'OBJECT',
  name: 'CreatePullRequestPayload',
  fields: [field('pullRequest', 'PullRequest'), field('clientMutationId', 'String')],
});
define({
  kind: 'OBJECT',
  name: 'MergePullRequestPayload',
  fields: [field('pullRequest', 'PullRequest'), field('clientMutationId', 'String')],
});
define({
  kind: 'OBJECT',
  name: 'AddCommentPayload',
  fields: [field('commentEdge', 'CommentEdge'), field('subject', 'Node'), field('clientMutationId', 'String')],
});

define({
  kind: 'INPUT_OBJECT',
  name: 'CreateIssueInput',
  inputFields: [arg('repositoryId', 'ID!'), arg('title', 'String!'), arg('body', 'String'), arg('clientMutationId', 'String')],
});
define({
  kind: 'INPUT_OBJECT',
  name: 'CloseIssueInput',
  inputFields: [arg('issueId', 'ID!'), arg('clientMutationId', 'String')],
});
define({
  kind: 'INPUT_OBJECT',
  name: 'CreatePullRequestInput',
  inputFields: [
    arg('repositoryId', 'ID!'),
    arg('baseRefName', 'String!'),
    arg('headRefName', 'String!'),
    arg('title', 'String!'),
    arg('body', 'String'),
    arg('draft', 'Boolean'),
    arg('clientMutationId', 'String'),
  ],
});
define({
  kind: 'INPUT_OBJECT',
  name: 'MergePullRequestInput',
  inputFields: [
    arg('pullRequestId', 'ID!'),
    arg('mergeMethod', 'PullRequestMergeMethod'),
    arg('commitHeadline', 'String'),
    arg('clientMutationId', 'String'),
  ],
});
define({
  kind: 'INPUT_OBJECT',
  name: 'AddCommentInput',
  inputFields: [arg('subjectId', 'ID!'), arg('body', 'String!'), arg('clientMutationId', 'String')],
});
define({
  kind: 'INPUT_OBJECT',
  name: 'IssueOrder',
  inputFields: [arg('field', 'IssueOrderField!'), arg('direction', 'OrderDirection!')],
});

// Introspection types, modelled in the same registry so __type can describe them too.
define({
  kind: 'OBJECT',
  name: '__Schema',
  fields: [
    field('types', '[__Type!]!'),
    field('queryType', '__Type!'),
    field('mutationType', '__Type'),
    field('subscriptionType', '__Type'),
    field('directives', '[__Directive!]!'),
  ],
});
define({
  kind: 'OBJECT',
  name: '__Type',
  fields: [
    field('kind', 'String!'),
    field('name', 'String'),
    field('description', 'String'),
    field('fields', '[__Field]', [arg('includeDeprecated', 'Boolean')]),
    field('enumValues', '[__EnumValue]', [arg('includeDeprecated', 'Boolean')]),
    field('inputFields', '[__InputValue]'),
    field('interfaces', '[__Type]'),
    field('possibleTypes', '[__Type]'),
    field('ofType', '__Type'),
    field('specifiedByURL', 'String'),
  ],
});
define({
  kind: 'OBJECT',
  name: '__Field',
  fields: [
    field('name', 'String!'),
    field('description', 'String'),
    field('args', '[__InputValue!]!'),
    field('type', '__Type!'),
    field('isDeprecated', 'Boolean!'),
    field('deprecationReason', 'String'),
  ],
});
define({
  kind: 'OBJECT',
  name: '__InputValue',
  fields: [field('name', 'String!'), field('description', 'String'), field('type', '__Type!'), field('defaultValue', 'String')],
});
define({
  kind: 'OBJECT',
  name: '__EnumValue',
  fields: [field('name', 'String!'), field('description', 'String'), field('isDeprecated', 'Boolean!'), field('deprecationReason', 'String')],
});
define({
  kind: 'OBJECT',
  name: '__Directive',
  fields: [
    field('name', 'String!'),
    field('description', 'String'),
    field('locations', '[__DirectiveLocation!]!'),
    field('args', '[__InputValue!]!'),
  ],
});

// ------------------------------------------------------------------ type references

type TypeRef = { kind: 'named'; name: string } | { kind: 'list'; ofType: TypeRef } | { kind: 'nonNull'; ofType: TypeRef };

function parseTypeRef(text: string): TypeRef {
  let i = 0;
  const parse = (): TypeRef => {
    let inner: TypeRef;
    if (text[i] === '[') {
      i += 1;
      const of = parse();
      i += 1; // ']'
      inner = { kind: 'list', ofType: of };
    } else {
      const match = /^[A-Za-z_][A-Za-z0-9_]*/.exec(text.slice(i));
      const name = match === null ? '' : match[0];
      i += name.length;
      inner = { kind: 'named', name };
    }
    if (text[i] === '!') {
      i += 1;
      return { kind: 'nonNull', ofType: inner };
    }
    return inner;
  };
  return parse();
}

/** The introspection kind of a type reference: LIST / NON_NULL, else the named type's kind. */
function kindOf(ref: TypeRef): string {
  if (ref.kind === 'list') return 'LIST';
  if (ref.kind === 'nonNull') return 'NON_NULL';
  return TYPES[ref.name]?.kind ?? 'SCALAR';
}

// ------------------------------------------------------------------ lexer

interface Token {
  kind: 'name' | 'int' | 'float' | 'string' | 'punct' | 'eof';
  value: string;
}

const PUNCT = new Set(['!', '$', '&', '(', ')', ':', '=', '@', '[', ']', '{', '}', '|']);

function lex(source: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  const isNameStart = (c: string): boolean => /[A-Za-z_]/.test(c);
  const isNameChar = (c: string): boolean => /[A-Za-z0-9_]/.test(c);
  while (i < source.length) {
    const c = source[i] as string;
    if (c === ' ' || c === '\t' || c === '\n' || c === '\r' || c === ',' || c === '﻿') {
      i += 1;
      continue;
    }
    if (c === '#') {
      while (i < source.length && source[i] !== '\n') i += 1;
      continue;
    }
    if (c === '.' && source.startsWith('...', i)) {
      tokens.push({ kind: 'punct', value: '...' });
      i += 3;
      continue;
    }
    if (PUNCT.has(c)) {
      tokens.push({ kind: 'punct', value: c });
      i += 1;
      continue;
    }
    if (c === '"') {
      if (source.startsWith('"""', i)) {
        const end = source.indexOf('"""', i + 3);
        const text = end < 0 ? source.slice(i + 3) : source.slice(i + 3, end);
        tokens.push({ kind: 'string', value: text });
        i = end < 0 ? source.length : end + 3;
        continue;
      }
      let j = i + 1;
      let out = '';
      while (j < source.length && source[j] !== '"') {
        if (source[j] === '\\') {
          const esc = source[j + 1] as string;
          if (esc === 'n') out += '\n';
          else if (esc === 't') out += '\t';
          else if (esc === 'r') out += '\r';
          else if (esc === 'b') out += '\b';
          else if (esc === 'f') out += '\f';
          else if (esc === '/') out += '/';
          else if (esc === '\\') out += '\\';
          else if (esc === '"') out += '"';
          else if (esc === 'u') {
            out += String.fromCharCode(Number.parseInt(source.slice(j + 2, j + 6), 16));
            j += 4;
          } else out += esc;
          j += 2;
        } else {
          out += source[j];
          j += 1;
        }
      }
      tokens.push({ kind: 'string', value: out });
      i = j + 1;
      continue;
    }
    if (/[0-9-]/.test(c)) {
      let j = i;
      if (source[j] === '-') j += 1;
      while (j < source.length && /[0-9]/.test(source[j] as string)) j += 1;
      let isFloat = false;
      if (source[j] === '.') {
        isFloat = true;
        j += 1;
        while (j < source.length && /[0-9]/.test(source[j] as string)) j += 1;
      }
      if (source[j] === 'e' || source[j] === 'E') {
        isFloat = true;
        j += 1;
        if (source[j] === '+' || source[j] === '-') j += 1;
        while (j < source.length && /[0-9]/.test(source[j] as string)) j += 1;
      }
      tokens.push({ kind: isFloat ? 'float' : 'int', value: source.slice(i, j) });
      i = j;
      continue;
    }
    if (isNameStart(c)) {
      let j = i;
      while (j < source.length && isNameChar(source[j] as string)) j += 1;
      tokens.push({ kind: 'name', value: source.slice(i, j) });
      i = j;
      continue;
    }
    throw new Error(`GraphQL syntax error: unexpected character ${JSON.stringify(c)}`);
  }
  tokens.push({ kind: 'eof', value: '' });
  return tokens;
}

// ------------------------------------------------------------------ parser

type ValueNode =
  | { kind: 'variable'; name: string }
  | { kind: 'int' | 'float' | 'string' | 'enum'; value: string }
  | { kind: 'boolean'; value: boolean }
  | { kind: 'null' }
  | { kind: 'list'; values: ValueNode[] }
  | { kind: 'object'; fields: { name: string; value: ValueNode }[] };

interface ArgumentNode {
  name: string;
  value: ValueNode;
}

interface DirectiveNode {
  name: string;
  args: ArgumentNode[];
}

interface FieldNode {
  kind: 'field';
  alias: string | null;
  name: string;
  args: ArgumentNode[];
  directives: DirectiveNode[];
  selectionSet: SelectionNode[] | null;
}

type SelectionNode =
  | FieldNode
  | { kind: 'inline'; typeCondition: string | null; directives: DirectiveNode[]; selectionSet: SelectionNode[] }
  | { kind: 'spread'; name: string; directives: DirectiveNode[] };

interface OperationNode {
  operation: 'query' | 'mutation';
  name: string | null;
  variableDefaults: Map<string, ValueNode>;
  selectionSet: SelectionNode[];
}

interface FragmentNode {
  typeCondition: string;
  selectionSet: SelectionNode[];
}

interface DocumentNode {
  operations: OperationNode[];
  fragments: Map<string, FragmentNode>;
}

class Parser {
  private pos = 0;
  private readonly tokens: Token[];

  constructor(tokens: Token[]) {
    this.tokens = tokens;
  }

  private peek(): Token {
    return this.tokens[this.pos] as Token;
  }

  private next(): Token {
    const token = this.tokens[this.pos] as Token;
    this.pos += 1;
    return token;
  }

  private atPunct(value: string): boolean {
    const token = this.peek();
    return token.kind === 'punct' && token.value === value;
  }

  private expectPunct(value: string): void {
    if (!this.atPunct(value)) throw new Error(`GraphQL syntax error: expected "${value}", got "${this.peek().value}"`);
    this.pos += 1;
  }

  private expectName(): string {
    const token = this.next();
    if (token.kind !== 'name') throw new Error(`GraphQL syntax error: expected a name, got "${token.value}"`);
    return token.value;
  }

  parseDocument(): DocumentNode {
    const operations: OperationNode[] = [];
    const fragments = new Map<string, FragmentNode>();
    while (this.peek().kind !== 'eof') {
      if (this.atPunct('{')) {
        operations.push({
          operation: 'query',
          name: null,
          variableDefaults: new Map(),
          selectionSet: this.parseSelectionSet(),
        });
        continue;
      }
      const keyword = this.expectName();
      if (keyword === 'query' || keyword === 'mutation' || keyword === 'subscription') {
        let name: string | null = null;
        if (this.peek().kind === 'name') name = this.next().value;
        const variableDefaults = new Map<string, ValueNode>();
        if (this.atPunct('(')) this.parseVariableDefinitions(variableDefaults);
        this.parseDirectives();
        operations.push({
          operation: keyword === 'mutation' ? 'mutation' : 'query',
          name,
          variableDefaults,
          selectionSet: this.parseSelectionSet(),
        });
        continue;
      }
      if (keyword === 'fragment') {
        const fragName = this.expectName();
        const onKeyword = this.expectName();
        if (onKeyword !== 'on') throw new Error(`GraphQL syntax error: expected "on" in fragment ${fragName}`);
        const typeCondition = this.expectName();
        this.parseDirectives();
        fragments.set(fragName, { typeCondition, selectionSet: this.parseSelectionSet() });
        continue;
      }
      throw new Error(`GraphQL syntax error: unexpected definition "${keyword}"`);
    }
    return { operations, fragments };
  }

  private parseVariableDefinitions(defaults: Map<string, ValueNode>): void {
    this.expectPunct('(');
    while (!this.atPunct(')')) {
      this.expectPunct('$');
      const name = this.expectName();
      this.expectPunct(':');
      this.parseType();
      if (this.atPunct('=')) {
        this.pos += 1;
        defaults.set(name, this.parseValue());
      }
      this.parseDirectives();
    }
    this.expectPunct(')');
  }

  private parseType(): void {
    if (this.atPunct('[')) {
      this.pos += 1;
      this.parseType();
      this.expectPunct(']');
    } else {
      this.expectName();
    }
    if (this.atPunct('!')) this.pos += 1;
  }

  private parseDirectives(): DirectiveNode[] {
    const directives: DirectiveNode[] = [];
    while (this.atPunct('@')) {
      this.pos += 1;
      const name = this.expectName();
      const args = this.atPunct('(') ? this.parseArguments() : [];
      directives.push({ name, args });
    }
    return directives;
  }

  private parseArguments(): ArgumentNode[] {
    const args: ArgumentNode[] = [];
    this.expectPunct('(');
    while (!this.atPunct(')')) {
      const name = this.expectName();
      this.expectPunct(':');
      args.push({ name, value: this.parseValue() });
    }
    this.expectPunct(')');
    return args;
  }

  private parseValue(): ValueNode {
    const token = this.peek();
    if (token.kind === 'punct' && token.value === '$') {
      this.pos += 1;
      return { kind: 'variable', name: this.expectName() };
    }
    if (token.kind === 'punct' && token.value === '[') {
      this.pos += 1;
      const values: ValueNode[] = [];
      while (!this.atPunct(']')) values.push(this.parseValue());
      this.expectPunct(']');
      return { kind: 'list', values };
    }
    if (token.kind === 'punct' && token.value === '{') {
      this.pos += 1;
      const fields: { name: string; value: ValueNode }[] = [];
      while (!this.atPunct('}')) {
        const name = this.expectName();
        this.expectPunct(':');
        fields.push({ name, value: this.parseValue() });
      }
      this.expectPunct('}');
      return { kind: 'object', fields };
    }
    this.pos += 1;
    if (token.kind === 'int') return { kind: 'int', value: token.value };
    if (token.kind === 'float') return { kind: 'float', value: token.value };
    if (token.kind === 'string') return { kind: 'string', value: token.value };
    if (token.kind === 'name') {
      if (token.value === 'true') return { kind: 'boolean', value: true };
      if (token.value === 'false') return { kind: 'boolean', value: false };
      if (token.value === 'null') return { kind: 'null' };
      return { kind: 'enum', value: token.value };
    }
    throw new Error(`GraphQL syntax error: unexpected value "${token.value}"`);
  }

  private parseSelectionSet(): SelectionNode[] {
    const selections: SelectionNode[] = [];
    this.expectPunct('{');
    while (!this.atPunct('}')) selections.push(this.parseSelection());
    this.expectPunct('}');
    return selections;
  }

  private parseSelection(): SelectionNode {
    if (this.atPunct('...')) {
      this.pos += 1;
      if (this.peek().kind === 'name' && this.peek().value === 'on') {
        this.pos += 1;
        const typeCondition = this.expectName();
        const directives = this.parseDirectives();
        return { kind: 'inline', typeCondition, directives, selectionSet: this.parseSelectionSet() };
      }
      if (this.peek().kind === 'name') {
        const name = this.next().value;
        const directives = this.parseDirectives();
        return { kind: 'spread', name, directives };
      }
      const directives = this.parseDirectives();
      return { kind: 'inline', typeCondition: null, directives, selectionSet: this.parseSelectionSet() };
    }
    let name = this.expectName();
    let alias: string | null = null;
    if (this.atPunct(':')) {
      this.pos += 1;
      alias = name;
      name = this.expectName();
    }
    const args = this.atPunct('(') ? this.parseArguments() : [];
    const directives = this.parseDirectives();
    const selectionSet = this.atPunct('{') ? this.parseSelectionSet() : null;
    return { kind: 'field', alias, name, args, directives, selectionSet };
  }
}

// ------------------------------------------------------------------ executor

/** A resolved object value, tagged with its runtime GraphQL type. */
interface Box {
  type: string;
  value: unknown;
}

const box = (type: string, value: unknown): Box => ({ type, value });

interface ExecCtx {
  deps: GraphQLDeps;
  variables: Record<string, unknown>;
  fragments: Map<string, FragmentNode>;
  errors: { message: string }[];
}

function resolveValue(node: ValueNode, ctx: ExecCtx): unknown {
  switch (node.kind) {
    case 'variable':
      return ctx.variables[node.name];
    case 'int':
    case 'float':
      return Number(node.value);
    case 'string':
    case 'enum':
      return node.value;
    case 'boolean':
      return node.value;
    case 'null':
      return null;
    case 'list':
      return node.values.map((value) => resolveValue(value, ctx));
    case 'object': {
      const out: Record<string, unknown> = {};
      for (const entry of node.fields) out[entry.name] = resolveValue(entry.value, ctx);
      return out;
    }
  }
}

/** Whether a field survives its @skip/@include directives. */
function directivesAllow(directives: DirectiveNode[], ctx: ExecCtx): boolean {
  for (const directive of directives) {
    const ifArg = directive.args.find((entry) => entry.name === 'if');
    const flag = ifArg === undefined ? undefined : resolveValue(ifArg.value, ctx);
    if (directive.name === 'skip' && flag === true) return false;
    if (directive.name === 'include' && flag === false) return false;
  }
  return true;
}

function typeConditionMatches(condition: string, runtimeType: string): boolean {
  if (condition === runtimeType) return true;
  const conditionDef = TYPES[condition];
  if (conditionDef?.possibleTypes?.includes(runtimeType)) return true;
  const runtimeDef = TYPES[runtimeType];
  return runtimeDef?.interfaces?.includes(condition) ?? false;
}

/** Flatten a selection set against a runtime type: fragments expanded, order preserved. */
function collectFields(selections: SelectionNode[], runtimeType: string, ctx: ExecCtx, out: FieldNode[]): void {
  for (const selection of selections) {
    if (!directivesAllow(selection.directives, ctx)) continue;
    if (selection.kind === 'field') {
      out.push(selection);
    } else if (selection.kind === 'inline') {
      if (selection.typeCondition === null || typeConditionMatches(selection.typeCondition, runtimeType)) {
        collectFields(selection.selectionSet, runtimeType, ctx, out);
      }
    } else {
      const fragment = ctx.fragments.get(selection.name);
      if (fragment !== undefined && typeConditionMatches(fragment.typeCondition, runtimeType)) {
        collectFields(fragment.selectionSet, runtimeType, ctx, out);
      }
    }
  }
}

type Resolver = (source: any, args: Record<string, unknown>, ctx: ExecCtx) => unknown;

const asRecord = (value: unknown): Record<string, unknown> =>
  typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {};

function issueBox(found: { repo: Repo; issue: Issue }): Box {
  return box('Issue', found);
}

function pullBox(found: { repo: Repo; pull: PullRequest }): Box {
  return box('PullRequest', found);
}

/** The connection cursor for one issue: an opaque string over its number. */
function cursorFor(number: number): string {
  return Buffer.from(`cursor:${number}`, 'utf8').toString('base64');
}

function numberFromCursor(raw: unknown): number | null {
  if (typeof raw !== 'string' || raw === '') return null;
  const match = /^cursor:(\d+)$/.exec(Buffer.from(raw, 'base64').toString('utf8'));
  return match === null ? null : Number.parseInt(match[1] as string, 10);
}

function nodeByGlobalId(ctx: ExecCtx, raw: unknown): Box | null {
  const parsed = parseGlobalId(raw);
  if (parsed === null) return null;
  if (parsed.type === 'Repository') {
    const repo = repoByNumericId(ctx.deps, parsed.id);
    return repo === null ? null : box('Repository', repo);
  }
  if (parsed.type === 'Issue') {
    const found = findIssue(ctx.deps, parsed.id);
    return found === null ? null : issueBox(found);
  }
  if (parsed.type === 'PullRequest') {
    const found = findPull(ctx.deps, parsed.id);
    return found === null ? null : pullBox(found);
  }
  if (parsed.type === 'User') return box('User', { login: ctx.deps.store.login() });
  if (parsed.type === 'IssueComment') {
    for (const repo of ctx.deps.store.repos.values()) {
      for (const issue of repo.issues) {
        const comment = issue.comments.find((candidate) => candidate.id === parsed.id);
        if (comment !== undefined) return box('IssueComment', comment);
      }
    }
    return null;
  }
  return null;
}

function typeBox(ref: TypeRef): Box {
  return box('__Type', ref);
}

const RESOLVERS: Record<string, Record<string, Resolver>> = {
  Query: {
    viewer: (_source, _args, ctx) => box('User', { login: ctx.deps.store.login() }),
    repository: (_source, args, ctx) => {
      const repo = ctx.deps.resolveRepo(String(args.owner ?? ''), String(args.name ?? ''));
      return repo === null ? null : box('Repository', repo);
    },
    node: (_source, args, ctx) => nodeByGlobalId(ctx, args.id),
    __type: (_source, args) => {
      const def = TYPES[String(args.name ?? '')];
      return def === undefined ? null : typeBox({ kind: 'named', name: def.name });
    },
    __schema: () => box('__Schema', {}),
  },

  Mutation: {
    createIssue: (_source, args, ctx) => {
      const input = asRecord(args.input);
      const parsed = parseGlobalId(input.repositoryId);
      const repo = parsed !== null && parsed.type === 'Repository' ? repoByNumericId(ctx.deps, parsed.id) : null;
      if (repo === null) throw new Error('createIssue: repository not found');
      const { store } = ctx.deps;
      const issue: Issue = {
        id: store.nextIssueId,
        number: repo.nextIssueNumber,
        title: typeof input.title === 'string' ? input.title : '',
        body: typeof input.body === 'string' ? input.body : '',
        state: 'open',
        labels: [],
        comments: [],
      };
      store.nextIssueId += 1;
      repo.nextIssueNumber += 1;
      repo.issues.push(issue);
      return box('CreateIssuePayload', {
        issue: issueBox({ repo, issue }),
        clientMutationId: typeof input.clientMutationId === 'string' ? input.clientMutationId : null,
      });
    },
    closeIssue: (_source, args, ctx) => {
      const input = asRecord(args.input);
      const parsed = parseGlobalId(input.issueId);
      const found = parsed !== null && parsed.type === 'Issue' ? findIssue(ctx.deps, parsed.id) : null;
      if (found === null) throw new Error('closeIssue: issue not found');
      found.issue.state = 'closed';
      return box('CloseIssuePayload', {
        issue: issueBox(found),
        clientMutationId: typeof input.clientMutationId === 'string' ? input.clientMutationId : null,
      });
    },
    createPullRequest: (_source, args, ctx) => {
      const input = asRecord(args.input);
      const parsed = parseGlobalId(input.repositoryId);
      const repo = parsed !== null && parsed.type === 'Repository' ? repoByNumericId(ctx.deps, parsed.id) : null;
      if (repo === null) throw new Error('createPullRequest: repository not found');
      const pull = ctx.deps.openPull(repo, {
        title: typeof input.title === 'string' ? input.title : '',
        body: typeof input.body === 'string' ? input.body : '',
        head: typeof input.headRefName === 'string' ? input.headRefName : '',
        base: typeof input.baseRefName === 'string' ? input.baseRefName : '',
      });
      if (pull === null) throw new Error('createPullRequest: head or base branch not found');
      return box('CreatePullRequestPayload', {
        pullRequest: pullBox({ repo, pull }),
        clientMutationId: typeof input.clientMutationId === 'string' ? input.clientMutationId : null,
      });
    },
    mergePullRequest: (_source, args, ctx) => {
      const input = asRecord(args.input);
      const parsed = parseGlobalId(input.pullRequestId);
      const found = parsed !== null && parsed.type === 'PullRequest' ? findPull(ctx.deps, parsed.id) : null;
      if (found === null) throw new Error('mergePullRequest: pull request not found');
      const result = ctx.deps.mergePull(found.repo, found.pull);
      if (!result.ok) throw new Error('mergePullRequest: pull request is not mergeable');
      return box('MergePullRequestPayload', {
        pullRequest: pullBox(found),
        clientMutationId: typeof input.clientMutationId === 'string' ? input.clientMutationId : null,
      });
    },
    addComment: (_source, args, ctx) => {
      const input = asRecord(args.input);
      const parsed = parseGlobalId(input.subjectId);
      const found = parsed !== null && parsed.type === 'Issue' ? findIssue(ctx.deps, parsed.id) : null;
      if (found === null) throw new Error('addComment: subject not found');
      const { store } = ctx.deps;
      const comment = { id: store.nextCommentId, body: typeof input.body === 'string' ? input.body : '' };
      store.nextCommentId += 1;
      found.issue.comments.push(comment);
      return box('AddCommentPayload', {
        commentEdge: box('CommentEdge', { node: box('IssueComment', comment), cursor: cursorFor(comment.id) }),
        subject: issueBox(found),
        clientMutationId: typeof input.clientMutationId === 'string' ? input.clientMutationId : null,
      });
    },
  },

  User: {
    id: () => globalId('User', 1000),
    login: (source) => (source as { login: string }).login,
    name: (source) => (source as { login: string }).login,
    url: (source) => `/${(source as { login: string }).login}`,
  },

  Ref: {
    name: (source) => (source as { name: string }).name,
    prefix: () => 'refs/heads/',
  },

  Repository: {
    id: (source) => globalId('Repository', (source as Repo).id),
    databaseId: (source) => (source as Repo).id,
    name: (source) => (source as Repo).name,
    nameWithOwner: (source, _args, ctx) => `${ctx.deps.store.login()}/${(source as Repo).name}`,
    owner: (_source, _args, ctx) => box('User', { login: ctx.deps.store.login() }),
    defaultBranchRef: (source) => {
      const repo = source as Repo;
      return repo.refs.has(`refs/heads/${repo.defaultBranch}`) ? box('Ref', { name: repo.defaultBranch }) : null;
    },
    viewerPermission: () => 'ADMIN',
    hasIssuesEnabled: () => true,
    description: (source) => (source as Repo).description,
    isPrivate: (source) => (source as Repo).isPrivate,
    url: (source, _args, ctx) => `/${ctx.deps.store.login()}/${(source as Repo).name}`,
    issue: (source, args) => {
      const repo = source as Repo;
      const issue = repo.issues.find((candidate) => candidate.number === args.number);
      return issue === undefined ? null : issueBox({ repo, issue });
    },
    issues: (source, args) => {
      const repo = source as Repo;
      const states = Array.isArray(args.states) ? (args.states as unknown[]).map((entry) => String(entry).toLowerCase()) : null;
      let list = repo.issues.filter((issue) => states === null || states.includes(issue.state));
      const orderBy = asRecord(args.orderBy);
      const direction = typeof orderBy.direction === 'string' ? orderBy.direction : 'DESC';
      list = [...list].sort((a, b) => (direction === 'ASC' ? a.number - b.number : b.number - a.number));
      const afterNumber = numberFromCursor(args.after);
      if (afterNumber !== null) {
        list = list.filter((issue) => (direction === 'ASC' ? issue.number > afterNumber : issue.number < afterNumber));
      }
      const total = list.length;
      const first = typeof args.first === 'number' ? Math.max(0, args.first) : total;
      const page = list.slice(0, first);
      const pageInfo = {
        hasNextPage: total > page.length,
        hasPreviousPage: afterNumber !== null,
        startCursor: page.length > 0 ? cursorFor((page[0] as Issue).number) : null,
        endCursor: page.length > 0 ? cursorFor((page[page.length - 1] as Issue).number) : null,
      };
      return box('IssueConnection', { repo, items: page, pageInfo, totalCount: repo.issues.length });
    },
    pullRequest: (source, args) => {
      const repo = source as Repo;
      const pull = repo.pulls.find((candidate) => candidate.number === args.number);
      return pull === undefined ? null : pullBox({ repo, pull });
    },
    pullRequests: (source, args) => {
      const repo = source as Repo;
      const states = Array.isArray(args.states) ? (args.states as unknown[]).map((entry) => String(entry)) : null;
      let list = repo.pulls.filter((pull) => {
        if (states === null) return true;
        const state = pull.merged ? 'MERGED' : pull.state === 'open' ? 'OPEN' : 'CLOSED';
        return states.includes(state);
      });
      list = [...list].sort((a, b) => b.number - a.number);
      const first = typeof args.first === 'number' ? Math.max(0, args.first) : list.length;
      const page = list.slice(0, first);
      return box('PullRequestConnection', {
        repo,
        items: page,
        pageInfo: { hasNextPage: list.length > page.length, hasPreviousPage: false, startCursor: null, endCursor: null },
        totalCount: list.length,
      });
    },
  },

  Issue: {
    id: (source) => globalId('Issue', (source as { issue: Issue }).issue.id),
    number: (source) => (source as { issue: Issue }).issue.number,
    title: (source) => (source as { issue: Issue }).issue.title,
    state: (source) => ((source as { issue: Issue }).issue.state === 'open' ? 'OPEN' : 'CLOSED'),
    body: (source) => (source as { issue: Issue }).issue.body,
    url: (source, _args, ctx) => {
      const found = source as { repo: Repo; issue: Issue };
      return `/${ctx.deps.store.login()}/${found.repo.name}/issues/${found.issue.number}`;
    },
  },

  IssueConnection: {
    nodes: (source) => {
      const conn = source as { repo: Repo; items: Issue[] };
      return conn.items.map((issue) => issueBox({ repo: conn.repo, issue }));
    },
    edges: (source) => {
      const conn = source as { repo: Repo; items: Issue[] };
      return conn.items.map((issue) => box('IssueEdge', { node: issueBox({ repo: conn.repo, issue }), cursor: cursorFor(issue.number) }));
    },
    pageInfo: (source) => box('PageInfo', (source as { pageInfo: unknown }).pageInfo),
    totalCount: (source) => (source as { totalCount: number }).totalCount,
  },

  IssueEdge: {
    node: (source) => (source as { node: Box }).node,
    cursor: (source) => (source as { cursor: string }).cursor,
  },

  PageInfo: {
    hasNextPage: (source) => (source as { hasNextPage: boolean }).hasNextPage,
    hasPreviousPage: (source) => (source as { hasPreviousPage: boolean }).hasPreviousPage,
    startCursor: (source) => (source as { startCursor: string | null }).startCursor,
    endCursor: (source) => (source as { endCursor: string | null }).endCursor,
  },

  PullRequest: {
    id: (source) => globalId('PullRequest', (source as { pull: PullRequest }).pull.id),
    number: (source) => (source as { pull: PullRequest }).pull.number,
    title: (source) => (source as { pull: PullRequest }).pull.title,
    body: (source) => (source as { pull: PullRequest }).pull.body,
    state: (source) => {
      const pull = (source as { pull: PullRequest }).pull;
      return pull.merged ? 'MERGED' : pull.state === 'open' ? 'OPEN' : 'CLOSED';
    },
    merged: (source) => (source as { pull: PullRequest }).pull.merged,
    mergeable: (source, _args, ctx) => {
      // Computed from the real squash outcome, not the open/closed flag: a pull whose
      // head-side changes collide with the moved base reports CONFLICTING, exactly what
      // the merge endpoint would answer 405 for.
      const found = source as { repo: Repo; pull: PullRequest };
      if (found.pull.merged || found.pull.state !== 'open') return 'UNKNOWN';
      const kind = ctx.deps.squashKind(found.repo, found.pull);
      return kind === 'ok' ? 'MERGEABLE' : kind === 'conflict' ? 'CONFLICTING' : 'UNKNOWN';
    },
    headRefName: (source) => (source as { pull: PullRequest }).pull.headRef,
    baseRefName: (source) => (source as { pull: PullRequest }).pull.baseRef,
    files: (source, args, ctx) => {
      const found = source as { repo: Repo; pull: PullRequest };
      const all = ctx.deps.pullFiles(found.repo, found.pull);
      const first = typeof args.first === 'number' ? Math.max(0, args.first) : all.length;
      return box('PullRequestChangedFileConnection', { files: all.slice(0, first), totalCount: all.length });
    },
    url: (source, _args, ctx) => {
      const found = source as { repo: Repo; pull: PullRequest };
      return `/${ctx.deps.store.login()}/${found.repo.name}/pull/${found.pull.number}`;
    },
  },

  PullRequestConnection: {
    nodes: (source) => {
      const conn = source as { repo: Repo; items: PullRequest[] };
      return conn.items.map((pull) => pullBox({ repo: conn.repo, pull }));
    },
    pageInfo: (source) => box('PageInfo', (source as { pageInfo: unknown }).pageInfo),
    totalCount: (source) => (source as { totalCount: number }).totalCount,
  },

  PullRequestChangedFileConnection: {
    nodes: (source) => {
      const conn = source as { files: PullFileInfo[] };
      return conn.files.map((file) => box('PullRequestChangedFile', file));
    },
    totalCount: (source) => (source as { totalCount: number }).totalCount,
  },

  PullRequestChangedFile: {
    path: (source) => (source as PullFileInfo).filename,
    additions: (source) => (source as PullFileInfo).additions,
    deletions: (source) => (source as PullFileInfo).deletions,
    changeType: (source) => {
      const status = (source as PullFileInfo).status;
      return status === 'added' ? 'ADDED' : status === 'removed' ? 'DELETED' : 'MODIFIED';
    },
  },

  IssueComment: {
    id: (source) => globalId('IssueComment', (source as { id: number }).id),
    body: (source) => (source as { body: string }).body,
  },

  CommentEdge: {
    node: (source) => (source as { node: Box }).node,
    cursor: (source) => (source as { cursor: string }).cursor,
  },

  CreateIssuePayload: {
    issue: (source) => (source as { issue: Box }).issue,
    clientMutationId: (source) => (source as { clientMutationId: string | null }).clientMutationId,
  },
  CloseIssuePayload: {
    issue: (source) => (source as { issue: Box }).issue,
    clientMutationId: (source) => (source as { clientMutationId: string | null }).clientMutationId,
  },
  CreatePullRequestPayload: {
    pullRequest: (source) => (source as { pullRequest: Box }).pullRequest,
    clientMutationId: (source) => (source as { clientMutationId: string | null }).clientMutationId,
  },
  MergePullRequestPayload: {
    pullRequest: (source) => (source as { pullRequest: Box }).pullRequest,
    clientMutationId: (source) => (source as { clientMutationId: string | null }).clientMutationId,
  },
  AddCommentPayload: {
    commentEdge: (source) => (source as { commentEdge: Box }).commentEdge,
    subject: (source) => (source as { subject: Box }).subject,
    clientMutationId: (source) => (source as { clientMutationId: string | null }).clientMutationId,
  },

  __Schema: {
    types: () => Object.values(TYPES).map((def) => typeBox({ kind: 'named', name: def.name })),
    queryType: () => typeBox({ kind: 'named', name: 'Query' }),
    mutationType: () => typeBox({ kind: 'named', name: 'Mutation' }),
    subscriptionType: () => null,
    directives: () => [],
  },

  __Type: {
    kind: (source) => kindOf(source as TypeRef),
    name: (source) => {
      const ref = source as TypeRef;
      return ref.kind === 'named' ? ref.name : null;
    },
    description: () => null,
    fields: (source) => {
      const ref = source as TypeRef;
      if (ref.kind !== 'named') return null;
      const def = TYPES[ref.name];
      if (def === undefined || (def.kind !== 'OBJECT' && def.kind !== 'INTERFACE')) return null;
      return (def.fields ?? []).map((entry) => box('__Field', entry));
    },
    enumValues: (source) => {
      const ref = source as TypeRef;
      if (ref.kind !== 'named') return null;
      const def = TYPES[ref.name];
      if (def === undefined || def.kind !== 'ENUM') return null;
      return (def.enumValues ?? []).map((name) => box('__EnumValue', { name }));
    },
    inputFields: (source) => {
      const ref = source as TypeRef;
      if (ref.kind !== 'named') return null;
      const def = TYPES[ref.name];
      if (def === undefined || def.kind !== 'INPUT_OBJECT') return null;
      return (def.inputFields ?? []).map((entry) => box('__InputValue', entry));
    },
    interfaces: (source) => {
      const ref = source as TypeRef;
      if (ref.kind !== 'named') return null;
      const def = TYPES[ref.name];
      if (def === undefined || def.kind !== 'OBJECT') return null;
      return (def.interfaces ?? []).map((name) => typeBox({ kind: 'named', name }));
    },
    possibleTypes: (source) => {
      const ref = source as TypeRef;
      if (ref.kind !== 'named') return null;
      const def = TYPES[ref.name];
      if (def === undefined || def.kind !== 'INTERFACE') return null;
      return (def.possibleTypes ?? []).map((name) => typeBox({ kind: 'named', name }));
    },
    ofType: (source) => {
      const ref = source as TypeRef;
      return ref.kind === 'named' ? null : typeBox(ref.ofType);
    },
    specifiedByURL: () => null,
  },

  __Field: {
    name: (source) => (source as FieldDef).name,
    description: () => null,
    args: (source) => ((source as FieldDef).args ?? []).map((entry) => box('__InputValue', entry)),
    type: (source) => typeBox(parseTypeRef((source as FieldDef).type)),
    isDeprecated: () => false,
    deprecationReason: () => null,
  },

  __InputValue: {
    name: (source) => (source as ArgDef).name,
    description: () => null,
    type: (source) => typeBox(parseTypeRef((source as ArgDef).type)),
    defaultValue: (source) => (source as ArgDef).defaultValue ?? null,
  },

  __EnumValue: {
    name: (source) => (source as { name: string }).name,
    description: () => null,
    isDeprecated: () => false,
    deprecationReason: () => null,
  },

  __Directive: {
    name: (source) => (source as { name: string }).name,
    description: () => null,
    locations: (source) => (source as { locations: string[] }).locations,
    args: (source) => ((source as { args: ArgDef[] }).args ?? []).map((entry) => box('__InputValue', entry)),
  },
};

function completeValue(ref: TypeRef, raw: unknown, selectionSet: SelectionNode[] | null, ctx: ExecCtx): unknown {
  if (ref.kind === 'nonNull') return completeValue(ref.ofType, raw, selectionSet, ctx);
  if (raw === null || raw === undefined) return null;
  if (ref.kind === 'list') {
    const items = Array.isArray(raw) ? raw : [raw];
    return items.map((item) => completeValue(ref.ofType, item, selectionSet, ctx));
  }
  const def = TYPES[ref.name];
  if (def === undefined || def.kind === 'SCALAR') {
    return ref.name === 'ID' ? String(raw) : raw;
  }
  if (def.kind === 'ENUM') return raw;
  const resolved = raw as Box;
  return executeSelectionSet(selectionSet ?? [], resolved, ctx);
}

function executeSelectionSet(selections: SelectionNode[], source: Box, ctx: ExecCtx): Record<string, unknown> {
  const fields: FieldNode[] = [];
  collectFields(selections, source.type, ctx, fields);
  const out: Record<string, unknown> = {};
  const typeDef = TYPES[source.type];
  for (const node of fields) {
    const key = node.alias ?? node.name;
    if (node.name === '__typename') {
      out[key] = source.type;
      continue;
    }
    const fieldDef = typeDef?.fields?.find((entry) => entry.name === node.name);
    if (fieldDef === undefined) {
      ctx.errors.push({ message: `Cannot query field "${node.name}" on type "${source.type}".` });
      out[key] = null;
      continue;
    }
    const args: Record<string, unknown> = {};
    for (const entry of node.args) {
      const value = resolveValue(entry.value, ctx);
      if (value !== undefined) args[entry.name] = value;
    }
    const resolver = RESOLVERS[source.type]?.[node.name];
    let raw: unknown = null;
    try {
      raw = resolver === undefined ? undefined : resolver(source.value, args, ctx);
    } catch (err) {
      ctx.errors.push({ message: err instanceof Error ? err.message : String(err) });
      raw = null;
    }
    out[key] = completeValue(parseTypeRef(fieldDef.type), raw, node.selectionSet, ctx);
  }
  return out;
}

/**
 * Execute one operation document (one entry of a possibly batched request body) and
 * answer the GraphQL envelope: {data} on success, {data, errors} when a field failed,
 * {errors} when the document itself could not run. Never throws.
 */
export function executeGraphQLOperation(deps: GraphQLDeps, entry: unknown): Record<string, unknown> {
  const record = asRecord(entry);
  const query = typeof record.query === 'string' ? record.query : '';
  if (query === '') return { errors: [{ message: 'GraphQL request carries no query string' }] };
  let document: DocumentNode;
  try {
    document = new Parser(lex(query)).parseDocument();
  } catch (err) {
    return { errors: [{ message: err instanceof Error ? err.message : String(err) }] };
  }
  const operationName = typeof record.operationName === 'string' ? record.operationName : null;
  let operation: OperationNode | undefined;
  if (operationName !== null) operation = document.operations.find((candidate) => candidate.name === operationName);
  else if (document.operations.length === 1) operation = document.operations[0];
  else operation = document.operations[0];
  if (operation === undefined) return { errors: [{ message: 'GraphQL document carries no operation' }] };

  const variables: Record<string, unknown> = {};
  for (const [name, valueNode] of operation.variableDefaults) {
    variables[name] = resolveValue(valueNode, { deps, variables: {}, fragments: document.fragments, errors: [] });
  }
  const provided = asRecord(record.variables);
  for (const [name, value] of Object.entries(provided)) {
    if (value !== undefined) variables[name] = value;
  }

  const ctx: ExecCtx = { deps, variables, fragments: document.fragments, errors: [] };
  const rootType = operation.operation === 'mutation' ? 'Mutation' : 'Query';
  const data = executeSelectionSet(operation.selectionSet, box(rootType, null), ctx);
  const envelope: Record<string, unknown> = { data };
  if (ctx.errors.length > 0) envelope.errors = ctx.errors;
  return envelope;
}
