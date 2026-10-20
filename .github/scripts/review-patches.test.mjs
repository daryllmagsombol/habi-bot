import test from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { Buffer } from "node:buffer"
import { createHash } from "node:crypto"
import {
  PATCH_LIMITS,
  recoverMissingPatches,
  resolveComparisonBaseSha,
} from "./review-patches.mjs"

const REPO = "daryllmagsombol/habi-bot"
const BASE = "a".repeat(40)
const HEAD = "b".repeat(40)
const API = "http://api.test"
const TOKEN = "test-token"
const GIT_ENV_KEYS = [
  "GIT_ATTR_NOSYSTEM",
  "GIT_CONFIG_GLOBAL",
  "GIT_CONFIG_NOSYSTEM",
  "GIT_CONFIG_SYSTEM",
  "GIT_OPTIONAL_LOCKS",
  "GIT_TERMINAL_PROMPT",
  "HOME",
  "LANG",
  "PATH",
  "TMPDIR",
  "XDG_CONFIG_HOME",
]

function gitSha(bytes) {
  return createHash("sha1").update(`blob ${bytes.length}\u0000`).update(bytes).digest("hex")
}

function fakeSha(value) {
  return createHash("sha1").update(String(value)).digest("hex")
}

function bytesOf(value) {
  if (Buffer.isBuffer(value)) return value
  return Buffer.from(value ?? "", "utf8")
}

function wrapBase64(bytes) {
  return bytes.toString("base64").replace(/(.{60})/g, "$1\n")
}

function jsonResponse(value, status = 200) {
  return new Response(typeof value === "string" ? value : JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json" },
  })
}

function entryValue(raw) {
  if (typeof raw === "string" || Buffer.isBuffer(raw)) return { bytes: raw }
  return raw
}

function treeFixture(spec) {
  const blobs = new Map()
  const trees = new Map()
  const root = {}
  for (const [filePath, raw] of Object.entries(spec)) {
    const value = entryValue(raw)
    const parts = filePath.split("/")
    let node = root
    for (let index = 0; index < parts.length - 1; index += 1) {
      node[parts[index]] ??= { children: {} }
      if (!node[parts[index]].children) throw new Error(`path conflict: ${filePath}`)
      node = node[parts[index]].children
    }
    const name = parts[parts.length - 1]
    if (value.mode === "160000") {
      node[name] = {
        entry: { path: name, mode: "160000", type: "commit", sha: value.sha },
      }
      continue
    }
    const bytes = bytesOf(value.bytes)
    const sha = value.sha ?? gitSha(bytes)
    if (value.sha === undefined) blobs.set(sha, bytes)
    node[name] = {
      entry: {
        path: name,
        mode: value.mode ?? "100644",
        type: value.type ?? "blob",
        sha,
        size: value.size ?? bytes.length,
      },
    }
  }
  function emit(node) {
    const entries = []
    for (const name of Object.keys(node).sort()) {
      const value = node[name]
      if (value.children) {
        const sha = emit(value.children)
        entries.push({ path: name, mode: "040000", type: "tree", sha })
      } else {
        entries.push(value.entry)
      }
    }
    const sha = fakeSha(JSON.stringify(entries))
    trees.set(sha, entries)
    return sha
  }
  return { rootSha: emit(root), trees, blobs }
}

function specSha(spec, filePath) {
  const value = entryValue(spec[filePath])
  if (value.sha) return value.sha
  return gitSha(bytesOf(value.bytes))
}

function makeApi({
  baseSpec = {},
  headSpec = {},
  truncateTrees = false,
  networkError = false,
  invalidJson = false,
  blobOverrides,
} = {}) {
  const base = treeFixture(baseSpec)
  const head = treeFixture(headSpec)
  const commits = new Map([
    [BASE, base.rootSha],
    [HEAD, head.rootSha],
  ])
  const trees = new Map([...base.trees, ...head.trees])
  const blobs = new Map([...base.blobs, ...head.blobs])
  const requests = []
  async function fetchImpl(url, init = {}) {
    requests.push({ url, init })
    if (networkError) throw new Error("network down")
    if (invalidJson) return jsonResponse("{")
    const match = new URL(url).pathname.match(
      /^\/repos\/[^/]+\/[^/]+\/git\/(commits|trees|blobs)\/([0-9a-f]{40})$/,
    )
    if (!match) return jsonResponse({ message: "bad path" }, 404)
    const [, kind, sha] = match
    if (kind === "commits") {
      const tree = commits.get(sha)
      if (!tree) return jsonResponse({ message: "not found" }, 404)
      return jsonResponse({ sha, tree: { sha: tree } })
    }
    if (kind === "trees") {
      const entries = trees.get(sha)
      if (!entries) return jsonResponse({ message: "not found" }, 404)
      return jsonResponse({ sha, tree: entries, truncated: truncateTrees })
    }
    const bytes = blobs.get(sha)
    if (!bytes) return jsonResponse({ message: "not found" }, 404)
    let payload = { sha, size: bytes.length, encoding: "base64", content: wrapBase64(bytes) }
    if (blobOverrides) payload = { ...payload, ...blobOverrides({ sha, bytes }) }
    return jsonResponse(payload)
  }
  return {
    fetchImpl,
    requests,
    commits,
    trees,
    blobs,
    baseSpec,
    headSpec,
    baseSha: (filePath) => specSha(baseSpec, filePath),
    headSha: (filePath) => specSha(headSpec, filePath),
  }
}

function missingFile(filename, status = "modified", extra = {}) {
  return { filename, status, patch: null, sha: null, additions: 0, deletions: 0, changes: 0, ...extra }
}

function patchFile(filename, patch, extra = {}) {
  return { ...missingFile(filename, "modified"), patch, ...extra }
}

function call(api, files, overrides = {}) {
  return recoverMissingPatches({
    repo: REPO,
    baseSha: BASE,
    headSha: HEAD,
    files,
    token: TOKEN,
    apiUrl: API,
    fetchImpl: api.fetchImpl,
    ...overrides,
  })
}

function recovery(result, filename) {
  return result.recoveries.find((item) => item.filename === filename)
}

function assertUnreviewable(result, filename, reason) {
  const item = recovery(result, filename)
  assert.ok(item, `missing recovery for ${filename}`)
  assert.equal(item.status, "unreviewable")
  assert.equal(item.patchSource, "immutable-blob-diff")
  assert.equal(item.reason, reason)
  const file = result.files.find((candidate) => candidate.filename === filename)
  assert.ok(file)
  assert.ok(file.patch === null || file.patch === "")
  assert.equal(file.patchSource, undefined)
}

function patchTempDirs() {
  return fs
    .readdirSync(os.tmpdir())
    .filter((name) => name.startsWith("habi-review-patch-"))
    .sort()
}

function withEnv(values, callback) {
  const saved = new Map()
  for (const key of Object.keys(values)) {
    saved.set(key, Object.hasOwn(process.env, key) ? process.env[key] : undefined)
    if (values[key] === undefined) delete process.env[key]
    else process.env[key] = values[key]
  }
  return Promise.resolve()
    .then(callback)
    .finally(() => {
      for (const [key, value] of saved) {
        if (value === undefined) delete process.env[key]
        else process.env[key] = value
      }
    })
}

test("recovers added, removed, modified, renamed, mode, and empty-patch files", async () => {
  const api = makeApi({
    baseSpec: {
      "keep.txt": "same\n",
      "mod.txt": "a\nb\nc\n",
      "gone.txt": "bye\n",
      "old/name.txt": "rename-a\n",
      "empty-patch.txt": "old\n",
      "exec.sh": "#!/bin/sh\n",
    },
    headSpec: {
      "keep.txt": "same\n",
      "mod.txt": "a\nB\nc\n",
      "add.txt": "hello\nworld\n",
      "new/name.txt": "rename-b\n",
      "empty-patch.txt": "new\n",
      "tool.sh": "echo hi\n",
      "weird/a b#c%.txt": "safe path\n",
    },
  })
  const files = [
    missingFile("add.txt", "added", { sha: api.headSha("add.txt") }),
    missingFile("gone.txt", "removed", { sha: api.baseSha("gone.txt") }),
    missingFile("mod.txt", "modified", { sha: api.headSha("mod.txt") }),
    missingFile("new/name.txt", "renamed", {
      previousFilename: "old/name.txt",
      sha: api.headSha("new/name.txt"),
    }),
    { ...missingFile("empty-patch.txt", "modified", { sha: api.headSha("empty-patch.txt") }), patch: "" },
    missingFile("tool.sh", "added", { sha: api.headSha("tool.sh") }),
    missingFile("weird/a b#c%.txt", "added", { sha: api.headSha("weird/a b#c%.txt") }),
    patchFile("api.txt", "@@ -1 +1 @@\n-a\n+b\n"),
  ]

  const result = await call(api, files)

  const apiFile = result.files.find((file) => file.filename === "api.txt")
  assert.equal(apiFile.patch, "@@ -1 +1 @@\n-a\n+b\n")
  assert.equal(apiFile.patchSource, undefined)

  const added = result.files.find((file) => file.filename === "add.txt")
  assert.match(added.patch, /^@@ -0,0 \+1,2 @@/)
  assert.ok(added.patch.includes("+hello\n+world\n"))
  assert.equal(added.patchSource, "immutable-blob-diff")
  assert.ok(!added.patch.includes("diff --git"))
  assert.ok(!added.patch.includes("old.txt"))
  assert.ok(!added.patch.includes("new.txt"))

  const removed = result.files.find((file) => file.filename === "gone.txt")
  assert.match(removed.patch, /^@@ -1 \+0,0 @@/)
  assert.ok(removed.patch.includes("-bye\n"))

  const modified = result.files.find((file) => file.filename === "mod.txt")
  assert.ok(modified.patch.includes("-b\n+B\n"))

  const renamed = result.files.find((file) => file.filename === "new/name.txt")
  assert.ok(renamed.patch.includes("-rename-a\n+rename-b\n"))

  const emptyPatch = result.files.find((file) => file.filename === "empty-patch.txt")
  assert.ok(emptyPatch.patch.includes("-old\n+new\n"))

  const tool = result.files.find((file) => file.filename === "tool.sh")
  assert.equal(tool.patchSource, "immutable-blob-diff")
  const weird = result.files.find((file) => file.filename === "weird/a b#c%.txt")
  assert.ok(weird.patch.includes("+safe path\n"))

  assert.deepEqual(
    result.recoveries.map((item) => item.filename),
    ["add.txt", "empty-patch.txt", "gone.txt", "mod.txt", "new/name.txt", "tool.sh", "weird/a b#c%.txt"],
  )
  for (const item of result.recoveries) {
    assert.equal(item.status, "recovered")
    assert.equal(item.patchSource, "immutable-blob-diff")
    assert.equal(item.reason, null)
  }
  const addRecovery = recovery(result, "add.txt")
  assert.equal(addRecovery.baseBlobSha, null)
  assert.equal(addRecovery.baseBytes, 0)
  assert.equal(addRecovery.headBytes, Buffer.byteLength("hello\nworld\n"))
  const removeRecovery = recovery(result, "gone.txt")
  assert.equal(removeRecovery.headBlobSha, null)
  assert.equal(removeRecovery.headBytes, 0)

  const first = JSON.parse(JSON.stringify(result))
  const second = await call(api, files)
  assert.deepEqual(second.files, first.files)
  assert.deepEqual(second.recoveries, first.recoveries)
})

test("recovers empty added files and identical content as honest metadata-only gaps", async () => {
  const api = makeApi({
    baseSpec: { "same.txt": "same\n", "mode-only.sh": "echo hi\n" },
    headSpec: {
      "same.txt": "same\n",
      "mode-only.sh": { bytes: "echo hi\n", mode: "100755" },
      "empty.txt": "",
    },
  })
  const files = [
    missingFile("empty.txt", "added", { sha: api.headSha("empty.txt") }),
    missingFile("same.txt", "modified", { sha: api.headSha("same.txt") }),
    missingFile("mode-only.sh", "modified", { sha: api.headSha("mode-only.sh") }),
  ]
  const result = await call(api, files)
  for (const filename of ["empty.txt", "same.txt", "mode-only.sh"]) {
    assertUnreviewable(result, filename, "metadata-only")
    assert.equal(result.files.find((file) => file.filename === filename).patchReason, "metadata-only")
  }
})

test("rejects symlinks, submodules, unsafe paths, and unsupported statuses before reading", async () => {
  const api = makeApi({
    baseSpec: { "ok.txt": "old\n" },
    headSpec: {
      "ok.txt": "new\n",
      link: { bytes: "target", mode: "120000" },
      sub: { mode: "160000", sha: "d".repeat(40) },
      "exec.sh": { bytes: "echo hi\n", mode: "100755" },
    },
  })
  const files = [
    missingFile("link", "added", { sha: api.headSha("link") }),
    missingFile("sub", "added", { sha: api.headSha("sub") }),
    missingFile("exec.sh", "added", { sha: api.headSha("exec.sh") }),
    missingFile("ok.txt", "modified", { sha: api.headSha("ok.txt") }),
    missingFile("missing.txt", "modified"),
    missingFile("copied.txt", "copied"),
    missingFile("renamed.txt", "renamed"),
    missingFile("renamed-bad.txt", "renamed", { previousFilename: "../evil" }),
  ]
  const result = await call(api, files)
  assertUnreviewable(result, "link", "not-regular-file")
  assertUnreviewable(result, "sub", "not-regular-file")
  assertUnreviewable(result, "missing.txt", "tree-unavailable")
  assertUnreviewable(result, "copied.txt", "unsupported-status")
  assertUnreviewable(result, "renamed.txt", "missing-previous-filename")
  assertUnreviewable(result, "renamed-bad.txt", "invalid-path")
  assert.equal(recovery(result, "exec.sh").status, "recovered")
  assert.equal(recovery(result, "ok.txt").status, "recovered")

  const linkBlob = api.headSha("link")
  const subBlob = "d".repeat(40)
  assert.ok(!api.requests.some((request) => request.url.endsWith(`/git/blobs/${linkBlob}`)))
  assert.ok(!api.requests.some((request) => request.url.endsWith(`/git/blobs/${subBlob}`)))

  const invalid = await call(
    makeApi(),
    [
      missingFile("../evil", "modified"),
      missingFile("a//b", "modified"),
      missingFile("/abs", "modified"),
      missingFile("a/./b", "modified"),
      missingFile("a/..", "modified"),
      missingFile("a\u0000b", "modified"),
      missingFile("copied.txt", "copied"),
      missingFile("renamed.txt", "renamed"),
    ],
    { fetchImpl: async () => assert.fail("no request expected") },
  )
  for (const filename of ["../evil", "a//b", "/abs", "a/./b", "a/..", "a\u0000b"]) {
    assertUnreviewable(invalid, filename, "invalid-path")
  }
  assertUnreviewable(invalid, "copied.txt", "unsupported-status")
  assertUnreviewable(invalid, "renamed.txt", "missing-previous-filename")
})

test("preserves BOM, CRLF, UTF-8, and final-newline state; rejects NUL and invalid UTF-8", async () => {
  const bom = Buffer.from("\ufeffline1\r\nline2", "utf8")
  const invalid = Buffer.from([0xff, 0xfe, 0x0a])
  const nul = Buffer.from([0x61, 0x00, 0x62])
  const api = makeApi({
    baseSpec: {},
    headSpec: {
      "bom.txt": bom,
      "utf8.txt": "héllo\n",
      "invalid.txt": invalid,
      "nul.txt": nul,
    },
  })
  const files = [
    missingFile("bom.txt", "added", { sha: api.headSha("bom.txt") }),
    missingFile("utf8.txt", "added", { sha: api.headSha("utf8.txt") }),
    missingFile("invalid.txt", "added", { sha: api.headSha("invalid.txt") }),
    missingFile("nul.txt", "added", { sha: api.headSha("nul.txt") }),
  ]
  const result = await call(api, files)
  const bomFile = result.files.find((file) => file.filename === "bom.txt")
  assert.ok(bomFile.patch.includes("+\ufeffline1\r\n"))
  assert.ok(bomFile.patch.includes("+line2\n\\ No newline at end of file\n"))
  const utf8File = result.files.find((file) => file.filename === "utf8.txt")
  assert.ok(utf8File.patch.includes("+héllo\n"))
  assertUnreviewable(result, "invalid.txt", "invalid-utf8")
  assertUnreviewable(result, "nul.txt", "binary-content")
  assert.equal(result.files.find((file) => file.filename === "invalid.txt").patch, null)
  assert.equal(result.files.find((file) => file.filename === "nul.txt").patch, null)
})

test("validates base64, declared size, blob hashes, and response bounds", async () => {
  const api = makeApi({ baseSpec: {}, headSpec: { "a.txt": "content\n" } })
  const sha = api.headSha("a.txt")
  const file = () => [missingFile("a.txt", "added", { sha })]

  const badBase64 = makeApi({
    baseSpec: {},
    headSpec: { "a.txt": "content\n" },
    blobOverrides: () => ({ content: "not base64!" }),
  })
  const bad = await call(badBase64, file())
  assertUnreviewable(bad, "a.txt", "invalid-base64")

  const badSize = makeApi({
    baseSpec: {},
    headSpec: { "a.txt": "content\n" },
    blobOverrides: ({ bytes }) => ({ size: bytes.length + 1 }),
  })
  const sizeResult = await call(badSize, file())
  assertUnreviewable(sizeResult, "a.txt", "size-mismatch")

  const badHash = makeApi({
    baseSpec: {},
    headSpec: { "a.txt": "content\n" },
    blobOverrides: () => ({ content: wrapBase64(Buffer.from("other\n")), size: 6 }),
  })
  const hashResult = await call(badHash, file())
  assertUnreviewable(hashResult, "a.txt", "hash-mismatch")

  const badTreeSize = makeApi({
    baseSpec: {},
    headSpec: { "a.txt": { bytes: "content\n", size: 999 } },
  })
  const treeSizeResult = await call(badTreeSize, [
    missingFile("a.txt", "added", { sha: badTreeSize.headSha("a.txt") }),
  ])
  assertUnreviewable(treeSizeResult, "a.txt", "size-mismatch")

  const tooLarge = makeApi({
    baseSpec: {},
    headSpec: { "a.txt": "content\n" },
  })
  const largeResult = await call(tooLarge, file(), { limits: { maxBlobBytes: 4 } })
  assertUnreviewable(largeResult, "a.txt", "blob-too-large")

  const bounded = makeApi({ baseSpec: {}, headSpec: { "a.txt": "x".repeat(1_000) } })
  const boundedResult = await call(
    bounded,
    [missingFile("a.txt", "added", { sha: bounded.headSha("a.txt") })],
    { limits: { maxResponseBytes: 200 } },
  )
  assertUnreviewable(boundedResult, "a.txt", "response-too-large")

  const missingBlob = makeApi({
    baseSpec: {},
    headSpec: { "a.txt": { sha: "e".repeat(40), size: 1 } },
  })
  const missingResult = await call(missingBlob, [
    missingFile("a.txt", "added", { sha: missingBlob.headSha("a.txt") }),
  ])
  assertUnreviewable(missingResult, "a.txt", "http-404")

  const network = await call(makeApi({ networkError: true }), file())
  assertUnreviewable(network, "a.txt", "network-error")
  const json = await call(makeApi({ invalidJson: true }), file())
  assertUnreviewable(json, "a.txt", "invalid-json")

  assert.equal(badBase64.requests[0].init.redirect, "error")
  assert.equal(badBase64.requests[0].init.headers.Authorization, `Bearer ${TOKEN}`)
})

test("honors tree truncation and checks the files API SHA before fetching blobs", async () => {
  const truncated = makeApi({ baseSpec: {}, headSpec: { "a.txt": "content\n" }, truncateTrees: true })
  const truncatedResult = await call(truncated, [
    missingFile("a.txt", "added", { sha: truncated.headSha("a.txt") }),
  ])
  assertUnreviewable(truncatedResult, "a.txt", "tree-unavailable")

  const api = makeApi({
    baseSpec: { "gone.txt": "bye\n" },
    headSpec: { "a.txt": "content\n" },
  })
  const wrongHead = await call(api, [
    missingFile("a.txt", "added", { sha: "f".repeat(40) }),
  ])
  assertUnreviewable(wrongHead, "a.txt", "sha-mismatch")
  assert.ok(!api.requests.some((request) => request.url.includes("/git/blobs/")))

  const wrongRemove = await call(api, [
    missingFile("gone.txt", "removed", { sha: api.headSha("a.txt") }),
  ])
  assertUnreviewable(wrongRemove, "gone.txt", "sha-mismatch")
  assert.ok(!api.requests.some((request) => request.url.includes("/git/blobs/")))

  const uppercase = await call(api, [
    missingFile("a.txt", "added", { sha: api.headSha("a.txt").toUpperCase() }),
  ])
  assert.equal(recovery(uppercase, "a.txt").status, "recovered")

  const ignored = await call(api, [
    missingFile("a.txt", "added", { sha: "not-a-sha" }),
  ])
  assert.equal(recovery(ignored, "a.txt").status, "recovered")
})

test("caches commits, trees, and blobs including unreviewable results", async () => {
  const api = makeApi({
    baseSpec: { "one.txt": "base\n", "two.txt": "base\n" },
    headSpec: { "one.txt": "same head\n", "two.txt": "same head\n" },
  })
  const headSha = api.headSha("one.txt")
  const result = await call(api, [
    missingFile("one.txt", "modified", { sha: headSha }),
    missingFile("two.txt", "modified", { sha: headSha }),
  ])
  assert.equal(recovery(result, "one.txt").status, "recovered")
  assert.equal(recovery(result, "two.txt").status, "recovered")
  assert.equal(
    api.requests.filter((request) => request.url.endsWith(`/git/commits/${BASE}`)).length,
    1,
  )
  assert.equal(
    api.requests.filter((request) => request.url.endsWith(`/git/commits/${HEAD}`)).length,
    1,
  )
  assert.equal(
    api.requests.filter((request) => request.url.endsWith(`/git/blobs/${headSha}`)).length,
    1,
  )

  const invalidApi = makeApi({
    baseSpec: {},
    headSpec: { "bad-one.txt": "bad content\n", "bad-two.txt": "bad content\n" },
    blobOverrides: () => ({ content: "not base64!" }),
  })
  const invalidSha = invalidApi.headSha("bad-one.txt")
  const invalidResult = await call(invalidApi, [
    missingFile("bad-one.txt", "added", { sha: invalidSha }),
    missingFile("bad-two.txt", "added", { sha: invalidSha }),
  ])
  assertUnreviewable(invalidResult, "bad-one.txt", "invalid-base64")
  assertUnreviewable(invalidResult, "bad-two.txt", "invalid-base64")
  assert.equal(
    invalidApi.requests.filter((request) => request.url.endsWith(`/git/blobs/${invalidSha}`)).length,
    1,
  )

  const networkApi = makeApi({
    baseSpec: {},
    headSpec: { "one.txt": "same\n", "two.txt": "same\n" },
  })
  const networkSha = networkApi.headSha("one.txt")
  let blobCalls = 0
  const networkFetch = async (url, init) => {
    if (url.includes("/git/blobs/")) {
      blobCalls += 1
      throw new Error("blob network down")
    }
    return networkApi.fetchImpl(url, init)
  }
  const networkResult = await call(
    { fetchImpl: networkFetch },
    [
      missingFile("one.txt", "added", { sha: networkSha }),
      missingFile("two.txt", "added", { sha: networkSha }),
    ],
  )
  assertUnreviewable(networkResult, "one.txt", "network-error")
  assertUnreviewable(networkResult, "two.txt", "network-error")
  assert.equal(blobCalls, 1)
})

test("enforces cumulative decoded budgets without pretending completion", async () => {
  const shared = makeApi({
    baseSpec: {},
    headSpec: { "a.txt": "same\n", "b.txt": "same\n" },
  })
  const sharedSha = shared.headSha("a.txt")
  const sharedResult = await call(
    shared,
    [
      missingFile("a.txt", "added", { sha: sharedSha }),
      missingFile("b.txt", "added", { sha: sharedSha }),
    ],
    { limits: { maxTotalBytes: Buffer.byteLength("same\n") } },
  )
  assert.equal(recovery(sharedResult, "a.txt").status, "recovered")
  assert.equal(recovery(sharedResult, "b.txt").status, "recovered")
  assert.equal(
    shared.requests.filter((request) => request.url.endsWith(`/git/blobs/${sharedSha}`)).length,
    1,
  )

  const budget = makeApi({
    baseSpec: {},
    headSpec: { "a.txt": "aaaaaa", "b.txt": "bbbbbb" },
  })
  const budgetResult = await call(
    budget,
    [
      missingFile("a.txt", "added", { sha: budget.headSha("a.txt") }),
      missingFile("b.txt", "added", { sha: budget.headSha("b.txt") }),
    ],
    { limits: { maxTotalBytes: 6 } },
  )
  assert.equal(recovery(budgetResult, "a.txt").status, "recovered")
  assertUnreviewable(budgetResult, "b.txt", "budget-exceeded")
  assert.equal(budgetResult.files.find((file) => file.filename === "b.txt").patch, null)

  const mixedApi = makeApi({
    baseSpec: {},
    headSpec: { "bad.txt": "x", "ok.txt": "abc" },
    blobOverrides: ({ sha }) =>
      sha === mixedApi.headSha("bad.txt") ? { content: "!!!!", size: 0 } : {},
  })
  const mixed = await call(
    mixedApi,
    [
      missingFile("bad.txt", "added", { sha: mixedApi.headSha("bad.txt") }),
      missingFile("ok.txt", "added", { sha: mixedApi.headSha("ok.txt") }),
    ],
    { limits: { maxTotalBytes: 3 } },
  )
  assertUnreviewable(mixed, "bad.txt", "invalid-base64")
  assertUnreviewable(mixed, "ok.txt", "budget-exceeded")
})

test("handles Git failure, timeout, output overflow, and cleans owned temp directories", async () => {
  const api = makeApi({ baseSpec: {}, headSpec: { "a.txt": "content\n" } })
  const files = () => [missingFile("a.txt", "added", { sha: api.headSha("a.txt") })]
  const tempBefore = patchTempDirs()

  const failed = await call(api, files(), {
    gitRunner: async () => ({ status: 2, stdout: "" }),
  })
  assertUnreviewable(failed, "a.txt", "diff-failed")

  const timedOut = await call(api, files(), {
    gitRunner: async () => {
      throw Object.assign(new Error("timeout"), { code: "git-timeout" })
    },
  })
  assertUnreviewable(timedOut, "a.txt", "diff-timeout")

  const overflow = await call(api, files(), {
    gitRunner: async () => {
      throw Object.assign(new Error("overflow"), { code: "git-output-limit" })
    },
  })
  assertUnreviewable(overflow, "a.txt", "diff-output-limit")

  const noHunk = await call(api, files(), {
    gitRunner: async () => ({ status: 1, stdout: "diff --git a/old.txt b/new.txt\n" }),
  })
  assertUnreviewable(noHunk, "a.txt", "diff-failed")

  const noDiff = await call(api, files(), {
    gitRunner: async () => ({ status: 0, stdout: "" }),
  })
  assertUnreviewable(noDiff, "a.txt", "metadata-only")

  const oversized = await call(api, files(), {
    limits: { maxPatchBytes: 100 },
    gitRunner: async () => ({ status: 1, stdout: Buffer.alloc(101, 0x20) }),
  })
  assertUnreviewable(oversized, "a.txt", "diff-output-limit")

  const recovered = await call(api, files(), {
    gitRunner: async () => ({ status: 1, stdout: "@@ -0,0 +1 @@\n+x\n" }),
  })
  assert.equal(recovery(recovered, "a.txt").status, "recovered")
  assert.equal(recovered.files[0].patch, "@@ -0,0 +1 @@\n+x\n")

  const real = await call(api, files())
  assert.equal(recovery(real, "a.txt").status, "recovered")
  assert.deepEqual(patchTempDirs(), tempBefore)
})

test("does not pass inherited secrets, proxies, pagers, or external diff settings to Git", async () => {
  const api = makeApi({ baseSpec: {}, headSpec: { "a.txt": "content\n" } })
  const files = () => [missingFile("a.txt", "added", { sha: api.headSha("a.txt") })]
  let captured
  await withEnv(
    {
      GITHUB_TOKEN: "secret-token",
      ACTIONS_RUNTIME_TOKEN: "secret-actions",
      ACTIONS_ID_TOKEN_REQUEST_TOKEN: "secret-id",
      HTTPS_PROXY: "http://proxy.invalid",
      HTTP_PROXY: "http://proxy.invalid",
      NO_PROXY: "example.invalid",
      GIT_EXTERNAL_DIFF: "/tmp/evil-diff",
      GIT_CONFIG_COUNT: "1",
      GIT_CONFIG_KEY_0: "diff.external",
      GIT_CONFIG_VALUE_0: "/tmp/evil-diff",
      GIT_DIR: "/tmp/evil-git-dir",
      GIT_WORK_TREE: "/tmp/evil-work-tree",
      PAGER: "/tmp/evil-pager",
      GIT_PAGER: "/tmp/evil-git-pager",
    },
    async () => {
      await call(api, files(), {
        gitRunner: async (options) => {
          captured = options
          return { status: 1, stdout: "@@ -0,0 +1 @@\n+x\n" }
        },
      })
    },
  )
  assert.ok(captured)
  assert.deepEqual(Object.keys(captured.env).sort(), GIT_ENV_KEYS.slice().sort())
  assert.equal(captured.env.HOME, captured.cwd)
  assert.equal(captured.env.TMPDIR, captured.cwd)
  assert.equal(captured.env.PAGER, undefined)
  assert.equal(captured.env.GIT_PAGER, undefined)
  assert.equal(captured.env.GIT_EXTERNAL_DIFF, undefined)
  assert.equal(captured.env.GITHUB_TOKEN, undefined)
  assert.equal(captured.env.ACTIONS_RUNTIME_TOKEN, undefined)
  assert.equal(captured.env.HTTPS_PROXY, undefined)
  assert.equal(captured.env.GIT_DIR, undefined)
  assert.equal(captured.env.GIT_WORK_TREE, undefined)
  assert.ok(captured.args.includes("--no-index"))
  assert.ok(captured.args.includes("--no-ext-diff"))
  assert.ok(captured.args.includes("--no-textconv"))
  assert.equal(captured.args[captured.args.length - 2], "old.txt")
  assert.equal(captured.args[captured.args.length - 1], "new.txt")
})

test("does not execute hostile external diff, hook, or pager settings", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "habi-review-canary-"))
  const canary = path.join(root, "canary")
  const script = path.join(root, "evil.sh")
  const fakeHome = path.join(root, "home")
  const fakeConfig = path.join(root, "gitconfig")
  fs.mkdirSync(fakeHome)
  fs.writeFileSync(script, `#!/bin/sh\nprintf x > '${canary}'\nexit 0\n`)
  fs.chmodSync(script, 0o755)
  fs.writeFileSync(path.join(fakeHome, ".gitconfig"), `[diff]\n\texternal = ${script}\n`)
  fs.writeFileSync(fakeConfig, `[diff]\n\texternal = ${script}\n`)
  try {
    await withEnv(
      {
        GIT_EXTERNAL_DIFF: script,
        GIT_CONFIG_GLOBAL: fakeConfig,
        GIT_CONFIG_COUNT: "1",
        GIT_CONFIG_KEY_0: "diff.external",
        GIT_CONFIG_VALUE_0: script,
        HOME: fakeHome,
        PAGER: script,
        GIT_PAGER: script,
      },
      async () => {
        const api = makeApi({ baseSpec: {}, headSpec: { "a.txt": "content\n" } })
        const result = await call(api, [
          missingFile("a.txt", "added", { sha: api.headSha("a.txt") }),
        ])
        assert.equal(recovery(result, "a.txt").status, "recovered")
      },
    )
    assert.equal(fs.existsSync(canary), false)
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test("rejects invalid inputs and limits raising", async () => {
  const api = makeApi({ baseSpec: {}, headSpec: { "a.txt": "content\n" } })
  const files = [missingFile("a.txt", "added", { sha: api.headSha("a.txt") })]
  const invalid = (promise, code) =>
    assert.rejects(promise, (error) => error?.code === code)

  await invalid(call(api, files, { repo: "not a repo" }), "invalid-repo")
  await invalid(call(api, files, { repo: "../repo" }), "invalid-repo")
  await invalid(call(api, files, { repo: "owner/.." }), "invalid-repo")
  await invalid(call(api, files, { baseSha: "short" }), "invalid-identity")
  await invalid(call(api, files, { files: "nope" }), "invalid-files")
  await invalid(call(api, [null]), "invalid-files")
  await invalid(call(api, files, { fetchImpl: null }), "invalid-fetch")
  await invalid(call(api, files, { gitRunner: null }), "invalid-git-runner")
  await invalid(call(api, files, { apiUrl: "ftp://api.test" }), "invalid-api-url")
  await invalid(call(api, files, { apiUrl: "http://user:pass@api.test" }), "invalid-api-url")
  await invalid(
    call(api, files, { limits: { maxBlobBytes: PATCH_LIMITS.maxBlobBytes + 1 } }),
    "invalid-limit",
  )
  await invalid(call(api, files, { limits: { unknown: 1 } }), "invalid-limit")
  await invalid(call(api, files, { token: "" }), "missing-token")
  await invalid(call(api, files, { token: "bad\ntoken" }), "invalid-token")

  const untouched = await call(api, [patchFile("a.txt", "existing\n")], { token: undefined })
  assert.equal(untouched.files[0].patch, "existing\n")
  assert.equal(untouched.recoveries.length, 0)
})

test("resolves a divergent comparison merge base through the exact immutable SHA compare URL", async () => {
  const mergeBase = "c".repeat(40)
  const requests = []
  const fetchImpl = async (url, init) => {
    requests.push({ url, init })
    return jsonResponse({
      status: "diverged",
      base_commit: { sha: BASE.toUpperCase() },
      merge_base_commit: { sha: mergeBase.toUpperCase() },
      // The compare API does not guarantee head_commit; it must not be assumed.
      files: [{ filename: "a.txt", status: "modified" }],
    })
  }
  const result = await resolveComparisonBaseSha({
    repo: REPO,
    baseSha: BASE,
    headSha: HEAD,
    token: TOKEN,
    apiUrl: API,
    fetchImpl,
  })
  assert.equal(result, mergeBase)
  assert.equal(requests.length, 1)
  assert.equal(
    requests[0].url,
    `${API}/repos/${REPO}/compare/${BASE}...${HEAD}?per_page=1`,
  )
  assert.equal(requests[0].init.headers.Authorization, `Bearer ${TOKEN}`)
  assert.equal(requests[0].init.redirect, "error")
})

test("comparison metadata failures are typed and never fall back to the base tip", async () => {
  const mergeBase = "c".repeat(40)
  const invalid = (promise) =>
    assert.rejects(promise, (error) => error?.code === "comparison-error")
  const callCompare = (payload, overrides = {}) => {
    const requests = []
    const fetchImpl = async (url, init) => {
      requests.push({ url, init })
      return jsonResponse(payload)
    }
    const promise = resolveComparisonBaseSha({
      repo: REPO,
      baseSha: BASE,
      headSha: HEAD,
      token: TOKEN,
      apiUrl: API,
      fetchImpl,
      ...overrides,
    })
    return { promise, requests }
  }

  for (const payload of [
    { merge_base_commit: { sha: mergeBase } },
    { base_commit: null, merge_base_commit: { sha: mergeBase } },
    { base_commit: { sha: "short" }, merge_base_commit: { sha: mergeBase } },
    { base_commit: { sha: "d".repeat(40) }, merge_base_commit: { sha: mergeBase } },
    { base_commit: { sha: BASE }, merge_base_commit: null },
    { base_commit: { sha: BASE }, merge_base_commit: { sha: "short" } },
    { base_commit: { sha: BASE }, merge_base_commit: { sha: "not-a-sha" } },
    [],
    null,
  ]) {
    const { promise, requests } = callCompare(payload)
    await invalid(promise)
    assert.equal(requests.length, 1)
    assert.equal(
      requests[0].url,
      `${API}/repos/${REPO}/compare/${BASE}...${HEAD}?per_page=1`,
    )
  }

  await assert.rejects(
    resolveComparisonBaseSha({
      repo: REPO,
      baseSha: BASE,
      headSha: HEAD,
      token: TOKEN,
      apiUrl: API,
      fetchImpl: async () => jsonResponse({ message: "not found" }, 404),
    }),
    (error) => error?.code === "comparison-error",
  )

  await invalid(
    resolveComparisonBaseSha({
      repo: REPO,
      baseSha: BASE,
      headSha: HEAD,
      token: TOKEN,
      apiUrl: API,
      fetchImpl: async () => {
        throw new Error("network down")
      },
    }),
  )
  await invalid(
    resolveComparisonBaseSha({
      repo: REPO,
      baseSha: BASE,
      headSha: HEAD,
      token: TOKEN,
      apiUrl: API,
      fetchImpl: async () => jsonResponse("{"),
    }),
  )
  await invalid(
    resolveComparisonBaseSha({
      repo: REPO,
      baseSha: BASE,
      headSha: HEAD,
      token: TOKEN,
      apiUrl: API,
      limits: { maxResponseBytes: 100 },
      fetchImpl: async () =>
        jsonResponse({
          base_commit: { sha: BASE },
          merge_base_commit: { sha: mergeBase },
          files: [{ filename: "huge.txt", patch: "x".repeat(1_000) }],
        }),
    }),
  )

  await assert.rejects(
    resolveComparisonBaseSha({
      repo: "../repo",
      baseSha: BASE,
      headSha: HEAD,
      token: TOKEN,
      apiUrl: API,
      fetchImpl: async () => assert.fail("no request expected"),
    }),
    (error) => error?.code === "invalid-repo",
  )
  await assert.rejects(
    resolveComparisonBaseSha({
      repo: REPO,
      baseSha: "short",
      headSha: HEAD,
      token: TOKEN,
      apiUrl: API,
      fetchImpl: async () => assert.fail("no request expected"),
    }),
    (error) => error?.code === "invalid-identity",
  )
  await assert.rejects(
    resolveComparisonBaseSha({
      repo: REPO,
      baseSha: BASE,
      headSha: HEAD,
      token: "",
      apiUrl: API,
      fetchImpl: async () => assert.fail("no request expected"),
    }),
    (error) => error?.code === "missing-token",
  )
  await assert.rejects(
    resolveComparisonBaseSha({
      repo: REPO,
      baseSha: BASE,
      headSha: HEAD,
      token: TOKEN,
      apiUrl: "ftp://api.test",
      fetchImpl: async () => assert.fail("no request expected"),
    }),
    (error) => error?.code === "invalid-api-url",
  )
})
