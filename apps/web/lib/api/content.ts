/**
 * Browser-side calls added by the content surfaces (artifacts, skills, memory
 * paging and artifact-version paging).
 *
 * Like `browser.ts`, every call goes to the same-origin `/api/**` BFF; the
 * backend origin and session cookie stay server-side. Writers carry the
 * synchronizer CSRF token. These helpers only move the request and its typed
 * answer; the caller decides what a success means and never invents a record.
 */
import { ChatRequestError } from './browser';
import type {
  ArtifactDetailEnvelopeDto,
  ArtifactKind,
  ArtifactStatus,
  ArtifactVersionListDto,
  MemoryListDto,
  SkillDto,
} from './types';

export interface ArtifactCreateInput {
  readonly kind: ArtifactKind;
  readonly title: string;
  readonly content: string;
  /** Binds the record to the conversation that is open. */
  readonly conversationId?: string | null;
  readonly runId?: string | null;
  readonly status?: Extract<ArtifactStatus, 'draft' | 'final'>;
}

export interface SkillCreateInput {
  readonly name: string;
  readonly description?: string;
  readonly bodyMarkdown: string;
  /** Null or absent creates an owner-level library entry. */
  readonly botId?: string | null;
  readonly status?: Extract<SkillDto['status'], 'draft' | 'active'>;
}

export interface CursorQuery {
  readonly limit?: number;
  readonly cursor?: string;
}

function readErrorCode(value: unknown): string | undefined {
  if (typeof value !== 'object' || value === null) {
    return undefined;
  }

  const error = (value as { error?: unknown }).error;

  if (typeof error !== 'object' || error === null) {
    return undefined;
  }

  const code = (error as { code?: unknown }).code;

  return typeof code === 'string' ? code : undefined;
}

function writeHeaders(csrfToken: string | undefined): Record<string, string> {
  const headers: Record<string, string> = { 'content-type': 'application/json' };

  if (csrfToken !== undefined && csrfToken.length > 0) {
    headers['x-csrf-token'] = csrfToken;
  }

  return headers;
}

function queryPath(path: string, params: object): string {
  const search = new URLSearchParams();

  for (const [key, value] of Object.entries(params)) {
    if (typeof value === 'string' || typeof value === 'number') {
      search.set(key, String(value));
    }
  }

  const query = search.toString();

  return query.length === 0 ? path : `${path}?${query}`;
}

async function requestJson<T>(path: string, init: RequestInit): Promise<T> {
  let response: Response;

  try {
    response = await fetch(path, {
      ...init,
      credentials: 'same-origin',
      cache: 'no-store',
    });
  } catch {
    throw new ChatRequestError('api_unavailable', 0);
  }

  const body: unknown = await response.json().catch(() => undefined);

  if (!response.ok) {
    throw new ChatRequestError(readErrorCode(body) ?? 'request_failed', response.status);
  }

  if (body === undefined) {
    throw new ChatRequestError('request_failed', response.status);
  }

  return body as T;
}

/** `POST /api/artifacts` → 201 with the new artifact and its version-1 body. */
export function createArtifact(
  input: ArtifactCreateInput,
  csrfToken: string | undefined,
): Promise<ArtifactDetailEnvelopeDto> {
  return requestJson<ArtifactDetailEnvelopeDto>('/api/artifacts', {
    method: 'POST',
    headers: writeHeaders(csrfToken),
    body: JSON.stringify(input),
  });
}

/** One cursor page of version metadata, newest version first. */
export function readArtifactVersionPage(
  artifactId: string,
  query: CursorQuery = {},
): Promise<ArtifactVersionListDto> {
  return requestJson<ArtifactVersionListDto>(
    queryPath(`/api/artifacts/${encodeURIComponent(artifactId)}/versions`, query),
    { method: 'GET', headers: { accept: 'application/json' } },
  );
}

/** One cursor page of the Bot's memory records. */
export function readMemoryPage(
  botId: string,
  query: CursorQuery = {},
): Promise<MemoryListDto> {
  return requestJson<MemoryListDto>(
    queryPath(`/api/bots/${encodeURIComponent(botId)}/memories`, query),
    { method: 'GET', headers: { accept: 'application/json' } },
  );
}

/** `POST /api/skills` → 201 with the new skill. */
export function createSkill(
  input: SkillCreateInput,
  csrfToken: string | undefined,
): Promise<{ skill: SkillDto }> {
  return requestJson<{ skill: SkillDto }>('/api/skills', {
    method: 'POST',
    headers: writeHeaders(csrfToken),
    body: JSON.stringify(input),
  });
}

/** The partial body for `PATCH /api/skills/:skillId`; omitted fields keep their value. */
export interface SkillUpdateInput {
  readonly name?: string;
  readonly description?: string;
  readonly bodyMarkdown?: string;
}

/** `PATCH /api/skills/:skillId` → 200 with the skill at its new version. */
export function updateSkill(
  skillId: string,
  input: SkillUpdateInput,
  csrfToken: string | undefined,
): Promise<{ skill: SkillDto }> {
  return requestJson<{ skill: SkillDto }>(
    `/api/skills/${encodeURIComponent(skillId)}`,
    {
      method: 'PATCH',
      headers: writeHeaders(csrfToken),
      body: JSON.stringify(input),
    },
  );
}
