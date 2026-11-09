'use client';

/**
 * The Bot workspace's write coordination.
 *
 * Every mutation goes through the same-origin BFF and the synchronizer CSRF
 * token; this hook owns the request, the pending/error line, and the refresh.
 * Components only render props and report intent, and no component decides
 * whether a lifecycle change is allowed.
 *
 * Context tools (artifacts, skills, search) load on demand while the Context
 * panel is open. A failed optional read stays absent and says so; it never
 * falls back to sample data.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import type {
  ArtifactDetailView,
  ArtifactFormValues,
  ArtifactMetadataFormValues,
  ArtifactSummaryView,
  ArtifactVersionView,
  MemoryGate,
  MemoryGateItem,
  SearchResultView,
  SkillFormValues,
  SkillView,
} from '../../../components/panels';
import type { BotFormValues } from '../../../components/bots';
import {
  attachSkill,
  chatErrorMessage,
  createMemory,
  createThread,
  detachSkill,
  readArtifact,
  readArtifacts,
  readCsrfToken,
  readSkills,
  renameThread,
  restoreArtifactVersion,
  searchMessages,
  setMemoryApprovals,
  updateArtifact,
  updateBot,
} from '../../../lib/api/browser';
import {
  createArtifact as postArtifact,
  createSkill as postSkill,
  readArtifactVersionPage,
  readMemoryPage,
  updateSkill,
} from '../../../lib/api/content';
import type {
  ArtifactDto,
  ArtifactVersionMetadataDto,
  MemoryDto,
  SearchHitDto,
  SkillDto,
} from '../../../lib/api/types';
import { formatWhen } from '../../../lib/api/format';
import { ARTIFACT_CONTENT_MAX_BYTES, utf8Bytes } from '../../../lib/api/limits';
import {
  SKILL_BODY_MAX_BYTES,
  SKILL_DESCRIPTION_MAX_LENGTH,
  SKILL_NAME_MAX_LENGTH,
} from '../../../components/panels';
import { threadHref } from '../../../lib/links';
import type { WorkspaceData } from './workspace-data';

type LoadState = 'idle' | 'loading' | 'ready' | 'error';

/** Rows per cursor page for artifacts, versions, skills, memories and search. */
const PAGE_SIZE = 20;

/** One cursor page's load-more state, passed straight to `PaginationFooter`. */
export interface PagingState {
  readonly hasMore: boolean;
  readonly loading: boolean;
  readonly error: string | undefined;
  readonly loadMore: () => void;
}


export interface WorkspaceActions {
  readonly botPending: boolean;
  readonly botError: string | undefined;
  readonly botStatus: string | undefined;
  readonly saveBot: (values: BotFormValues) => void;

  readonly threadPending: boolean;
  readonly threadError: string | undefined;
  readonly threadStatus: string | undefined;
  readonly createThreadForBot: (title: string | undefined) => void;
  readonly renameThreadById: (threadId: string, title: string) => void;

  readonly memoryPendingId: string | undefined;
  readonly memoryError: string | undefined;
  readonly memoryStatus: string | undefined;
  readonly toggleMemory: (
    id: string,
    gate: MemoryGate,
    next: boolean,
    nextGates: { readonly bot: boolean; readonly thread: boolean },
  ) => void;
  readonly proposeMemory: (text: string, threadId: string) => void;

  readonly memories: readonly MemoryGateItem[];
  readonly memoryPaging: PagingState;

  readonly skills: readonly SkillView[];
  readonly skillsState: LoadState;
  readonly skillsError: string | undefined;
  readonly skillPendingId: string | undefined;
  readonly attachSkillToBot: (skillId: string) => void;
  readonly detachSkillFromBot: (skillId: string) => void;
  readonly createSkillForAccount: (values: SkillFormValues) => void;
  readonly skillCreatePending: boolean;
  readonly skillCreateError: string | undefined;
  readonly skillCreateStatus: string | undefined;
  /** Edits an active or draft skill; only changed fields reach the PATCH body. */
  readonly updateSkillForAccount: (skillId: string, values: SkillFormValues) => void;
  readonly skillUpdatePendingId: string | undefined;
  readonly skillUpdateError: string | undefined;
  readonly skillUpdateStatus: string | undefined;
  readonly skillsPaging: PagingState;

  readonly artifacts: readonly ArtifactSummaryView[];
  readonly artifactsState: LoadState;
  readonly artifactDetail: ArtifactDetailView | undefined;
  readonly artifactVersions: readonly ArtifactVersionView[];
  readonly artifactBusy: 'select' | 'save' | 'restore' | undefined;
  readonly artifactError: string | undefined;
  readonly artifactStatus: string | undefined;
  readonly selectArtifact: (artifactId: string) => void;
  readonly saveArtifact: (content: string) => void;
  readonly restoreArtifact: (version: number) => void;
  readonly createArtifactForThread: (values: ArtifactFormValues) => void;
  readonly artifactCreatePending: boolean;
  readonly artifactCreateError: string | undefined;
  readonly artifactCreateStatus: string | undefined;
  /** Edits metadata only; the API preserves the content and appends a version. */
  readonly updateArtifactMetadata: (
    artifactId: string,
    values: ArtifactMetadataFormValues,
  ) => void;
  readonly artifactMetadataPending: boolean;
  readonly artifactMetadataError: string | undefined;
  readonly artifactMetadataStatus: string | undefined;
  readonly artifactsPaging: PagingState;
  readonly artifactVersionsPaging: PagingState;

  readonly searchState: LoadState;
  readonly searchResults: readonly SearchResultView[];
  readonly searchError: string | undefined;
  readonly searchQuery: string | undefined;
  readonly searchPaging: PagingState;
  readonly runSearch: (query: string) => void;
}

function artifactSummary(artifact: ArtifactDto): ArtifactSummaryView {
  return {
    id: artifact.id,
    title: artifact.title,
    kind: artifact.kind,
    status: artifact.status,
    currentVersion: artifact.currentVersion,
    updatedAt: artifact.updatedAt,
  };
}

function versionView(version: ArtifactVersionMetadataDto): ArtifactVersionView {
  return {
    version: version.version,
    byteSize: version.byteSize,
    createdAt: version.createdAt,
  };
}

function searchHitView(hit: SearchHitDto): SearchResultView {
  return {
    messageId: hit.messageId,
    conversationId: hit.conversationId,
    conversationTitle: hit.conversationTitle,
    role: hit.role,
    snippet: hit.snippet,
    at: formatWhen(hit.createdAt),
  };
}

function skillView(skill: SkillDto): SkillView {
  return {
    id: skill.id,
    name: skill.name,
    description: skill.description,
    bodyMarkdown: skill.bodyMarkdown,
    status: skill.status,
    version: skill.version,
    botId: skill.botId,
  };
}

/** Replaces one skill in the loaded list after an attach or detach. */
function withUpdatedSkill(
  skills: readonly SkillView[],
  skillId: string,
  updated: SkillDto,
): readonly SkillView[] {
  return skills.map((skill) => (skill.id === skillId ? skillView(updated) : skill));
}

/** Puts the newest row first without duplicating a record already in the page. */
function prependSkill(
  skills: readonly SkillView[],
  skill: SkillDto,
): readonly SkillView[] {
  return [skillView(skill), ...skills.filter((item) => item.id !== skill.id)];
}

/** Appends a cursor page, dropping rows already loaded. */
function appendSkills(
  skills: readonly SkillView[],
  page: readonly SkillDto[],
): readonly SkillView[] {
  const seen = new Set(skills.map((skill) => skill.id));

  return [...skills, ...page.filter((skill) => !seen.has(skill.id)).map(skillView)];
}

/** Appends a cursor page of search hits, dropping rows already loaded. */
function appendSearchResults(
  results: readonly SearchResultView[],
  page: readonly SearchHitDto[],
): readonly SearchResultView[] {
  const seen = new Set(results.map((result) => result.messageId));

  return [...results, ...page.filter((hit) => !seen.has(hit.messageId)).map(searchHitView)];
}

/** Appends a cursor page of memory gates, dropping rows already loaded. */
function appendMemories(
  memories: readonly MemoryGateItem[],
  page: readonly MemoryDto[],
): readonly MemoryGateItem[] {
  const seen = new Set(memories.map((memory) => memory.id));

  return [
    ...memories,
    ...page
      .filter((memory) => !seen.has(memory.id))
      .map((memory) => ({
        id: memory.id,
        text: memory.content,
        botApproved: memory.botApproved,
        threadApproved: memory.conversationApproved,
      })),
  ];
}

function appendVersions(
  versions: readonly ArtifactVersionView[],
  page: readonly ArtifactVersionMetadataDto[],
): readonly ArtifactVersionView[] {
  const seen = new Set(versions.map((version) => version.version));

  return [...versions, ...page.filter((version) => !seen.has(version.version)).map(versionView)];
}

function prependArtifact(
  artifacts: readonly ArtifactSummaryView[],
  artifact: ArtifactDto,
): readonly ArtifactSummaryView[] {
  return [artifactSummary(artifact), ...artifacts.filter((item) => item.id !== artifact.id)];
}

function appendArtifacts(
  artifacts: readonly ArtifactSummaryView[],
  page: readonly ArtifactDto[],
): readonly ArtifactSummaryView[] {
  const seen = new Set(artifacts.map((artifact) => artifact.id));

  return [...artifacts, ...page.filter((artifact) => !seen.has(artifact.id)).map(artifactSummary)];
}

/** Replaces one artifact's summary after a save or restore. */
function withUpdatedArtifact(
  artifacts: readonly ArtifactSummaryView[],
  updated: ArtifactDto,
): readonly ArtifactSummaryView[] {
  return artifacts.map((item) =>
    item.id === updated.id ? artifactSummary(updated) : item,
  );
}

export function useWorkspaceActions(
  data: WorkspaceData,
  threadId: string | undefined,
  panelOpen: boolean,
): WorkspaceActions {
  const router = useRouter();
  const live = data.mode === 'live';
  const botId = data.bot.id;

  const [botPending, setBotPending] = useState(false);
  const [botError, setBotError] = useState<string | undefined>(undefined);
  const [botStatus, setBotStatus] = useState<string | undefined>(undefined);

  const [threadPending, setThreadPending] = useState(false);
  const [threadError, setThreadError] = useState<string | undefined>(undefined);
  const [threadStatus, setThreadStatus] = useState<string | undefined>(undefined);

  const [memoryPendingId, setMemoryPendingId] = useState<string | undefined>(undefined);
  const [memoryError, setMemoryError] = useState<string | undefined>(undefined);
  const [memoryStatus, setMemoryStatus] = useState<string | undefined>(undefined);
  const [memoryExtras, setMemoryExtras] = useState<readonly MemoryGateItem[]>([]);
  const [memoryCursor, setMemoryCursor] = useState<string | null>(
    data.memoryNextCursor ?? null,
  );
  const [memoryLoadingMore, setMemoryLoadingMore] = useState(false);
  const [memoryPagingError, setMemoryPagingError] = useState<string | undefined>(undefined);

  const [skills, setSkills] = useState<readonly SkillView[]>([]);
  const [skillsState, setSkillsState] = useState<LoadState>('idle');
  const [skillsError, setSkillsError] = useState<string | undefined>(undefined);
  const [skillPendingId, setSkillPendingId] = useState<string | undefined>(undefined);
  const [skillCursor, setSkillCursor] = useState<string | null>(null);
  const [skillsLoadingMore, setSkillsLoadingMore] = useState(false);
  const [skillsPagingError, setSkillsPagingError] = useState<string | undefined>(undefined);
  const [skillCreatePending, setSkillCreatePending] = useState(false);
  const [skillCreateError, setSkillCreateError] = useState<string | undefined>(undefined);
  const [skillCreateStatus, setSkillCreateStatus] = useState<string | undefined>(undefined);
  const [skillUpdatePendingId, setSkillUpdatePendingId] = useState<string | undefined>(undefined);
  const [skillUpdateError, setSkillUpdateError] = useState<string | undefined>(undefined);
  const [skillUpdateStatus, setSkillUpdateStatus] = useState<string | undefined>(undefined);

  const [artifacts, setArtifacts] = useState<readonly ArtifactSummaryView[]>([]);
  const [artifactsState, setArtifactsState] = useState<LoadState>('idle');
  const [artifactDetail, setArtifactDetail] = useState<ArtifactDetailView | undefined>(undefined);
  const [artifactVersions, setArtifactVersions] = useState<readonly ArtifactVersionView[]>([]);
  const [artifactBusy, setArtifactBusy] = useState<'select' | 'save' | 'restore' | undefined>(
    undefined,
  );
  const [artifactError, setArtifactError] = useState<string | undefined>(undefined);
  const [artifactStatus, setArtifactStatus] = useState<string | undefined>(undefined);
  const [artifactCursor, setArtifactCursor] = useState<string | null>(null);
  const [artifactsLoadingMore, setArtifactsLoadingMore] = useState(false);
  const [artifactsPagingError, setArtifactsPagingError] = useState<string | undefined>(undefined);
  const [versionCursor, setVersionCursor] = useState<string | null>(null);
  const [versionsLoadingMore, setVersionsLoadingMore] = useState(false);
  const [versionsPagingError, setVersionsPagingError] = useState<string | undefined>(undefined);
  const [artifactCreatePending, setArtifactCreatePending] = useState(false);
  const [artifactCreateError, setArtifactCreateError] = useState<string | undefined>(undefined);
  const [artifactCreateStatus, setArtifactCreateStatus] = useState<string | undefined>(undefined);
  const [artifactMetadataPending, setArtifactMetadataPending] = useState(false);
  const [artifactMetadataError, setArtifactMetadataError] = useState<string | undefined>(undefined);
  const [artifactMetadataStatus, setArtifactMetadataStatus] = useState<string | undefined>(
    undefined,
  );

  const [searchState, setSearchState] = useState<LoadState>('idle');
  const [searchResults, setSearchResults] = useState<readonly SearchResultView[]>([]);
  const [searchError, setSearchError] = useState<string | undefined>(undefined);
  const [searchQuery, setSearchQuery] = useState<string | undefined>(undefined);
  const [searchCursor, setSearchCursor] = useState<string | null>(null);
  const [searchLoadingMore, setSearchLoadingMore] = useState(false);
  const [searchPagingError, setSearchPagingError] = useState<string | undefined>(undefined);

  const enabled = live && panelOpen;

  // Async callbacks compare against these refs so a page requested for one
  // thread, artifact or query can never populate another one afterwards.
  const threadRef = useRef(threadId);
  const detailIdRef = useRef<string | undefined>(undefined);
  const searchRequestRef = useRef(0);

  useEffect(() => {
    threadRef.current = threadId;
  }, [threadId]);

  useEffect(() => {
    detailIdRef.current = artifactDetail?.artifact.id;
  }, [artifactDetail]);

  // The server page seeds the memory list and its cursor. Additional pages are
  // appended locally; a server refresh replaces the first page, and the merge
  // below drops any id already present instead of rendering it twice.
  const memories = useMemo(() => {
    const seen = new Set<string>();
    const merged: MemoryGateItem[] = [];

    for (const memory of [...data.memories, ...memoryExtras]) {
      if (!seen.has(memory.id)) {
        seen.add(memory.id);
        merged.push(memory);
      }
    }

    return merged;
  }, [data.memories, memoryExtras]);

  const loadArtifact = useCallback(async (artifactId: string) => {
    const requestThread = threadRef.current;

    setArtifactBusy('select');
    setArtifactError(undefined);
    setArtifactMetadataError(undefined);
    setArtifactMetadataStatus(undefined);

    try {
      const [detail, versions] = await Promise.all([
        readArtifact(artifactId),
        readArtifactVersionPage(artifactId, { limit: PAGE_SIZE }),
      ]);

      if (threadRef.current !== requestThread) {
        return;
      }

      setArtifactDetail({
        artifact: artifactSummary(detail.artifact.artifact),
        version: {
          version: detail.artifact.version.version,
          byteSize: detail.artifact.version.byteSize,
          createdAt: detail.artifact.version.createdAt,
        },
        content: detail.artifact.version.content,
      });
      setArtifactVersions(versions.versions.map(versionView));
      setVersionCursor(versions.nextCursor);
      setVersionsPagingError(undefined);
      setArtifactStatus(undefined);
    } catch (error) {
      setArtifactError(chatErrorMessage(error));
    } finally {
      setArtifactBusy(undefined);
    }
  }, []);

  useEffect(() => {
    if (!enabled) {
      return;
    }

    let cancelled = false;

    void (async () => {
      setSkillsState('loading');

      try {
        const page = await readSkills({ limit: PAGE_SIZE });
        if (!cancelled) {
          setSkills(page.skills.map(skillView));
          setSkillCursor(page.nextCursor);
          setSkillsPagingError(undefined);
          setSkillsState('ready');
          setSkillsError(undefined);
        }
      } catch (error) {
        if (!cancelled) {
          setSkillsState('error');
          setSkillsError(chatErrorMessage(error));
        }
      }
    })();

    void (async () => {
      setArtifactsState('loading');
      setArtifacts([]);
      setArtifactDetail(undefined);
      setArtifactVersions([]);
      setArtifactError(undefined);
      setArtifactCursor(null);
      setVersionCursor(null);
      setArtifactsPagingError(undefined);
      setVersionsPagingError(undefined);

      if (threadId === undefined) {
        if (!cancelled) {
          setArtifacts([]);
          setArtifactDetail(undefined);
          setArtifactVersions([]);
          setArtifactsState('ready');
        }
        return;
      }

      try {
        const page = await readArtifacts({ conversationId: threadId, limit: PAGE_SIZE });
        if (cancelled) {
          return;
        }

        setArtifacts(page.artifacts.map(artifactSummary));
        setArtifactCursor(page.nextCursor);
        setArtifactsState('ready');
        setArtifactError(undefined);

        const first = page.artifacts[0];

        if (first === undefined) {
          setArtifactDetail(undefined);
          setArtifactVersions([]);
        } else {
          await loadArtifact(first.id);
        }
      } catch (error) {
        if (!cancelled) {
          setArtifactsState('error');
          setArtifactError(chatErrorMessage(error));
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [enabled, threadId, loadArtifact]);

  function saveBot(values: BotFormValues) {
    if (!live) {
      return;
    }

    const token = readCsrfToken();

    if (token === undefined) {
      setBotError('This session did not publish a CSRF token, so nothing was saved.');
      return;
    }

    setBotPending(true);
    setBotError(undefined);
    setBotStatus(undefined);

    void updateBot(
      botId,
      {
        name: values.name,
        description: values.purpose,
        instructionsMarkdown: values.instructions,
      },
      token,
    )
      .then(() => {
        setBotStatus('Bot profile saved.');
        router.refresh();
      })
      .catch((error: unknown) => setBotError(chatErrorMessage(error)))
      .finally(() => setBotPending(false));
  }

  function createThreadForBot(title: string | undefined) {
    if (!live) {
      return;
    }

    const token = readCsrfToken();

    if (token === undefined) {
      setThreadError('This session did not publish a CSRF token, so no thread was created.');
      return;
    }

    setThreadPending(true);
    setThreadError(undefined);
    setThreadStatus(undefined);

    void createThread(botId, title, token)
      .then((result) => {
        setThreadStatus('Thread created.');
        router.push(threadHref(botId, result.thread.id));
        router.refresh();
      })
      .catch((error: unknown) => setThreadError(chatErrorMessage(error)))
      .finally(() => setThreadPending(false));
  }

  function renameThreadById(id: string, title: string) {
    if (!live) {
      return;
    }

    const token = readCsrfToken();

    if (token === undefined) {
      setThreadError('This session did not publish a CSRF token, so the title was not saved.');
      return;
    }

    setThreadPending(true);
    setThreadError(undefined);
    setThreadStatus(undefined);

    void renameThread(id, title, token)
      .then(() => {
        setThreadStatus('Thread renamed.');
        router.refresh();
      })
      .catch((error: unknown) => setThreadError(chatErrorMessage(error)))
      .finally(() => setThreadPending(false));
  }

  function toggleMemory(
    id: string,
    _gate: MemoryGate,
    _next: boolean,
    nextGates: { readonly bot: boolean; readonly thread: boolean },
  ) {
    if (!live) {
      return;
    }

    const token = readCsrfToken();

    if (token === undefined) {
      setMemoryError('This session did not publish a CSRF token, so the approval was not saved.');
      return;
    }

    setMemoryPendingId(id);
    setMemoryError(undefined);
    setMemoryStatus('Saving the approval…');

    void setMemoryApprovals(
      id,
      {
        bot: nextGates.bot,
        thread: nextGates.thread,
        ...(threadId === undefined ? {} : { threadId }),
      },
      token,
    )
      .then((result: { memory: MemoryDto }) => {
        setMemoryStatus(
          result.memory.botApproved && result.memory.conversationApproved
            ? 'Both gates approved. This memory can be recalled in its source thread.'
            : 'Saved. The memory is held back until both gates are on.',
        );
        router.refresh();
      })
      .catch((error: unknown) => setMemoryError(chatErrorMessage(error)))
      .finally(() => setMemoryPendingId(undefined));
  }

  function proposeMemory(text: string, sourceThreadId: string) {
    if (!live) {
      return;
    }

    const token = readCsrfToken();

    if (token === undefined) {
      setMemoryError('This session did not publish a CSRF token, so no memory was proposed.');
      return;
    }

    setMemoryPendingId('new');
    setMemoryError(undefined);
    setMemoryStatus(undefined);

    void createMemory(botId, { text, threadId: sourceThreadId }, token)
      .then(() => {
        setMemoryStatus('Memory proposed. Both gates start off, so nothing is recalled yet.');
        router.refresh();
      })
      .catch((error: unknown) => setMemoryError(chatErrorMessage(error)))
      .finally(() => setMemoryPendingId(undefined));
  }

  function attachSkillToBot(skillId: string) {
    const token = readCsrfToken();

    if (token === undefined) {
      setSkillsError('This session did not publish a CSRF token, so the skill was not attached.');
      return;
    }

    setSkillPendingId(skillId);

    void attachSkill(skillId, botId, token)
      .then((result) => {
        setSkills((previous) => withUpdatedSkill(previous, skillId, result.skill));
        setSkillsError(undefined);
      })
      .catch((error: unknown) => setSkillsError(chatErrorMessage(error)))
      .finally(() => setSkillPendingId(undefined));
  }

  function detachSkillFromBot(skillId: string) {
    const token = readCsrfToken();

    if (token === undefined) {
      setSkillsError('This session did not publish a CSRF token, so the skill was not detached.');
      return;
    }

    setSkillPendingId(skillId);

    void detachSkill(skillId, token)
      .then((result) => {
        setSkills((previous) => withUpdatedSkill(previous, skillId, result.skill));
        setSkillsError(undefined);
      })
      .catch((error: unknown) => setSkillsError(chatErrorMessage(error)))
      .finally(() => setSkillPendingId(undefined));
  }

  function createSkillForAccount(values: SkillFormValues) {
    if (!live) {
      return;
    }

    const nameLength = values.name.length;

    if (nameLength < 1 || nameLength > SKILL_NAME_MAX_LENGTH) {
      setSkillCreateError(`A skill name must be 1–${SKILL_NAME_MAX_LENGTH} characters.`);
      return;
    }

    if (values.description.length > SKILL_DESCRIPTION_MAX_LENGTH) {
      setSkillCreateError(
        `A skill description must be at most ${SKILL_DESCRIPTION_MAX_LENGTH} characters.`,
      );
      return;
    }

    if (utf8Bytes(values.bodyMarkdown) > SKILL_BODY_MAX_BYTES) {
      setSkillCreateError('The skill body is over the 64 KiB the API accepts, so it was not sent.');
      return;
    }

    const token = readCsrfToken();

    if (token === undefined) {
      setSkillCreateError('This session did not publish a CSRF token, so no skill was created.');
      return;
    }

    setSkillCreatePending(true);
    setSkillCreateError(undefined);
    setSkillCreateStatus(undefined);

    void postSkill(
      {
        name: values.name,
        description: values.description,
        bodyMarkdown: values.bodyMarkdown,
        ...(values.attachToBot ? { botId } : {}),
      },
      token,
    )
      .then((result) => {
        setSkills((previous) => prependSkill(previous, result.skill));
        setSkillCreateStatus(`Created “${result.skill.name}” as a draft. It grants no tools.`);
      })
      .catch((error: unknown) => setSkillCreateError(chatErrorMessage(error)))
      .finally(() => setSkillCreatePending(false));
  }

  function updateSkillForAccount(skillId: string, values: SkillFormValues) {
    if (!live) {
      return;
    }

    const current = skills.find((skill) => skill.id === skillId);

    if (current === undefined) {
      setSkillUpdateError('That skill is no longer in the loaded list. Reload before editing it.');
      return;
    }

    if (current.status === 'archived' || current.status === 'deleted') {
      setSkillUpdateError('Archived and deleted skills are read-only.');
      return;
    }

    const nameLength = values.name.length;

    if (nameLength < 1 || nameLength > SKILL_NAME_MAX_LENGTH) {
      setSkillUpdateError(`A skill name must be 1–${SKILL_NAME_MAX_LENGTH} characters.`);
      return;
    }

    if (values.description.length > SKILL_DESCRIPTION_MAX_LENGTH) {
      setSkillUpdateError(
        `A skill description must be at most ${SKILL_DESCRIPTION_MAX_LENGTH} characters.`,
      );
      return;
    }

    if (utf8Bytes(values.bodyMarkdown) > SKILL_BODY_MAX_BYTES) {
      setSkillUpdateError('The skill body is over the 64 KiB the API accepts, so it was not sent.');
      return;
    }

    // Only fields that differ are sent; the API keeps every omitted value, so a
    // concurrent change to an untouched field is not silently overwritten.
    const changed: {
      name?: string;
      description?: string;
      bodyMarkdown?: string;
    } = {};

    if (values.name !== current.name) {
      changed.name = values.name;
    }

    if (values.description !== current.description) {
      changed.description = values.description;
    }

    if (values.bodyMarkdown !== current.bodyMarkdown) {
      changed.bodyMarkdown = values.bodyMarkdown;
    }

    if (Object.keys(changed).length === 0) {
      setSkillUpdateStatus('Nothing changed, so no new version was created.');
      return;
    }

    const token = readCsrfToken();

    if (token === undefined) {
      setSkillUpdateError('This session did not publish a CSRF token, so the skill was not saved.');
      return;
    }

    setSkillUpdatePendingId(skillId);
    setSkillUpdateError(undefined);
    setSkillUpdateStatus(undefined);

    void updateSkill(skillId, changed, token)
      .then((result) => {
        setSkills((previous) => withUpdatedSkill(previous, skillId, result.skill));
        setSkillUpdateStatus(
          `Saved “${result.skill.name}” as version ${result.skill.version}. Earlier versions are preserved.`,
        );
      })
      .catch((error: unknown) => setSkillUpdateError(chatErrorMessage(error)))
      .finally(() => setSkillUpdatePendingId(undefined));
  }

  function loadMoreSkills() {
    if (skillCursor === null || skillsLoadingMore) {
      return;
    }

    setSkillsLoadingMore(true);
    setSkillsPagingError(undefined);

    void readSkills({ limit: PAGE_SIZE, cursor: skillCursor })
      .then((page) => {
        setSkills((previous) => appendSkills(previous, page.skills));
        setSkillCursor(page.nextCursor);
      })
      .catch((error: unknown) => setSkillsPagingError(chatErrorMessage(error)))
      .finally(() => setSkillsLoadingMore(false));
  }

  function loadMoreMemories() {
    if (memoryCursor === null || memoryLoadingMore) {
      return;
    }

    setMemoryLoadingMore(true);
    setMemoryPagingError(undefined);

    void readMemoryPage(botId, { limit: PAGE_SIZE, cursor: memoryCursor })
      .then((page) => {
        setMemoryExtras((previous) => appendMemories(previous, page.memories));
        setMemoryCursor(page.nextCursor);
      })
      .catch((error: unknown) => setMemoryPagingError(chatErrorMessage(error)))
      .finally(() => setMemoryLoadingMore(false));
  }

  function selectArtifact(artifactId: string) {
    void loadArtifact(artifactId);
  }

  function createArtifactForThread(values: ArtifactFormValues) {
    if (!live || threadId === undefined) {
      return;
    }

    if (utf8Bytes(values.content) > ARTIFACT_CONTENT_MAX_BYTES) {
      setArtifactCreateError(
        'This artifact is over the 100 KB HTTP transport cap, so it was not sent.',
      );
      return;
    }

    const token = readCsrfToken();

    if (token === undefined) {
      setArtifactCreateError(
        'This session did not publish a CSRF token, so no artifact was created.',
      );
      return;
    }

    setArtifactCreatePending(true);
    setArtifactCreateError(undefined);
    setArtifactCreateStatus(undefined);

    void postArtifact(
      {
        kind: values.kind,
        title: values.title,
        content: values.content,
        conversationId: threadId,
      },
      token,
    )
      .then(async (result) => {
        const next = result.artifact;
        setArtifacts((previous) => prependArtifact(previous, next.artifact));
        setArtifactDetail({
          artifact: artifactSummary(next.artifact),
          version: {
            version: next.version.version,
            byteSize: next.version.byteSize,
            createdAt: next.version.createdAt,
          },
          content: next.version.content,
        });
        setArtifactCreateStatus(
          `Created “${next.artifact.title}” as version ${next.version.version}.`,
        );

        const versions = await readArtifactVersionPage(next.artifact.id, {
          limit: PAGE_SIZE,
        });
        setArtifactVersions(versions.versions.map(versionView));
        setVersionCursor(versions.nextCursor);
        setVersionsPagingError(undefined);
      })
      .catch((error: unknown) => setArtifactCreateError(chatErrorMessage(error)))
      .finally(() => setArtifactCreatePending(false));
  }

  function updateArtifactMetadata(
    artifactId: string,
    values: ArtifactMetadataFormValues,
  ) {
    if (!live) {
      return;
    }

    const current = artifactDetail;

    if (current?.artifact.id !== artifactId) {
      setArtifactMetadataError('Select the artifact again before editing its metadata.');
      return;
    }

    const token = readCsrfToken();

    if (token === undefined) {
      setArtifactMetadataError(
        'This session did not publish a CSRF token, so the metadata was not saved.',
      );
      return;
    }

    setArtifactMetadataPending(true);
    setArtifactMetadataError(undefined);
    setArtifactMetadataStatus(undefined);

    // No `content` key: the API keeps the stored body and appends a version that
    // records the metadata change.
    void updateArtifact(
      artifactId,
      { title: values.title, kind: values.kind, status: values.status },
      token,
    )
      .then(async (result) => {
        const next = result.artifact;
        setArtifactDetail({
          artifact: artifactSummary(next.artifact),
          version: {
            version: next.version.version,
            byteSize: next.version.byteSize,
            createdAt: next.version.createdAt,
          },
          content: next.version.content,
        });
        setArtifacts((previous) => withUpdatedArtifact(previous, next.artifact));
        setArtifactMetadataStatus(
          `Metadata saved as version ${next.version.version}. The stored content is unchanged; earlier versions are preserved.`,
        );

        const versions = await readArtifactVersionPage(next.artifact.id, {
          limit: PAGE_SIZE,
        });
        setArtifactVersions(versions.versions.map(versionView));
        setVersionCursor(versions.nextCursor);
        setVersionsPagingError(undefined);
      })
      .catch((error: unknown) => setArtifactMetadataError(chatErrorMessage(error)))
      .finally(() => setArtifactMetadataPending(false));
  }

  function loadMoreArtifacts() {
    if (artifactCursor === null || artifactsLoadingMore || threadId === undefined) {
      return;
    }

    setArtifactsLoadingMore(true);
    setArtifactsPagingError(undefined);

    void readArtifacts({ conversationId: threadId, limit: PAGE_SIZE, cursor: artifactCursor })
      .then((page) => {
        if (threadRef.current !== threadId) {
          return;
        }

        setArtifacts((previous) => appendArtifacts(previous, page.artifacts));
        setArtifactCursor(page.nextCursor);
      })
      .catch((error: unknown) => setArtifactsPagingError(chatErrorMessage(error)))
      .finally(() => setArtifactsLoadingMore(false));
  }

  function loadMoreVersions() {
    const current = artifactDetail;

    if (current === undefined || versionCursor === null || versionsLoadingMore) {
      return;
    }

    setVersionsLoadingMore(true);
    setVersionsPagingError(undefined);

    void readArtifactVersionPage(current.artifact.id, {
      limit: PAGE_SIZE,
      cursor: versionCursor,
    })
      .then((page) => {
        if (detailIdRef.current !== current.artifact.id) {
          return;
        }

        setArtifactVersions((previous) => appendVersions(previous, page.versions));
        setVersionCursor(page.nextCursor);
      })
      .catch((error: unknown) => setVersionsPagingError(chatErrorMessage(error)))
      .finally(() => setVersionsLoadingMore(false));
  }

  function saveArtifact(content: string) {
    const current = artifactDetail;

    if (current === undefined) {
      return;
    }

    if (utf8Bytes(content) > ARTIFACT_CONTENT_MAX_BYTES) {
      setArtifactError(
        'This artifact is over the 100 KB HTTP transport cap, so it was not saved.',
      );
      return;
    }

    const token = readCsrfToken();

    if (token === undefined) {
      setArtifactError('This session did not publish a CSRF token, so the artifact was not saved.');
      return;
    }

    setArtifactBusy('save');
    setArtifactError(undefined);
    setArtifactStatus(undefined);

    void updateArtifact(current.artifact.id, { content }, token)
      .then(async (result) => {
        const next = result.artifact;
        setArtifactDetail({
          artifact: artifactSummary(next.artifact),
          version: {
            version: next.version.version,
            byteSize: next.version.byteSize,
            createdAt: next.version.createdAt,
          },
          content: next.version.content,
        });
        setArtifacts((previous) => withUpdatedArtifact(previous, next.artifact));
        setArtifactStatus(`Saved as version ${next.version.version}.`);
        const versions = await readArtifactVersionPage(next.artifact.id, {
          limit: PAGE_SIZE,
        });
        setArtifactVersions(versions.versions.map(versionView));
        setVersionCursor(versions.nextCursor);
        setVersionsPagingError(undefined);
      })
      .catch((error: unknown) => setArtifactError(chatErrorMessage(error)))
      .finally(() => setArtifactBusy(undefined));
  }

  function restoreArtifact(version: number) {
    const current = artifactDetail;

    if (current === undefined) {
      return;
    }

    const token = readCsrfToken();

    if (token === undefined) {
      setArtifactError('This session did not publish a CSRF token, so nothing was restored.');
      return;
    }

    setArtifactBusy('restore');
    setArtifactError(undefined);
    setArtifactStatus(undefined);

    void restoreArtifactVersion(current.artifact.id, version, token)
      .then(async (result) => {
        const next = result.artifact;
        setArtifactDetail({
          artifact: artifactSummary(next.artifact),
          version: {
            version: next.version.version,
            byteSize: next.version.byteSize,
            createdAt: next.version.createdAt,
          },
          content: next.version.content,
        });
        setArtifacts((previous) => withUpdatedArtifact(previous, next.artifact));
        setArtifactStatus(`Version ${version} restored as version ${next.version.version}.`);
        const versions = await readArtifactVersionPage(next.artifact.id, {
          limit: PAGE_SIZE,
        });
        setArtifactVersions(versions.versions.map(versionView));
        setVersionCursor(versions.nextCursor);
        setVersionsPagingError(undefined);
      })
      .catch((error: unknown) => setArtifactError(chatErrorMessage(error)))
      .finally(() => setArtifactBusy(undefined));
  }

  function runSearch(query: string) {
    const requestId = searchRequestRef.current + 1;
    searchRequestRef.current = requestId;

    setSearchState('loading');
    setSearchError(undefined);
    setSearchQuery(query);
    setSearchCursor(null);
    setSearchPagingError(undefined);

    void searchMessages({ q: query, botId, limit: PAGE_SIZE })
      .then((page) => {
        if (searchRequestRef.current !== requestId) {
          return;
        }

        setSearchResults(page.results.map(searchHitView));
        setSearchCursor(page.nextCursor);
        setSearchState('ready');
      })
      .catch((error: unknown) => {
        if (searchRequestRef.current !== requestId) {
          return;
        }

        setSearchResults([]);
        setSearchCursor(null);
        setSearchState('error');
        setSearchError(chatErrorMessage(error));
      });
  }

  function loadMoreSearch() {
    const query = searchQuery;

    if (query === undefined || searchCursor === null || searchLoadingMore) {
      return;
    }

    const requestId = searchRequestRef.current;

    setSearchLoadingMore(true);
    setSearchPagingError(undefined);

    void searchMessages({ q: query, botId, limit: PAGE_SIZE, cursor: searchCursor })
      .then((page) => {
        if (searchRequestRef.current !== requestId) {
          return;
        }

        setSearchResults((previous) => appendSearchResults(previous, page.results));
        setSearchCursor(page.nextCursor);
      })
      .catch((error: unknown) => {
        if (searchRequestRef.current !== requestId) {
          return;
        }

        setSearchPagingError(chatErrorMessage(error));
      })
      .finally(() => setSearchLoadingMore(false));
  }

  return {
    botPending,
    botError,
    botStatus,
    saveBot,
    threadPending,
    threadError,
    threadStatus,
    createThreadForBot,
    renameThreadById,
    memoryPendingId,
    memoryError,
    memoryStatus,
    memories,
    memoryPaging: {
      hasMore: memoryCursor !== null,
      loading: memoryLoadingMore,
      error: memoryPagingError,
      loadMore: loadMoreMemories,
    },
    toggleMemory,
    proposeMemory,
    skills,
    skillsState,
    skillsError,
    skillPendingId,
    attachSkillToBot,
    detachSkillFromBot,
    createSkillForAccount,
    skillCreatePending,
    skillCreateError,
    skillCreateStatus,
    updateSkillForAccount,
    skillUpdatePendingId,
    skillUpdateError,
    skillUpdateStatus,
    skillsPaging: {
      hasMore: skillCursor !== null,
      loading: skillsLoadingMore,
      error: skillsPagingError,
      loadMore: loadMoreSkills,
    },
    artifacts,
    artifactsState,
    artifactDetail,
    artifactVersions,
    artifactBusy,
    artifactError,
    artifactStatus,
    selectArtifact,
    saveArtifact,
    restoreArtifact,
    createArtifactForThread,
    artifactCreatePending,
    artifactCreateError,
    artifactCreateStatus,
    updateArtifactMetadata,
    artifactMetadataPending,
    artifactMetadataError,
    artifactMetadataStatus,
    artifactsPaging: {
      hasMore: artifactCursor !== null,
      loading: artifactsLoadingMore,
      error: artifactsPagingError,
      loadMore: loadMoreArtifacts,
    },
    artifactVersionsPaging: {
      hasMore: versionCursor !== null,
      loading: versionsLoadingMore,
      error: versionsPagingError,
      loadMore: loadMoreVersions,
    },
    searchState,
    searchResults,
    searchError,
    searchQuery,
    searchPaging: {
      hasMore: searchCursor !== null,
      loading: searchLoadingMore,
      error: searchPagingError,
      loadMore: loadMoreSearch,
    },
    runSearch,
  };
}
