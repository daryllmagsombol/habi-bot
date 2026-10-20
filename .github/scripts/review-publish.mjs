import fs from "node:fs"
import path from "node:path"
import {
  MAX_BATCHES,
  MAX_OUTCOME_FILE_BYTES,
  ReviewFailure,
  aggregateReview,
  fail,
  findBotComment,
  isBatchId,
  isMain,
  isPr,
  isRepo,
  isRunUrl,
  isSha,
  normalizedRepo,
  renderAggregateComment,
  renderComment,
  safeCode,
  validateIdentity,
  validateOutcome,
  validateReviewManifest,
} from "./review-lib.mjs"

const MAX_COMMENT_PAGES = 5
const MAX_MANIFEST_BYTES = 32 * 1024 * 1024
const MAX_ARTIFACT_METADATA_BYTES = 1024 * 1024
const MAX_OUTCOME_FILES = MAX_BATCHES + 16
const MAX_ARTIFACTS = MAX_BATCHES + 32
const OUTCOME_ARTIFACT_PREFIX = "review-outcome-"
const OUTCOME_ARTIFACT_NAME = /^review-outcome-(b[0-9]{4})$/
const OUTCOME_FILE_NAME = /^(b[0-9]{4})\.json$/

function readJson(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"))
  } catch {
    fail("invalid-json")
  }
}

function readBoundedJson(filePath, maxBytes, code) {
  if (typeof filePath !== "string" || filePath.length === 0) fail(code)
  let stat
  try {
    stat = fs.statSync(filePath)
  } catch {
    fail(code)
  }
  if (!stat.isFile() || stat.size > maxBytes) fail(code)
  let text
  try {
    text = fs.readFileSync(filePath, "utf8")
  } catch {
    fail(code)
  }
  try {
    return JSON.parse(text)
  } catch {
    fail(code)
  }
}

function requestHeaders(token, withBody = false) {
  const headers = {
    Accept: "application/vnd.github+json",
    Authorization: `Bearer ${token}`,
    "X-GitHub-Api-Version": "2022-11-28",
    "User-Agent": "habi-opencode-review",
  }
  if (withBody) headers["Content-Type"] = "application/json"
  return headers
}

function repoPath(repo) {
  return repo.split("/").map(encodeURIComponent).join("/")
}

async function githubJson(fetchImpl, url, token) {
  let response
  try {
    response = await fetchImpl(url, { headers: requestHeaders(token) })
  } catch {
    fail("github-network")
  }
  if (!response || typeof response.ok !== "boolean") fail("github-response")
  if (!response.ok) fail(`github-api-${response.status}`)
  try {
    return await response.json()
  } catch {
    fail("github-json")
  }
}

async function githubMutation(fetchImpl, url, token, method, payload) {
  let response
  try {
    response = await fetchImpl(url, {
      method,
      headers: requestHeaders(token, true),
      body: JSON.stringify(payload),
    })
  } catch {
    fail("github-network")
  }
  if (!response || typeof response.ok !== "boolean") fail("github-response")
  if (!response.ok) fail(`github-api-${response.status}`)
  return true
}

async function getPullRequest({ fetchImpl, apiUrl, repo, pr, token }) {
  return githubJson(fetchImpl, `${apiUrl}/repos/${repoPath(repo)}/pulls/${pr}`, token)
}

async function listComments({ fetchImpl, apiUrl, repo, pr, token }) {
  const comments = []
  let complete = false
  for (let page = 1; page <= MAX_COMMENT_PAGES; page += 1) {
    const batch = await githubJson(
      fetchImpl,
      `${apiUrl}/repos/${repoPath(repo)}/issues/${pr}/comments?per_page=100&page=${page}`,
      token,
    )
    if (!Array.isArray(batch)) fail("invalid-comments")
    comments.push(...batch)
    if (batch.length < 100) {
      complete = true
      break
    }
  }
  return { comments, complete }
}

function matchesEvent(prData, expected) {
  return (
    prData &&
    Number(prData.number) === Number(expected.pr) &&
    prData.state === "open" &&
    prData.draft === false &&
    String(prData.base?.sha).toLowerCase() === String(expected.baseSha).toLowerCase() &&
    String(prData.head?.sha).toLowerCase() === String(expected.headSha).toLowerCase() &&
    String(prData.base?.repo?.full_name ?? "").toLowerCase() === String(expected.repo).toLowerCase() &&
    String(prData.head?.repo?.full_name ?? "").toLowerCase() === String(expected.repo).toLowerCase()
  )
}

/**
 * Publish one pre-rendered body with the existing stale-head, pagination, and
 * owned-comment protections. Both single-outcome and aggregate modes share
 * this path so ownership and double-check behavior cannot drift.
 */
async function publishBody({ token, apiUrl, repo, pr, baseSha, headSha, body, fetchImpl, log }) {
  if (typeof token !== "string" || token.length === 0) fail("missing-token")
  if (!isRepo(repo) || !isPr(pr) || !isSha(baseSha) || !isSha(headSha)) fail("invalid-identity")
  const expected = { repo, pr, baseSha, headSha }
  const baseUrl = String(apiUrl).replace(/\/+$/, "")

  const before = await getPullRequest({ fetchImpl, apiUrl: baseUrl, repo, pr, token })
  if (!matchesEvent(before, expected)) {
    log("opencode-review: skipped (stale-head)")
    return { status: "stale", code: "stale-head" }
  }

  const { comments, complete } = await listComments({ fetchImpl, apiUrl: baseUrl, repo, pr, token })
  const existing = findBotComment(comments)
  if (!existing && !complete) {
    log("::warning::OpenCode review skipped (comment-window-exhausted): the owned marker was not found within the first 500 comments; no comment was created.")
    return { status: "incomplete", code: "comment-window-exhausted" }
  }

  const recheck = await getPullRequest({ fetchImpl, apiUrl: baseUrl, repo, pr, token })
  if (!matchesEvent(recheck, expected)) {
    log("opencode-review: skipped (stale-head)")
    return { status: "stale", code: "stale-head" }
  }

  if (existing) {
    await githubMutation(
      fetchImpl,
      `${baseUrl}/repos/${repoPath(repo)}/issues/comments/${existing.id}`,
      token,
      "PATCH",
      { body },
    )
    log("opencode-review: updated")
    return { status: "updated" }
  }

  await githubMutation(
    fetchImpl,
    `${baseUrl}/repos/${repoPath(repo)}/issues/${pr}/comments`,
    token,
    "POST",
    { body },
  )
  log("opencode-review: posted")
  return { status: "posted" }
}

export async function publishOutcome({
  token,
  apiUrl = "https://api.github.com",
  repo,
  pr,
  baseSha,
  headSha,
  input,
  outcome,
  fetchImpl = fetch,
  log = console.log,
} = {}) {
  if (typeof token !== "string" || token.length === 0) fail("missing-token")
  if (!isRepo(repo) || !isPr(pr) || !isSha(baseSha) || !isSha(headSha)) fail("invalid-identity")
  const expected = { repo, pr, baseSha, headSha }

  validateIdentity(expected, input, "input")
  validateIdentity(expected, outcome, "outcome")
  validateOutcome(outcome)

  return publishBody({
    token,
    apiUrl,
    repo,
    pr,
    baseSha,
    headSha,
    body: renderComment(outcome),
    fetchImpl,
    log,
  })
}

function malformedEntry(source, batchId, code) {
  return {
    malformed: true,
    source: typeof source === "string" ? source : null,
    batchId: isBatchId(batchId) ? batchId : null,
    code,
  }
}

function outcomeEntryFromFile(directory, name, artifactBatchId) {
  const match = name.match(OUTCOME_FILE_NAME)
  const fileBatchId = match ? match[1] : null
  if (!fileBatchId) return malformedEntry(name, null, "unexpected-artifact")
  if (fileBatchId !== artifactBatchId) return malformedEntry(name, fileBatchId, "artifact-filename-mismatch")

  const fileName = path.join(directory, name)
  let stat
  try {
    stat = fs.statSync(fileName)
  } catch {
    return malformedEntry(name, fileBatchId, "outcome-unreadable")
  }
  if (!stat.isFile()) return malformedEntry(name, fileBatchId, "unexpected-artifact")
  if (stat.size > MAX_OUTCOME_FILE_BYTES) return malformedEntry(name, fileBatchId, "outcome-too-large")
  let parsed
  try {
    parsed = JSON.parse(fs.readFileSync(fileName, "utf8"))
  } catch {
    return malformedEntry(name, fileBatchId, "invalid-outcome-json")
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return malformedEntry(name, fileBatchId, "invalid-outcome")
  }
  if (isBatchId(parsed.batchId)) {
    if (parsed.batchId !== fileBatchId) return malformedEntry(name, parsed.batchId, "outcome-filename-mismatch")
    return parsed
  }
  return malformedEntry(name, fileBatchId, "invalid-outcome")
}

function pushOutcome(state, entry) {
  if (state.count >= MAX_OUTCOME_FILES) {
    if (!state.limited) {
      state.limited = true
      state.outcomes.push(malformedEntry(null, null, "too-many-outcome-files"))
    }
    return
  }
  state.count += 1
  state.outcomes.push(entry)
}

function readArtifactOutcomeEntries(directory, artifact, state) {
  let entries
  try {
    entries = fs.readdirSync(directory, { withFileTypes: true })
  } catch {
    fail("outcome-artifact-missing")
  }
  const byName = new Map(entries.map((entry) => [entry.name, entry]))
  const names = [...byName.keys()].sort((left, right) => (left < right ? -1 : left > right ? 1 : 0))
  for (const name of names) {
    const entry = byName.get(name)
    if (!entry.isFile()) {
      pushOutcome(state, malformedEntry(name, null, "unexpected-artifact"))
      continue
    }
    pushOutcome(state, outcomeEntryFromFile(directory, name, artifact.batchId))
  }
}

function validateArtifactMetadata(artifactMetadata, { runId, repo } = {}) {
  if (!artifactMetadata || typeof artifactMetadata !== "object" || Array.isArray(artifactMetadata)) {
    fail("invalid-artifacts")
  }
  if (!/^[0-9]+$/.test(String(runId ?? ""))) fail("invalid-run-id")
  if (!isRepo(repo)) fail("invalid-identity")
  if (artifactMetadata.version !== 1) fail("invalid-artifacts")
  if (String(artifactMetadata.runId) !== String(runId)) fail("artifacts-run-mismatch")
  if (normalizedRepo(artifactMetadata.repository) !== normalizedRepo(repo)) fail("artifacts-repo-mismatch")
  if (artifactMetadata.complete !== true) fail("incomplete-artifacts")
  if (!Array.isArray(artifactMetadata.artifacts)) fail("invalid-artifacts")
  if (
    !Number.isInteger(artifactMetadata.artifactCount) ||
    artifactMetadata.artifactCount !== artifactMetadata.artifacts.length
  ) {
    fail("invalid-artifacts")
  }
  if (artifactMetadata.artifacts.length > MAX_ARTIFACTS) fail("too-many-artifacts")
  const ids = new Set()
  for (const artifact of artifactMetadata.artifacts) {
    if (
      !artifact ||
      typeof artifact !== "object" ||
      !Number.isInteger(artifact.id) ||
      artifact.id < 1 ||
      typeof artifact.name !== "string" ||
      artifact.name.length === 0
    ) {
      fail("invalid-artifacts")
    }
    if (ids.has(artifact.id)) fail("invalid-artifacts")
    ids.add(artifact.id)
  }
  return artifactMetadata
}

/**
 * Read outcomes using the trusted artifact listing as the authority for which
 * artifacts and batches exist. Directory contents never define expected IDs,
 * and artifact-name/batch/filename relationships must match exactly.
 */
export function readOutcomeEntries(outcomesDir, artifactMetadata, { runId, repo } = {}) {
  if (typeof outcomesDir !== "string" || outcomesDir.length === 0) fail("missing-outcomes")
  const metadata = validateArtifactMetadata(artifactMetadata, { runId, repo })
  const downloadedArtifacts = metadata.artifacts.filter((artifact) =>
    artifact.name.startsWith(OUTCOME_ARTIFACT_PREFIX),
  )
  const state = { outcomes: [], count: 0, limited: false }
  if (downloadedArtifacts.length === 0) return state.outcomes

  let rootStat
  try {
    rootStat = fs.statSync(outcomesDir)
  } catch {
    fail("outcomes-unreadable")
  }
  if (!rootStat.isDirectory()) fail("outcomes-unreadable")

  const accepted = []
  for (const artifact of downloadedArtifacts) {
    const match = artifact.name.match(OUTCOME_ARTIFACT_NAME)
    if (!match) {
      pushOutcome(state, malformedEntry(artifact.name, null, "unexpected-artifact"))
      continue
    }
    accepted.push({ artifact, batchId: match[1] })
  }

  // download-artifact flattens a single matching artifact into the root even
  // with merge-multiple false; multiple artifacts keep their names as folders.
  const flat = downloadedArtifacts.length === 1
  for (const entry of accepted) {
    if (entry.artifact.expired === true) {
      pushOutcome(state, malformedEntry(entry.artifact.name, entry.batchId, "artifact-expired"))
      continue
    }
    const directory = flat ? outcomesDir : path.join(outcomesDir, entry.artifact.name)
    readArtifactOutcomeEntries(directory, entry, state)
  }
  return state.outcomes
}

function writeAggregate(filePath, aggregate) {
  if (typeof filePath !== "string" || filePath.length === 0) return
  fs.mkdirSync(path.dirname(filePath), { recursive: true })
  fs.writeFileSync(filePath, `${JSON.stringify(aggregate, null, 2)}\n`)
}

export async function publishAggregate({
  token,
  apiUrl = "https://api.github.com",
  repo,
  pr,
  baseSha,
  headSha,
  manifest,
  outcomesDir,
  artifactMetadata,
  runId,
  runUrl,
  aggregatePath,
  fetchImpl = fetch,
  log = console.log,
} = {}) {
  if (typeof token !== "string" || token.length === 0) fail("missing-token")
  if (!isRepo(repo) || !isPr(pr) || !isSha(baseSha) || !isSha(headSha)) fail("invalid-identity")
  const expected = { repo, pr, baseSha, headSha }
  validateReviewManifest(manifest)
  validateIdentity(expected, manifest.identity, "manifest")
  if (!isRunUrl(runUrl, repo)) fail("invalid-run-url")

  const aggregate = aggregateReview(
    manifest,
    readOutcomeEntries(outcomesDir, artifactMetadata, { runId, repo }),
  )
  if (aggregatePath) writeAggregate(aggregatePath, { ...aggregate, runUrl })
  const body = renderAggregateComment(aggregate, { runUrl })
  const result = await publishBody({
    token,
    apiUrl,
    repo,
    pr,
    baseSha,
    headSha,
    body,
    fetchImpl,
    log,
  })
  return { ...result, aggregate, bodyBytes: Buffer.byteLength(body) }
}

function option(name) {
  const index = process.argv.indexOf(name)
  return index >= 0 ? process.argv[index + 1] : undefined
}

export async function main(env = process.env) {
  try {
    const manifestPath = option("--manifest")
    if (manifestPath) {
      const manifest = readBoundedJson(manifestPath, MAX_MANIFEST_BYTES, "invalid-manifest")
      const artifactMetadata = readBoundedJson(
        option("--artifacts"),
        MAX_ARTIFACT_METADATA_BYTES,
        "invalid-artifacts",
      )
      const result = await publishAggregate({
        token: env.GITHUB_TOKEN,
        apiUrl: env.GITHUB_API_URL || "https://api.github.com",
        repo: env.REVIEW_REPO,
        pr: Number(env.REVIEW_PR),
        baseSha: env.REVIEW_BASE_SHA,
        headSha: env.REVIEW_HEAD_SHA,
        manifest,
        outcomesDir: option("--outcomes"),
        artifactMetadata,
        runId: env.GITHUB_RUN_ID,
        runUrl: option("--run-url"),
        aggregatePath: option("--aggregate"),
      })
      if (result.status === "posted" || result.status === "updated") {
        console.log(`opencode-review-publish: ${result.aggregate.status} (${result.status})`)
      }
      return 0
    }

    await publishOutcome({
      token: env.GITHUB_TOKEN,
      apiUrl: env.GITHUB_API_URL || "https://api.github.com",
      repo: env.REVIEW_REPO,
      pr: Number(env.REVIEW_PR),
      baseSha: env.REVIEW_BASE_SHA,
      headSha: env.REVIEW_HEAD_SHA,
      input: readJson(option("--input")),
      outcome: readJson(option("--outcome")),
    })
    return 0
  } catch (error) {
    const code = safeCode(error instanceof ReviewFailure ? error.code : "publish-failure")
    console.error(`opencode-review-publish: failed (${code})`)
    return 1
  }
}

if (isMain(import.meta.url)) {
  process.exitCode = await main()
}
