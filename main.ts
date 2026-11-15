// main.ts — the forge's process entrypoint.
//
// The grading environment runs this file and steers it over plain HTTP:
//
//   1. The environment's origin arrives in the MAKEFUN_ENV_URL variable.
//      With no origin there is nobody to report to, so the process refuses
//      to start at all.
//   2. The forge server (built by createApp in app.ts) binds port 0, which
//      lets the kernel hand out a free ephemeral port. Port 8080 belongs to
//      the environment and is never touched.
//   3. The bound port is announced with POST /register and a {"port": N}
//      JSON body. The environment remembers the caller by that request, so
//      the first successful registration is the one that counts.
//   4. GET /done is polled until it answers {"done": true}. Only then is
//      the trial over: the server closes and the process exits 0.
//
// Registration and polling both tolerate a slow or still-starting
// environment: a request that fails, times out, or gets an unexpected
// status is retried after a growing pause. Two statuses are different —
// a 400 or 405 from /register means the request itself breaks the
// contract, so retrying could never help and the process fails fast.

import { createApp } from './app.ts';

/** Longest a single call to the environment may run before it is cut off and retried. */
const CALL_DEADLINE_MS = 30_000;
/** Pause after the first failed attempt; each further failure doubles it. */
const FIRST_PAUSE_MS = 300;
/** The retry pause never grows past this, however many attempts fail. */
const LONGEST_PAUSE_MS = 2_500;

/** The environment origin with any trailing slashes removed, or '' when unset. */
function environmentOrigin(): string {
  const raw = process.env.MAKEFUN_ENV_URL;
  return raw === undefined ? '' : raw.replace(/\/+$/, '');
}

function pause(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

/** How long to wait before the next attempt, given how many have already failed. */
function pauseAfter(failures: number): number {
  const doubled = FIRST_PAUSE_MS * 2 ** Math.min(failures, 6);
  return doubled > LONGEST_PAUSE_MS ? LONGEST_PAUSE_MS : doubled;
}

/** One call to the environment, abandoned once CALL_DEADLINE_MS passes. */
async function callEnvironment(url: string, init: RequestInit): Promise<Response> {
  const cutoff = new AbortController();
  const timer = setTimeout(() => {
    cutoff.abort();
  }, CALL_DEADLINE_MS);
  try {
    return await fetch(url, { ...init, signal: cutoff.signal });
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Announce the bound port until the environment takes it. A 200 means the
 * registration landed; a 409 means one already did, which leaves nothing
 * to fix here. Contract refusals (400, 405) throw. Everything else — a
 * refused connection, a timeout, a stray status — is retried.
 */
async function announcePort(origin: string, port: number): Promise<void> {
  let failures = 0;
  for (;;) {
    let status: number | null = null;
    try {
      const reply = await callEnvironment(`${origin}/register`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ port }),
      });
      status = reply.status;
    } catch {
      status = null; // unreachable or cut off: the environment is not ready yet
    }
    if (status === 200 || status === 409) return;
    if (status === 400 || status === 405) {
      throw new Error(`the environment refused registration with HTTP ${status}`);
    }
    await pause(pauseAfter(failures));
    failures += 1;
  }
}

/** Poll the environment's /done endpoint and return only once it reports the trial finished. */
async function awaitTrialEnd(origin: string): Promise<void> {
  let failures = 0;
  for (;;) {
    let finished = false;
    try {
      const reply = await callEnvironment(`${origin}/done`, { method: 'GET' });
      if (reply.ok) {
        const payload: unknown = await reply.json();
        finished =
          typeof payload === 'object' &&
          payload !== null &&
          (payload as { done?: unknown }).done === true;
      }
    } catch {
      finished = false; // no answer yet means the trial is still running
    }
    if (finished) return;
    await pause(pauseAfter(failures));
    failures += 1;
  }
}

/** Start the forge, register its port, and keep it alive until the environment ends the trial. */
async function boot(): Promise<void> {
  const origin = environmentOrigin();
  if (origin === '') {
    throw new Error('MAKEFUN_ENV_URL is not set, so there is no environment to register with');
  }

  const server = createApp();
  const port = await new Promise<number>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, () => {
      const bound = server.address();
      if (bound === null || typeof bound === 'string') {
        reject(new Error('the forge server did not bind a TCP port'));
      } else {
        resolve(bound.port);
      }
    });
  });
  console.log(`forge listening on port ${port}`);

  await announcePort(origin, port);
  console.log('registered with the environment; waiting for the trial to end');

  await awaitTrialEnd(origin);
  server.close();
  console.log('trial done; forge stopped');
}

boot().then(
  () => {
    process.exit(0);
  },
  (err: unknown) => {
    console.error(`[forge] ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  },
);
