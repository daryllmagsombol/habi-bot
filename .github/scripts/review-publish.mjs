import fs from "node:fs"
import {
  ReviewFailure,
  fail,
  findBotComment,
  isMain,
  isPr,
  isRepo,
  isSha,
  renderComment,
  safeCode,
  validateIdentity,
  validateOutcome,
} from "./review-lib.mjs"

const MAX_COMMENT_PAGES = 5

function readJson(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"))
  } catch {
    fail("invalid-json")
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
  const body = renderComment(outcome)

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

function option(name) {
  const index = process.argv.indexOf(name)
  return index >= 0 ? process.argv[index + 1] : undefined
}

export async function main(env = process.env) {
  try {
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
