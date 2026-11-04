/**
 * HTTP and SSE helpers for acceptance scenarios.
 *
 * The report never receives a cookie or CSRF value: helpers return them to the
 * caller, but evidence is built from status codes, error codes, and resource
 * ids. `redact()` is a second guard at report-write time.
 */
import { spawn } from 'node:child_process';
import { getFreePort, captureOutput, waitForLogEvent, stopChild, REPOSITORY_ROOT } from './process.mjs';
import { fileURLToPath } from 'node:url';

const API_ENTRY = fileURLToPath(
  new URL('../../../apps/backend/dist/main.js', import.meta.url),
);

export async function readBody(response) {
  const text = await response.text();

  if (text === '') {
    return undefined;
  }

  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

export function sessionFromResponse(response) {
  const setCookie = response.headers.get('set-cookie');
  const csrfToken = response.headers.get('x-csrf-token') ?? undefined;

  if (setCookie === null || setCookie === '') {
    return { cookie: undefined, csrfToken };
  }

  const cookie = setCookie.split(';')[0].trim();

  return { cookie, csrfToken };
}

/**
 * Minimal browser client. `csrf: true` sends the synchronizer token; a missing
 * token or cookie is a deliberate part of an auth test, not an error here.
 */
export function createClient(base, session = {}) {
  return async function request(path, options = {}) {
    const headers = { ...options.headers };

    if (options.cookie ?? session.cookie) {
      headers.cookie = options.cookie ?? session.cookie;
    }

    if (options.csrf === true && (options.csrfToken ?? session.csrfToken)) {
      headers['x-csrf-token'] = options.csrfToken ?? session.csrfToken;
    }

    if (options.body !== undefined) {
      headers['content-type'] = 'application/json';
    }

    if (options.userAgent !== undefined) {
      headers['user-agent'] = options.userAgent;
    }

    const response = await fetch(`${base}${path}`, {
      method: options.method ?? (options.body === undefined ? 'GET' : 'POST'),
      headers,
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
      redirect: options.redirect ?? 'manual',
      signal: options.signal ?? AbortSignal.timeout(options.timeoutMs ?? 10_000),
    });

    return {
      status: response.status,
      headers: response.headers,
      body: await readBody(response),
    };
  };
}

/** Boots the real API as a child process with an explicit flag set. */
export async function startApiChild(env, { readyEvent = 'api.ready' } = {}) {
  const port = await getFreePort();
  const clean = { ...process.env };

  for (const name of [
    'HABI_SPIKE_MODE',
    'HABI_SESSION_SPIKE',
    'HABI_SESSION_SPIKE_TEST_CLOCK',
    'HABI_AUTH_SPIKE',
    'HABI_P1_API',
    'HABI_P1_API_SSE_HEARTBEAT_MS',
    'HABI_REGISTRATION_MODE',
    'DATABASE_URL',
  ]) {
    delete clean[name];
  }

  const child = spawn(process.execPath, [API_ENTRY], {
    cwd: REPOSITORY_ROOT,
    env: {
      ...clean,
      HOST: '127.0.0.1',
      PORT: String(port),
      NODE_ENV: 'test',
      ...env,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const output = captureOutput(child);

  try {
    await waitForLogEvent(child, output, readyEvent, 25_000);
  } catch (error) {
    await stopChild(child);
    throw error;
  }

  return {
    base: `http://127.0.0.1:${port}`,
    output,
    child,
    stop: () => stopChild(child),
  };
}

function parseFrame(raw) {
  const frame = {};

  for (const line of raw.split('\n')) {
    if (line.startsWith(':')) {
      frame.comment = line.slice(1).trim();
      continue;
    }

    const separator = line.indexOf(':');

    if (separator === -1) {
      continue;
    }

    const field = line.slice(0, separator);
    const value = line.slice(separator + 1).replace(/^ /, '');

    if (field === 'id' || field === 'event') {
      frame[field] = value;
    } else if (field === 'data') {
      frame.data = value;

      try {
        frame.json = JSON.parse(value);
      } catch {
        // Keep raw data.
      }
    }
  }

  return frame;
}

/**
 * Opens an SSE connection and returns an incremental frame iterator.
 *
 * `close()` aborts the request. A caller that breaks out of `for await` also
 * cancels the reader, so a scenario cannot leak a socket into teardown.
 */
export async function openSse(base, path, { cookie, lastEventId } = {}) {
  const controller = new AbortController();
  const headers = { accept: 'text/event-stream' };

  if (cookie !== undefined) {
    headers.cookie = cookie;
  }

  if (lastEventId !== undefined) {
    headers['last-event-id'] = lastEventId;
  }

  const response = await fetch(`${base}${path}`, {
    headers,
    signal: controller.signal,
  });

  if (response.ok !== true || response.body === null) {
    return {
      ok: false,
      status: response.status,
      body: await readBody(response),
      close() {
        controller.abort();
      },
      frames: (async function* empty() {})(),
    };
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();

  async function* frames() {
    let buffer = '';

    try {
      while (true) {
        const { value, done } = await reader.read();

        if (done) {
          break;
        }

        buffer += decoder.decode(value, { stream: true });

        let boundary;
        while ((boundary = buffer.indexOf('\n\n')) !== -1) {
          const raw = buffer.slice(0, boundary);
          buffer = buffer.slice(boundary + 2);

          if (raw.trim() !== '') {
            yield parseFrame(raw);
          }
        }
      }
    } finally {
      try {
        await reader.cancel();
      } catch {
        // The connection may already be closed.
      }
    }
  }

  return {
    ok: true,
    status: response.status,
    frames: frames(),
    close() {
      controller.abort();
    },
  };
}

/** Reads a finite SSE response to completion (used where the run is terminal). */
export async function readAllSse(sse) {
  const frames = [];

  for await (const frame of sse.frames) {
    frames.push(frame);
  }

  return frames;
}
