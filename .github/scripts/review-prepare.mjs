import fs from "node:fs"
import path from "node:path"
import {
  MODEL,
  ReviewFailure,
  fail,
  isMain,
  isPr,
  isRepo,
  isLowerSha,
  isSha,
  normalizedRepo,
  safeCode,
  sha256,
} from "./review-lib.mjs"
import { DEFAULT_BATCH_BYTES, buildReviewBatches } from "./review-batches.mjs"
import { recoverMissingPatches, resolveComparisonBaseSha } from "./review-patches.mjs"

const PROMPT_FILES = [
  ["system", "system.md"],
  ["security", "security.md"],
  ["bugs", "bugs.md"],
]
const TRUSTED_HELPERS = [
  "review-lib.mjs",
  "review-markdown.mjs",
  "review-patches.mjs",
  "review-batches.mjs",
  "review-prepare.mjs",
  "review-model.mjs",
  "review-publish.mjs",
  "review-container.mjs",
  "review-container-entry.mjs",
  "review-network.mjs",
]
// GitHub exposes at most 3,000 changed files through the files endpoint.
export const MAX_FILE_PAGES = 30
const MAX_FILES_PER_PAGE = 100


export function loadTrustedPrompts(baseRoot) {
  const directory = path.join(baseRoot, ".github", "review")
  const prompts = {}
  for (const [name, file] of PROMPT_FILES) {
    try {
      prompts[name] = fs.readFileSync(path.join(directory, file), "utf8")
    } catch {
      fail("bootstrap-missing")
    }
    if (prompts[name].trim().length === 0) fail("bootstrap-missing")
  }
  return prompts
}

function githubHeaders(token) {
  return {
    Accept: "application/vnd.github+json",
    Authorization: `Bearer ${token}`,
    "X-GitHub-Api-Version": "2022-11-28",
    "User-Agent": "habi-opencode-review",
  }
}

export async function fetchJson(fetchImpl, url, token) {
  if (typeof token !== "string" || token.length === 0) fail("missing-token")
  let response
  try {
    response = await fetchImpl(url, { headers: githubHeaders(token) })
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

function repoPath(repo) {
  return repo.split("/").map(encodeURIComponent).join("/")
}

export async function fetchPullRequest({ fetchImpl, apiUrl, repo, pr, token }) {
  return fetchJson(fetchImpl, `${apiUrl}/repos/${repoPath(repo)}/pulls/${pr}`, token)
}

export async function fetchFiles({ fetchImpl, apiUrl, repo, pr, token, expectedCount }) {
  const files = []
  let exhausted = false
  for (let page = 1; page <= MAX_FILE_PAGES; page += 1) {
    const batch = await fetchJson(
      fetchImpl,
      `${apiUrl}/repos/${repoPath(repo)}/pulls/${pr}/files?per_page=${MAX_FILES_PER_PAGE}&page=${page}`,
      token,
    )
    if (!Array.isArray(batch)) fail("invalid-files")
    files.push(...batch)
    if (batch.length < MAX_FILES_PER_PAGE) break
    if (page === MAX_FILE_PAGES) exhausted = true
  }
  // The API caps at 3,000 files. A full final page is only truncation when the
  // PR reports more changed files than we received.
  const expected = Number.isInteger(expectedCount) && expectedCount >= 0 ? expectedCount : null
  const truncated = exhausted && expected !== files.length
  return { files, truncated }
}

function canonicalPath(value) {
  if (typeof value !== "string" || value.length === 0 || value.length > 4_096) return null
  if (value.includes("\0") || value.startsWith("/") || value.includes("\\")) return null
  const parts = value.split("/")
  if (parts.some((part) => part.length === 0 || part === "." || part === "..")) return null
  return value
}

export function normalizeFile(file) {
  if (!file || typeof file !== "object") fail("invalid-file")
  if (typeof file.filename !== "string" || file.filename.length === 0 || file.filename.length > 4_096) {
    fail("invalid-file")
  }
  const count = (value) => (Number.isInteger(value) && value >= 0 ? value : 0)
  return {
    filename: file.filename,
    previousFilename: canonicalPath(file.previous_filename),
    status: typeof file.status === "string" ? file.status : "unknown",
    additions: count(file.additions),
    deletions: count(file.deletions),
    changes: count(file.changes),
    sha: isSha(file.sha) ? file.sha.toLowerCase() : null,
    patch: typeof file.patch === "string" ? file.patch : null,
  }
}

function assertPullRequest(prData, { repo, pr, baseSha, headSha }) {
  if (!prData || typeof prData !== "object") fail("invalid-pr")
  if (Number(prData.number) !== Number(pr)) fail("identity-mismatch")
  if (prData.state !== "open") fail("not-open")
  if (prData.draft === true) fail("draft")
  if (!Number.isInteger(prData.changed_files) || prData.changed_files < 0) fail("invalid-pr")
  if (String(prData.base?.sha).toLowerCase() !== baseSha.toLowerCase()) fail("identity-mismatch")
  if (String(prData.head?.sha).toLowerCase() !== headSha.toLowerCase()) fail("identity-mismatch")
  if (normalizedRepo(prData.base?.repo?.full_name) !== normalizedRepo(repo)) fail("identity-mismatch")
  if (normalizedRepo(prData.head?.repo?.full_name) !== normalizedRepo(repo)) fail("fork-not-supported")
}

function writeFile(filePath, content) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true })
  fs.writeFileSync(filePath, content)
}

function copyTrustedHelpers(baseRoot, outputDir) {
  for (const helper of TRUSTED_HELPERS) {
    const source = path.join(baseRoot, ".github", "scripts", helper)
    if (!fs.existsSync(source)) fail("bootstrap-missing")
    const destination = path.join(outputDir, "trusted", helper)
    fs.mkdirSync(path.dirname(destination), { recursive: true })
    fs.copyFileSync(source, destination)
  }
}

function writeArtifactManifest(outputDir, baseSha, trustedSource, batchIds) {
  // Producer-side bookkeeping only. The same-run artifact is trusted by provenance; consumers do not verify these hashes.
  // This is deliberately separate from manifest.json, which is the planner's coverage authority.
  const files = [
    "manifest.json",
    "matrix.json",
    ...batchIds.flatMap((id) => [`batches/${id}/input.json`, `batches/${id}/prompt.txt`]),
    "prompts/system.md",
    "prompts/security.md",
    "prompts/bugs.md",
    ...TRUSTED_HELPERS.map((helper) => `trusted/${helper}`),
  ]
  const hashes = {}
  for (const file of files) hashes[file] = sha256(fs.readFileSync(path.join(outputDir, file)))
  const manifest = { version: 1, baseSha, trustedSource, model: MODEL, files: hashes }
  writeFile(path.join(outputDir, "artifact-manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`)
  return manifest
}

function normalizeComparisonBaseSha(value) {
  if (!isSha(value)) fail("invalid-comparison-base")
  return value.toLowerCase()
}

function patchRecoveryProvenance(baseSha, headSha, comparisonBaseSha, recoveries) {
  const normalized = recoveries
    .map((recovery) => ({
      filename: typeof recovery?.filename === "string" ? recovery.filename : "",
      status: safeCode(recovery?.status),
      patchSource: recovery?.patchSource === "immutable-blob-diff" ? "immutable-blob-diff" : null,
      baseBlobSha: isSha(recovery?.baseBlobSha) ? recovery.baseBlobSha.toLowerCase() : null,
      headBlobSha: isSha(recovery?.headBlobSha) ? recovery.headBlobSha.toLowerCase() : null,
      baseBytes: Number.isInteger(recovery?.baseBytes) && recovery.baseBytes >= 0 ? recovery.baseBytes : null,
      headBytes: Number.isInteger(recovery?.headBytes) && recovery.headBytes >= 0 ? recovery.headBytes : null,
      ...(typeof recovery?.reason === "string" ? { reason: safeCode(recovery.reason) } : {}),
    }))
    .sort((left, right) => (left.filename < right.filename ? -1 : left.filename > right.filename ? 1 : 0))
  return {
    kind: "immutable-blob-diff",
    baseSha: baseSha.toLowerCase(),
    comparisonBaseSha: comparisonBaseSha.toLowerCase(),
    headSha: headSha.toLowerCase(),
    recoveries: normalized,
  }
}

export async function prepareReview({
  repo,
  pr,
  baseSha,
  headSha,
  baseRoot,
  outputDir,
  token,
  trustedSourceSha,
  bootstrap = false,
  apiUrl = "https://api.github.com",
  fetchImpl = fetch,
  limitBytes = DEFAULT_BATCH_BYTES,
  patchResolver = recoverMissingPatches,
  comparisonResolver = resolveComparisonBaseSha,
  gitRunner,
  limits,
}) {
  if (!isRepo(repo)) fail("invalid-repo")
  if (!isPr(pr)) fail("invalid-pr-number")
  if (!isSha(baseSha) || !isSha(headSha)) fail("invalid-identity")

  const sourceSha = trustedSourceSha ?? baseSha
  if (!isLowerSha(sourceSha)) fail("invalid-trusted-source")
  if (bootstrap !== true && sourceSha !== baseSha) fail("invalid-trusted-source")
  const trustedSource = { sha: sourceSha, bootstrap: bootstrap === true }

  const prompts = loadTrustedPrompts(baseRoot)
  const prData = await fetchPullRequest({ fetchImpl, apiUrl, repo, pr, token })
  assertPullRequest(prData, { repo, pr, baseSha, headSha })
  const expectedFileCount = prData.changed_files
  const { files, truncated } = await fetchFiles({
    fetchImpl,
    apiUrl,
    repo,
    pr,
    token,
    expectedCount: expectedFileCount,
  })
  const normalizedFiles = files.map(normalizeFile)
  const needsPatchRecovery = normalizedFiles.some(
    (file) => typeof file.patch !== "string" || file.patch.length === 0,
  )
  const comparisonBaseSha = needsPatchRecovery
    ? normalizeComparisonBaseSha(
        await comparisonResolver({
          repo,
          baseSha,
          headSha,
          token,
          apiUrl,
          fetchImpl,
          ...(limits !== undefined ? { limits } : {}),
        }),
      )
    : null
  const recovered = needsPatchRecovery
    ? await patchResolver({
        repo,
        baseSha: comparisonBaseSha,
        headSha,
        files: normalizedFiles,
        token,
        apiUrl,
        fetchImpl,
        ...(gitRunner !== undefined ? { gitRunner } : {}),
        ...(limits !== undefined ? { limits } : {}),
      })
    : { files: normalizedFiles, recoveries: [] }
  if (!recovered || !Array.isArray(recovered.files) || !Array.isArray(recovered.recoveries)) {
    fail("invalid-recovered-files")
  }
  const rechecked = await fetchPullRequest({ fetchImpl, apiUrl, repo, pr, token })
  assertPullRequest(rechecked, { repo, pr, baseSha, headSha })
  if (rechecked.changed_files !== expectedFileCount) {
    // The file enumeration may no longer match the reviewed head. Fail before
    // writing artifacts so callers retry rather than publish an unknown range.
    fail("stale-file-count")
  }
  const { manifest, batches } = buildReviewBatches({
    identity: { repo, pr, baseSha, headSha },
    trustedSource,
    prompts,
    files: recovered.files,
    expectedFileCount,
    fileListTruncated: truncated,
    limitBytes,
  })
  if (recovered.recoveries.length > 0) {
    manifest.patchRecovery = patchRecoveryProvenance(
      baseSha,
      headSha,
      comparisonBaseSha,
      recovered.recoveries,
    )
  }

  fs.mkdirSync(outputDir, { recursive: true })
  writeFile(path.join(outputDir, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`)
  const paths = {
    outputDir,
    manifest: path.join(outputDir, "manifest.json"),
    artifactManifest: path.join(outputDir, "artifact-manifest.json"),
    matrix: path.join(outputDir, "matrix.json"),
    batches: [],
    prompts: {},
    trusted: TRUSTED_HELPERS.map((helper) => path.join(outputDir, "trusted", helper)),
  }
  for (const batch of batches) {
    const directory = path.join(outputDir, "batches", batch.id)
    const inputPath = path.join(directory, "input.json")
    const promptPath = path.join(directory, "prompt.txt")
    writeFile(inputPath, `${JSON.stringify(batch.input, null, 2)}\n`)
    writeFile(promptPath, batch.prompt)
    paths.batches.push({ id: batch.id, input: inputPath, prompt: promptPath })
  }
  // Matrix values are generated batch IDs only; no path or PR text reaches the matrix.
  writeFile(
    paths.matrix,
    `${JSON.stringify({ batchIds: batches.map((batch) => batch.id), count: batches.length }, null, 2)}\n`,
  )
  for (const [name, file] of PROMPT_FILES) {
    const promptPath = path.join(outputDir, "prompts", file)
    writeFile(promptPath, prompts[name])
    paths.prompts[name] = promptPath
  }
  copyTrustedHelpers(baseRoot, outputDir)
  writeArtifactManifest(
    outputDir,
    baseSha,
    trustedSource,
    batches.map((batch) => batch.id),
  )

  return { manifest, batches, paths }
}

export async function main(env = process.env) {
  try {
    await prepareReview({
      repo: env.REVIEW_REPO,
      pr: Number(env.REVIEW_PR),
      baseSha: env.REVIEW_BASE_SHA,
      headSha: env.REVIEW_HEAD_SHA,
      baseRoot: env.REVIEW_BASE_ROOT,
      outputDir: env.REVIEW_OUTPUT_DIR,
      token: env.GITHUB_TOKEN,
      trustedSourceSha: env.REVIEW_TRUSTED_SOURCE_SHA || env.REVIEW_BASE_SHA,
      bootstrap: env.REVIEW_BOOTSTRAP === "true",
      apiUrl: env.GITHUB_API_URL || "https://api.github.com",
    })
    console.log("opencode-review-prepare: ready")
    return 0
  } catch (error) {
    const code = safeCode(error instanceof ReviewFailure ? error.code : "prepare-failure")
    console.error(`opencode-review-prepare: failed (${code})`)
    return 1
  }
}

if (isMain(import.meta.url)) {
  process.exitCode = await main()
}
