import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { Buffer } from "node:buffer"
import { createHash } from "node:crypto"
import { spawn } from "node:child_process"
import { fail, isRepo, isSha } from "./review-lib.mjs"

// Hard caps. Callers may only lower these values (tests do); production uses
// the full limits.
export const PATCH_LIMITS = Object.freeze({
  maxBlobBytes: 8 * 1024 * 1024,
  maxTotalBytes: 16 * 1024 * 1024,
  maxResponseBytes: 12 * 1024 * 1024,
  maxPatchBytes: 32 * 1024 * 1024,
  gitTimeoutMs: 10_000,
})

const SUPPORTED_STATUSES = new Set(["added", "removed", "modified", "renamed"])
const REGULAR_MODES = new Set(["100644", "100755"])
const HUNK_HEADER = /^@@ -\d+(?:,\d+)? \+\d+(?:,\d+)? @@/
const MAX_PATH_LENGTH = 4_096
const MAX_GIT_STDERR_BYTES = 64 * 1024

const GIT_DIFF_ARGS = Object.freeze([
  "--no-pager",
  "-c",
  "core.hooksPath=/dev/null",
  "-c",
  "core.fsmonitor=false",
  "-c",
  "core.attributesFile=/dev/null",
  "-c",
  "core.autocrlf=false",
  "diff",
  "--no-index",
  "--no-ext-diff",
  "--no-textconv",
  "--no-color",
  "--text",
  "--unified=3",
  "--diff-algorithm=myers",
  "--no-indent-heuristic",
  "--",
  "old.txt",
  "new.txt",
])

class UnreviewableError extends Error {
  constructor(reason) {
    super(reason)
    this.name = "UnreviewableError"
    this.reason = reason
  }
}

function unreviewable(reason) {
  throw new UnreviewableError(reason)
}

function normalizeLimits(input) {
  const source = input && typeof input === "object" && !Array.isArray(input) ? input : {}
  for (const key of Object.keys(source)) {
    if (!Object.hasOwn(PATCH_LIMITS, key)) fail("invalid-limit")
  }
  const limits = { ...PATCH_LIMITS }
  for (const key of Object.keys(PATCH_LIMITS)) {
    if (source[key] === undefined) continue
    const value = source[key]
    if (!Number.isInteger(value) || value <= 0 || value > PATCH_LIMITS[key]) fail("invalid-limit")
    limits[key] = value
  }
  return limits
}

function normalizeApiUrl(value) {
  let url
  try {
    url = new URL(value)
  } catch {
    fail("invalid-api-url")
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") fail("invalid-api-url")
  if (url.username || url.password || url.search || url.hash) fail("invalid-api-url")
  return url.toString().replace(/\/+$/, "")
}

function isSafeRepo(repo) {
  if (!isRepo(repo)) return false
  return repo.split("/").every((part) => part !== "." && part !== "..")
}

function repoPath(repo) {
  return repo.split("/").map(encodeURIComponent).join("/")
}

function githubHeaders(token) {
  return {
    Accept: "application/vnd.github+json",
    Authorization: `Bearer ${token}`,
    "X-GitHub-Api-Version": "2022-11-28",
    "User-Agent": "habi-opencode-review",
  }
}

function validateToken(token) {
  if (typeof token !== "string" || token.length === 0) fail("missing-token")
  if (/[\r\n]/.test(token)) fail("invalid-token")
}

function pathParts(value) {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > MAX_PATH_LENGTH ||
    value.includes("\u0000")
  ) {
    unreviewable("invalid-path")
  }
  if (value.startsWith("/") || value.endsWith("/")) unreviewable("invalid-path")
  const parts = value.split("/")
  if (parts.some((part) => part.length === 0 || part === "." || part === "..")) {
    unreviewable("invalid-path")
  }
  return parts
}

function isRegularEntry(entry) {
  return (
    entry &&
    entry.type === "blob" &&
    typeof entry.mode === "string" &&
    REGULAR_MODES.has(entry.mode) &&
    isSha(entry.sha)
  )
}

function validTreeEntry(entry) {
  return (
    entry &&
    typeof entry === "object" &&
    typeof entry.path === "string" &&
    entry.path.length > 0 &&
    typeof entry.mode === "string" &&
    typeof entry.type === "string" &&
    isSha(entry.sha) &&
    (entry.size === undefined || (Number.isInteger(entry.size) && entry.size >= 0))
  )
}

async function readBoundedResponse(response, maxBytes) {
  const tooLarge = () => new UnreviewableError("response-too-large")
  if (response.body && typeof response.body.getReader === "function") {
    const reader = response.body.getReader()
    const chunks = []
    let total = 0
    try {
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        const chunk = Buffer.from(value)
        total += chunk.length
        if (total > maxBytes) {
          if (typeof reader.cancel === "function") await reader.cancel().catch(() => {})
          throw tooLarge()
        }
        chunks.push(chunk)
      }
    } finally {
      try {
        reader.releaseLock?.()
      } catch {
        // The bounded read result or error is authoritative.
      }
    }
    return Buffer.concat(chunks, total).toString("utf8")
  }
  if (typeof response.text === "function") {
    const text = await response.text()
    if (Buffer.byteLength(text, "utf8") > maxBytes) throw tooLarge()
    return text
  }
  if (typeof response.json === "function") {
    // Test seam only. Production fetch always exposes a bounded body stream.
    const value = await response.json()
    const text = JSON.stringify(value)
    if (Buffer.byteLength(text, "utf8") > maxBytes) throw tooLarge()
    return text
  }
  throw new UnreviewableError("invalid-response")
}

function httpReason(status) {
  return Number.isInteger(status) && status >= 100 && status <= 599 ? `http-${status}` : "http-error"
}

async function requestJsonBounded({ fetchImpl, token, url, maxResponseBytes }) {
  let response
  try {
    response = await fetchImpl(url, {
      headers: githubHeaders(token),
      redirect: "error",
    })
  } catch {
    unreviewable("network-error")
  }
  if (!response || typeof response.ok !== "boolean") unreviewable("network-error")
  if (!response.ok) unreviewable(httpReason(response.status))
  let text
  try {
    text = await readBoundedResponse(response, maxResponseBytes)
  } catch (error) {
    if (error instanceof UnreviewableError) throw error
    unreviewable("network-error")
  }
  try {
    return JSON.parse(text)
  } catch {
    unreviewable("invalid-json")
  }
}

function strictBase64(content) {
  if (typeof content !== "string") unreviewable("invalid-blob-response")
  if (!/^[A-Za-z0-9+/=\n]*$/.test(content)) unreviewable("invalid-base64")
  const compact = content.replace(/\n/g, "")
  if (compact.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(compact)) {
    unreviewable("invalid-base64")
  }
  const bytes = Buffer.from(compact, "base64")
  if (bytes.toString("base64") !== compact) unreviewable("invalid-base64")
  return { bytes }
}

function gitBlobSha(bytes) {
  const hash = createHash("sha1")
  hash.update(`blob ${bytes.length}\u0000`)
  hash.update(bytes)
  return hash.digest("hex")
}

function estimateDecodedBytes(content) {
  if (typeof content !== "string") return 0
  const compact = content.replace(/\n/g, "")
  return Math.floor((compact.length * 3) / 4)
}

function buildGitEnvironment(tempDir) {
  const env = {
    PATH: process.env.PATH || "/usr/bin:/bin",
    HOME: tempDir,
    LANG: process.env.LANG || "C",
    TMPDIR: tempDir,
    XDG_CONFIG_HOME: tempDir,
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_SYSTEM: "/dev/null",
    GIT_ATTR_NOSYSTEM: "1",
    GIT_TERMINAL_PROMPT: "0",
    GIT_OPTIONAL_LOCKS: "0",
  }
  return env
}

function gitErrorReason(error) {
  const code = error && typeof error.code === "string" ? error.code : ""
  if (code === "git-timeout" || code === "timeout" || code === "ETIMEDOUT") return "diff-timeout"
  if (code === "git-output-limit" || code === "output-limit") return "diff-output-limit"
  return "diff-failed"
}

export function runGitDiff({ cwd, args, env, timeoutMs, maxOutputBytes }) {
  return new Promise((resolve, reject) => {
    let child
    try {
      child = spawn("git", args, {
        cwd,
        env,
        shell: false,
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
      })
    } catch {
      reject(Object.assign(new Error("git-spawn"), { code: "git-spawn" }))
      return
    }

    const stdout = []
    let stdoutBytes = 0
    let stderrBytes = 0
    let settled = false
    let timedOut = false
    let overflowed = false

    const finish = (error, result) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      if (error) reject(error)
      else resolve(result)
    }
    const timer = setTimeout(() => {
      timedOut = true
      try {
        child.kill("SIGKILL")
      } catch {
        // The close event still settles the promise.
      }
    }, timeoutMs)

    child.stdout?.on("data", (chunk) => {
      if (settled || overflowed) return
      stdoutBytes += chunk.length
      if (stdoutBytes > maxOutputBytes) {
        overflowed = true
        try {
          child.kill("SIGKILL")
        } catch {
          // The close event still settles the promise.
        }
        return
      }
      stdout.push(chunk)
    })
    child.stderr?.on("data", (chunk) => {
      if (settled) return
      stderrBytes += chunk.length
      if (stderrBytes > MAX_GIT_STDERR_BYTES) {
        try {
          child.kill("SIGKILL")
        } catch {
          // The close event still settles the promise.
        }
      }
    })
    child.on("error", () => {
      finish(Object.assign(new Error("git-spawn"), { code: "git-spawn" }))
    })
    child.on("close", (code, signal) => {
      if (timedOut) {
        finish(Object.assign(new Error("git-timeout"), { code: "git-timeout" }))
        return
      }
      if (overflowed || stderrBytes > MAX_GIT_STDERR_BYTES) {
        finish(Object.assign(new Error("git-output-limit"), { code: "git-output-limit" }))
        return
      }
      finish(null, {
        status: typeof code === "number" ? code : -1,
        signal,
        stdout: Buffer.concat(stdout, stdoutBytes),
      })
    })
  })
}

function extractPatch(stdout) {
  let start = 0
  while (start < stdout.length) {
    let end = stdout.indexOf(0x0a, start)
    if (end === -1) end = stdout.length
    const line = stdout.subarray(start, end).toString("utf8")
    if (HUNK_HEADER.test(line)) return stdout.subarray(start).toString("utf8")
    start = end + 1
  }
  return null
}

function ownedTempRoot() {
  try {
    const cwd = fs.realpathSync(process.cwd())
    const root = fs.realpathSync(os.tmpdir())
    if (root === cwd || root.startsWith(`${cwd}${path.sep}`)) unreviewable("unsafe-temp")
    return root
  } catch (error) {
    if (error instanceof UnreviewableError) throw error
    unreviewable("unsafe-temp")
  }
}

async function createPatch(oldBytes, newBytes, { gitRunner, limits }) {
  const tempDir = fs.mkdtempSync(path.join(ownedTempRoot(), "habi-review-patch-"))
  try {
    fs.chmodSync(tempDir, 0o700)
    fs.writeFileSync(path.join(tempDir, "old.txt"), oldBytes, { flag: "wx", mode: 0o600 })
    fs.writeFileSync(path.join(tempDir, "new.txt"), newBytes, { flag: "wx", mode: 0o600 })

    let result
    try {
      result = await gitRunner({
        cwd: tempDir,
        args: GIT_DIFF_ARGS,
        env: buildGitEnvironment(tempDir),
        timeoutMs: limits.gitTimeoutMs,
        maxOutputBytes: limits.maxPatchBytes,
      })
    } catch (error) {
      if (error instanceof UnreviewableError) throw error
      unreviewable(gitErrorReason(error))
    }

    if (!result || !Number.isInteger(result.status)) unreviewable("diff-failed")
    if (result.status === 0) return null
    if (result.status !== 1) unreviewable("diff-failed")

    const stdout = Buffer.isBuffer(result.stdout)
      ? result.stdout
      : Buffer.from(typeof result.stdout === "string" ? result.stdout : "", "utf8")
    if (stdout.length > limits.maxPatchBytes) unreviewable("diff-output-limit")
    const patch = extractPatch(stdout)
    if (!patch) unreviewable("diff-failed")
    if (Buffer.byteLength(patch, "utf8") > limits.maxPatchBytes) unreviewable("diff-output-limit")
    return patch
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true })
  }
}

/**
 * Resolve the immutable PR comparison/merge-base commit for the event base
 * tip and head. The comparison endpoint is used only as a GitHub metadata
 * source; no Git fetch or untrusted code runs. Returns a lower 40-hex SHA and
 * never falls back to the base tip when comparison metadata is unavailable.
 */
export async function resolveComparisonBaseSha({
  repo,
  baseSha,
  headSha,
  token,
  apiUrl = "https://api.github.com",
  fetchImpl = fetch,
  limits,
}) {
  if (!isSafeRepo(repo)) fail("invalid-repo")
  if (!isSha(baseSha) || !isSha(headSha)) fail("invalid-identity")
  if (typeof fetchImpl !== "function") fail("invalid-fetch")
  const bounded = normalizeLimits(limits)
  const apiBase = normalizeApiUrl(apiUrl)
  validateToken(token)

  const baseTip = baseSha.toLowerCase()
  const head = headSha.toLowerCase()
  const url = `${apiBase}/repos/${repoPath(repo)}/compare/${baseTip}...${head}?per_page=1`

  let data
  try {
    data = await requestJsonBounded({
      fetchImpl,
      token,
      url,
      maxResponseBytes: bounded.maxResponseBytes,
    })
  } catch (error) {
    if (error instanceof UnreviewableError) fail("comparison-error")
    throw error
  }

  if (!data || typeof data !== "object" || Array.isArray(data)) fail("comparison-error")
  const baseCommit = data.base_commit
  if (
    !baseCommit ||
    typeof baseCommit !== "object" ||
    !isSha(baseCommit.sha) ||
    baseCommit.sha.toLowerCase() !== baseTip
  ) {
    fail("comparison-error")
  }
  const mergeBase = data.merge_base_commit
  if (!mergeBase || typeof mergeBase !== "object" || !isSha(mergeBase.sha)) {
    fail("comparison-error")
  }
  return mergeBase.sha.toLowerCase()
}

/**
 * Recover patches GitHub omitted for otherwise supported changed files.
 *
 * `baseSha` is the immutable PR comparison/merge-base commit supplied by the
 * caller; it is not required to be the event base-branch tip. Only
 * missing/empty patches are recovered. Existing nonempty API patches are
 * cloned byte-for-byte and never trigger a request. All failures are explicit
 * unreviewable recoveries; no placeholder patch is ever produced.
 */
export async function recoverMissingPatches({
  repo,
  baseSha,
  headSha,
  files,
  token,
  apiUrl = "https://api.github.com",
  fetchImpl = fetch,
  gitRunner = runGitDiff,
  limits,
}) {
  if (!isSafeRepo(repo)) fail("invalid-repo")
  if (!isSha(baseSha) || !isSha(headSha)) fail("invalid-identity")
  if (!Array.isArray(files)) fail("invalid-files")
  if (typeof fetchImpl !== "function") fail("invalid-fetch")
  if (typeof gitRunner !== "function") fail("invalid-git-runner")

  const normalBase = baseSha.toLowerCase()
  const normalHead = headSha.toLowerCase()
  const bounded = normalizeLimits(limits)
  const apiBase = normalizeApiUrl(apiUrl)

  const output = files.map((file) => {
    if (!file || typeof file !== "object" || Array.isArray(file)) fail("invalid-files")
    if (typeof file.filename !== "string" || file.filename.length === 0) fail("invalid-files")
    return { ...file }
  })
  const attempts = []
  output.forEach((file) => {
    if (typeof file.patch === "string" && file.patch.length > 0) return
    attempts.push(file)
  })
  if (attempts.length === 0) return { files: output, recoveries: [] }

  validateToken(token)
  const api = {
    repo,
    token,
    baseSha: normalBase,
    headSha: normalHead,
    fetchImpl,
    apiBase,
    maxResponseBytes: bounded.maxResponseBytes,
    limits: bounded,
    commits: new Map(),
    trees: new Map(),
    paths: new Map(),
    blobs: new Map(),
    totalDecodedBytes: 0,
  }

  async function requestJson(url) {
    return requestJsonBounded({
      fetchImpl: api.fetchImpl,
      token: api.token,
      url,
      maxResponseBytes: api.maxResponseBytes,
    })
  }

  async function resolveCommitTree(commitSha) {
    const cached = api.commits.get(commitSha)
    if (cached) return cached
    const data = await requestJson(
      `${apiBase}/repos/${repoPath(api.repo)}/git/commits/${commitSha}`,
    )
    const treeSha = data?.tree?.sha ?? data?.commit?.tree?.sha
    if (!isSha(treeSha)) unreviewable("tree-unavailable")
    const normal = treeSha.toLowerCase()
    api.commits.set(commitSha, normal)
    return normal
  }

  async function resolveTree(treeSha) {
    const cached = api.trees.get(treeSha)
    if (cached) return cached
    const data = await requestJson(`${apiBase}/repos/${repoPath(api.repo)}/git/trees/${treeSha}`)
    if (!data || !Array.isArray(data.tree) || data.truncated === true) {
      unreviewable("tree-unavailable")
    }
    if (data.sha !== undefined && (!isSha(data.sha) || data.sha.toLowerCase() !== treeSha)) {
      unreviewable("tree-unavailable")
    }
    if (!data.tree.every(validTreeEntry)) unreviewable("tree-unavailable")
    api.trees.set(treeSha, data.tree)
    return data.tree
  }

  async function resolveEntry(commitSha, parts) {
    const key = `${commitSha}\u0000${parts.join("/")}`
    const cached = api.paths.get(key)
    if (cached) return cached
    let treeSha = await resolveCommitTree(commitSha)
    let entry = null
    for (let index = 0; index < parts.length; index += 1) {
      const tree = await resolveTree(treeSha)
      const match = tree.find((candidate) => candidate.path === parts[index])
      if (!match) unreviewable("tree-unavailable")
      if (index === parts.length - 1) {
        entry = { ...match, sha: match.sha.toLowerCase() }
        break
      }
      if (match.type !== "tree" || !isSha(match.sha)) unreviewable("tree-unavailable")
      treeSha = match.sha.toLowerCase()
    }
    api.paths.set(key, entry)
    return entry
  }

  async function getBlob(blobSha) {
    const cached = api.blobs.get(blobSha)
    if (cached) {
      if (cached.ok) return cached.bytes
      unreviewable(cached.reason)
    }

    const url = `${apiBase}/repos/${repoPath(api.repo)}/git/blobs/${blobSha}`
    let data
    try {
      data = await requestJson(url)
    } catch (error) {
      if (error instanceof UnreviewableError) {
        api.blobs.set(blobSha, { ok: false, reason: error.reason })
      }
      throw error
    }
    let charged = false
    try {
      if (!data || typeof data !== "object" || Array.isArray(data)) {
        unreviewable("invalid-blob-response")
      }
      if (data.sha !== undefined && (!isSha(data.sha) || data.sha.toLowerCase() !== blobSha)) {
        unreviewable("sha-mismatch")
      }
      if (!Number.isInteger(data.size) || data.size < 0) unreviewable("invalid-blob-response")
      if (data.encoding !== "base64" || typeof data.content !== "string") {
        unreviewable("invalid-blob-response")
      }
      if (data.size > api.limits.maxBlobBytes) unreviewable("blob-too-large")
      if (api.totalDecodedBytes + data.size > api.limits.maxTotalBytes) {
        unreviewable("budget-exceeded")
      }

      const { bytes } = strictBase64(data.content)
      // Count decoded content before any integrity check. Binary, oversized,
      // mismatched, or invalid-encoding results still consume the shared
      // budget so repeated files cannot bypass it.
      api.totalDecodedBytes += bytes.length
      charged = true
      if (bytes.length > api.limits.maxBlobBytes) unreviewable("blob-too-large")
      if (api.totalDecodedBytes > api.limits.maxTotalBytes) unreviewable("budget-exceeded")
      if (bytes.length !== data.size) unreviewable("size-mismatch")
      if (gitBlobSha(bytes) !== blobSha) unreviewable("hash-mismatch")
      // Supported-text heuristic, not universal binary detection: a NUL byte
      // or a non-UTF-8 round trip cannot be rendered as reviewable text.
      if (bytes.includes(0)) unreviewable("binary-content")
      const text = bytes.toString("utf8")
      if (!Buffer.from(text, "utf8").equals(bytes)) unreviewable("invalid-utf8")

      api.blobs.set(blobSha, { ok: true, bytes })
      return bytes
    } catch (error) {
      if (error instanceof UnreviewableError) {
        if (!charged) {
          // There is no canonical decoded buffer to measure. Charge a
          // conservative base64 expansion estimate so invalid, binary, or
          // integrity-failed input cannot become an unmetered path.
          api.totalDecodedBytes += estimateDecodedBytes(data?.content)
        }
        api.blobs.set(blobSha, { ok: false, reason: error.reason })
      }
      throw error
    }
  }

  function checkEntry(entry) {
    if (!isRegularEntry(entry)) unreviewable("not-regular-file")
    if (Number.isInteger(entry.size) && entry.size > api.limits.maxBlobBytes) {
      unreviewable("blob-too-large")
    }
  }

  async function recover(file) {
    const status = typeof file.status === "string" ? file.status : "unknown"
    const emptyBytes = {
      baseBytes: status === "added" ? 0 : undefined,
      headBytes: status === "removed" ? 0 : undefined,
    }
    let baseParts = null
    let headParts = null

    try {
      const headPartsValue = pathParts(file.filename)
      if (!SUPPORTED_STATUSES.has(status)) unreviewable("unsupported-status")
      if (status === "added") {
        headParts = headPartsValue
      } else if (status === "removed") {
        baseParts = headPartsValue
      } else if (status === "modified") {
        baseParts = headPartsValue
        headParts = headPartsValue
      } else {
        if (typeof file.previousFilename !== "string" || file.previousFilename.length === 0) {
          unreviewable("missing-previous-filename")
        }
        baseParts = pathParts(file.previousFilename)
        headParts = headPartsValue
      }
    } catch (error) {
      return unreviewableResult(file, error, emptyBytes)
    }

    let baseEntry = null
    let headEntry = null
    try {
      if (baseParts) baseEntry = await resolveEntry(api.baseSha, baseParts)
      if (headParts) headEntry = await resolveEntry(api.headSha, headParts)
    } catch (error) {
      return unreviewableResult(file, error, { ...emptyBytes, baseEntry, headEntry })
    }

    try {
      if (baseEntry !== null) checkEntry(baseEntry)
      if (headEntry !== null) checkEntry(headEntry)
      const expectedSha =
        typeof file.sha === "string" && isSha(file.sha) ? file.sha.toLowerCase() : null
      if (expectedSha) {
        const compared = status === "removed" ? baseEntry : headEntry
        if (!compared || compared.sha.toLowerCase() !== expectedSha) {
          unreviewable("sha-mismatch")
        }
      }
    } catch (error) {
      return unreviewableResult(file, error, { ...emptyBytes, baseEntry, headEntry })
    }

    let baseBytes = status === "added" ? Buffer.alloc(0) : null
    let headBytes = status === "removed" ? Buffer.alloc(0) : null
    try {
      if (baseEntry !== null) baseBytes = await getBlob(baseEntry.sha)
      if (headEntry !== null) headBytes = await getBlob(headEntry.sha)
      if (baseEntry && Number.isInteger(baseEntry.size) && baseEntry.size !== baseBytes.length) {
        unreviewable("size-mismatch")
      }
      if (headEntry && Number.isInteger(headEntry.size) && headEntry.size !== headBytes.length) {
        unreviewable("size-mismatch")
      }
    } catch (error) {
      return unreviewableResult(file, error, {
        baseEntry,
        headEntry,
        baseBytes: baseBytes ? baseBytes.length : status === "added" ? 0 : null,
        headBytes: headBytes ? headBytes.length : status === "removed" ? 0 : null,
      })
    }

    let patch
    try {
      patch = await createPatch(baseBytes, headBytes, { gitRunner, limits: api.limits })
    } catch (error) {
      return unreviewableResult(file, error, {
        baseEntry,
        headEntry,
        baseBytes: baseBytes.length,
        headBytes: headBytes.length,
      })
    }
    if (!patch) {
      return unreviewableResult(
        file,
        new UnreviewableError("metadata-only"),
        {
          baseEntry,
          headEntry,
          baseBytes: baseBytes.length,
          headBytes: headBytes.length,
        },
      )
    }
    return {
      recovered: true,
      baseBlobSha: baseEntry ? baseEntry.sha : null,
      headBlobSha: headEntry ? headEntry.sha : null,
      baseBytes: baseBytes.length,
      headBytes: headBytes.length,
      patch,
    }
  }

  function unreviewableResult(file, error, extra = {}) {
    const reason = error instanceof UnreviewableError ? error.reason : "unexpected-error"
    return {
      recovered: false,
      reason,
      baseBlobSha: extra.baseEntry?.sha ?? null,
      headBlobSha: extra.headEntry?.sha ?? null,
      baseBytes: extra.baseBytes ?? null,
      headBytes: extra.headBytes ?? null,
    }
  }

  const recoveries = []
  for (const file of attempts) {
    const result = await recover(file)
    if (result.recovered) {
      file.patch = result.patch
      file.patchSource = "immutable-blob-diff"
      delete file.patchReason
    } else {
      file.patch = typeof file.patch === "string" ? file.patch : null
      file.patchReason = result.reason
    }
    recoveries.push({
      filename: file.filename,
      status: result.recovered ? "recovered" : "unreviewable",
      patchSource: "immutable-blob-diff",
      baseBlobSha: result.baseBlobSha,
      headBlobSha: result.headBlobSha,
      baseBytes: result.baseBytes,
      headBytes: result.headBytes,
      reason: result.recovered ? null : result.reason,
    })
  }
  recoveries.sort((left, right) => {
    if (left.filename < right.filename) return -1
    if (left.filename > right.filename) return 1
    return 0
  })

  return { files: output, recoveries }
}
