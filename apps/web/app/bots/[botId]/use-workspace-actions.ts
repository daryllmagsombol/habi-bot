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
import { useCallback, useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import type {
  ArtifactDetailView,
  ArtifactSummaryView,
  ArtifactVersionView,
  MemoryGate,
  SearchResultView,
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
  readArtifactVersions,
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
import type {
  ArtifactDto,
  ArtifactVersionMetadataDto,
  MemoryDto,
  SkillDto,
} from '../../../lib/api/types';
import { formatWhen } from '../../../lib/api/format';
import { ARTIFACT_CONTENT_MAX_BYTES, utf8Bytes } from '../../../lib/api/limits';
import { threadHref } from '../../../lib/links';
import type { WorkspaceData } from './workspace-data';

type LoadState = 'idle' | 'loading' | 'ready' | 'error';

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

  readonly skills: readonly SkillView[];
  readonly skillsState: LoadState;
  readonly skillsError: string | undefined;
  readonly skillPendingId: string | undefined;
  readonly attachSkillToBot: (skillId: string) => void;
  readonly detachSkillFromBot: (skillId: string) => void;

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

  readonly searchState: LoadState;
  readonly searchResults: readonly SearchResultView[];
  readonly searchError: string | undefined;
  readonly searchQuery: string | undefined;
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

function skillView(skill: SkillDto): SkillView {
  return {
    id: skill.id,
    name: skill.name,
    description: skill.description,
    status: skill.status,
    version: skill.version,
    botId: skill.botId,
  };
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

  const [skills, setSkills] = useState<readonly SkillView[]>([]);
  const [skillsState, setSkillsState] = useState<LoadState>('idle');
  const [skillsError, setSkillsError] = useState<string | undefined>(undefined);
  const [skillPendingId, setSkillPendingId] = useState<string | undefined>(undefined);

  const [artifacts, setArtifacts] = useState<readonly ArtifactSummaryView[]>([]);
  const [artifactsState, setArtifactsState] = useState<LoadState>('idle');
  const [artifactDetail, setArtifactDetail] = useState<ArtifactDetailView | undefined>(undefined);
  const [artifactVersions, setArtifactVersions] = useState<readonly ArtifactVersionView[]>([]);
  const [artifactBusy, setArtifactBusy] = useState<'select' | 'save' | 'restore' | undefined>(
    undefined,
  );
  const [artifactError, setArtifactError] = useState<string | undefined>(undefined);
  const [artifactStatus, setArtifactStatus] = useState<string | undefined>(undefined);

  const [searchState, setSearchState] = useState<LoadState>('idle');
  const [searchResults, setSearchResults] = useState<readonly SearchResultView[]>([]);
  const [searchError, setSearchError] = useState<string | undefined>(undefined);
  const [searchQuery, setSearchQuery] = useState<string | undefined>(undefined);

  const enabled = live && panelOpen;

  const loadArtifact = useCallback(async (artifactId: string) => {
    setArtifactBusy('select');
    setArtifactError(undefined);

    try {
      const [detail, versions] = await Promise.all([
        readArtifact(artifactId),
        readArtifactVersions(artifactId),
      ]);

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
        const page = await readSkills({ limit: 100 });
        if (!cancelled) {
          setSkills(page.skills.map(skillView));
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
        const page = await readArtifacts({ conversationId: threadId, limit: 50 });
        if (cancelled) {
          return;
        }

        setArtifacts(page.artifacts.map(artifactSummary));
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
        setSkills((previous) =>
          previous.map((skill) =>
            skill.id === skillId ? skillView(result.skill) : skill,
          ),
        );
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
        setSkills((previous) =>
          previous.map((skill) =>
            skill.id === skillId ? skillView(result.skill) : skill,
          ),
        );
        setSkillsError(undefined);
      })
      .catch((error: unknown) => setSkillsError(chatErrorMessage(error)))
      .finally(() => setSkillPendingId(undefined));
  }

  function selectArtifact(artifactId: string) {
    void loadArtifact(artifactId);
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
        setArtifacts((previous) =>
          previous.map((item) =>
            item.id === next.artifact.id ? artifactSummary(next.artifact) : item,
          ),
        );
        setArtifactStatus(`Saved as version ${next.version.version}.`);
        const versions = await readArtifactVersions(next.artifact.id);
        setArtifactVersions(versions.versions.map(versionView));
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
        setArtifacts((previous) =>
          previous.map((item) =>
            item.id === next.artifact.id ? artifactSummary(next.artifact) : item,
          ),
        );
        setArtifactStatus(`Version ${version} restored as version ${next.version.version}.`);
        const versions = await readArtifactVersions(next.artifact.id);
        setArtifactVersions(versions.versions.map(versionView));
      })
      .catch((error: unknown) => setArtifactError(chatErrorMessage(error)))
      .finally(() => setArtifactBusy(undefined));
  }

  function runSearch(query: string) {
    setSearchState('loading');
    setSearchError(undefined);
    setSearchQuery(query);

    void searchMessages({ q: query, botId, limit: 20 })
      .then((page) => {
        setSearchResults(
          page.results.map((hit) => ({
            messageId: hit.messageId,
            conversationId: hit.conversationId,
            conversationTitle: hit.conversationTitle,
            role: hit.role,
            snippet: hit.snippet,
            at: formatWhen(hit.createdAt),
          })),
        );
        setSearchState('ready');
      })
      .catch((error: unknown) => {
        setSearchResults([]);
        setSearchState('error');
        setSearchError(chatErrorMessage(error));
      });
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
    toggleMemory,
    proposeMemory,
    skills,
    skillsState,
    skillsError,
    skillPendingId,
    attachSkillToBot,
    detachSkillFromBot,
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
    searchState,
    searchResults,
    searchError,
    searchQuery,
    runSearch,
  };
}
