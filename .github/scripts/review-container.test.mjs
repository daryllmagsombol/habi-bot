import test from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { EventEmitter } from "node:events"
import { PassThrough } from "node:stream"
import { execFile } from "node:child_process"
import { promisify } from "node:util"
import { pathToFileURL } from "node:url"
import {
  BASE_IMAGE,
  CLI_SHA256,
  ContainerFailure,
  buildContainerEnv,
  buildContainedConfig,
  buildEnvelope,
  buildHardenedCreateArgs,
  assertContainerInfo,
  OWNER_LABEL,
  runContainedCli,
  sha256File,
  streamAttached,
  validateConfig,
  verifyCliFile,
} from "./review-container.mjs"
import {
  CLI_ARGS,
  MODEL,
  buildCliEnv,
  parseEnvelope,
  validateReviewConfig,
} from "./review-container-entry.mjs"

const execFileAsync = promisify(execFile)
const MODULE_URL = new URL("./review-container.mjs", import.meta.url).href
const IMAGE_INFO = { Os: "linux", Architecture: "amd64", Config: { Volumes: null } }
const NETWORK = {
  name: "habi-review-net-test",
  bridge: "habr-test",
  dns: ["1.1.1.1"],
  subnet: "172.30.0.0/16",
  cleanup: async () => {},
}

function tempFile(contents = "fake-opencode-binary") {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "habi-container-test-"))
  const file = path.join(dir, "opencode")
  fs.writeFileSync(file, contents)
  return { dir, file }
}

function inspectInfo(networkName, record) {
  return {
    Id: record?.id ?? "a".repeat(64),
    Name: record ? `/${record.name}` : undefined,
    State: { Running: false, OOMKilled: false },
    Config: {
      User: "65534:65534",
      Volumes: null,
      ExposedPorts: null,
      Env: [],
      Labels: record ? { [OWNER_LABEL]: record.owner } : {},
    },
    HostConfig: {
      ReadonlyRootfs: true,
      Privileged: false,
      LogConfig: { Type: "none", Config: {} },
      CapDrop: ["ALL"],
      SecurityOpt: ["no-new-privileges"],
      NetworkMode: networkName,
      PidsLimit: 64,
      Memory: 1024 * 1024 * 1024,
      NanoCpus: 1_000_000_000,
      Dns: ["1.1.1.1"],
      Ulimits: [{ Name: "core", Soft: 0, Hard: 0 }],
      Tmpfs: { "/tmp": "rw,nosuid,nodev,size=268435456" },
      Sysctls: {
        "net.ipv6.conf.all.disable_ipv6": "1",
        "net.ipv6.conf.default.disable_ipv6": "1",
      },
      Binds: null,
      VolumesFrom: null,
      PortBindings: {},
      IpcMode: "private",
      PidMode: "",
      UTSMode: "",
    },
    Mounts: [{ Type: "tmpfs", Destination: "/tmp" }],
    NetworkSettings: {
      Networks: {
        [networkName]: { GlobalIPv6Address: "" },
      },
    },
  }
}

function selftestPayload(input, { hostCode = "ETIMEDOUT" } = {}) {
  const probes = JSON.parse(input)
  return {
    ok: true,
    checks: {
      "scratch-write": true,
      "rootfs-read-only": true,
      "host-repository-absent": true,
      "process-identity": true,
      "ipv6-disabled": true,
      "runtime-assets": true,
    },
    probes: {
      tcp: (probes.tcp ?? []).map((probe) => ({ name: probe.name, ok: false, code: hostCode })),
      dns: (probes.dns ?? []).map((host) => ({ name: host, ok: true, address: "203.0.113.10" })),
      https: (probes.https ?? []).map((probe) => ({ name: probe.name, ok: true, status: 200 })),
      ipv6: (probes.ipv6 ?? []).map((probe) => ({ name: probe.name, ok: false, code: "ENETUNREACH" })),
    },
    failures: [],
  }
}

function makeHarness({
  hostCode,
  imageInfo = IMAGE_INFO,
  hangReview = false,
  rmFailures = 0,
  rmAlwaysFail = false,
  failRmFor = null,
  networkCleanupOk = true,
  incrementDrop = true,
  createAmbiguous = false,
  ambiguousLabelMatches = true,
  counterReadFails = false,
  imageCleanupFails = false,
} = {}) {
  const commands = []
  const created = []
  const inputs = []
  const spawns = []
  const removedContainers = new Set()
  const removedImages = new Set()
  const rmAttempts = new Map()
  const state = { dropPackets: 0, sequence: 0, ambiguousUsed: false }
  const cleanup = { network: 0 }

  const network = {
    ...NETWORK,
    cleanup: async () => {
      cleanup.network += 1
      if (!networkCleanupOk) return { ok: false, errors: ["network busy"] }
      const remaining = created.some((entry) => !removedContainers.has(entry.id))
      if (remaining) return { ok: false, errors: ["active endpoints"] }
      return { ok: true, errors: [] }
    },
  }

  const networkModule = {
    createIsolatedNetwork: async () => network,
    assertNetworkIsolation: ({ id }) => {
      const chain = `HBRV-DU-${id}`
      return {
        policy: {
          dockerUserChain: chain,
          dockerUserRules: [
            ["-A", chain, "-d", "10.0.0.0/8", "-m", "conntrack", "--ctstate", "NEW", "-j", "DROP"],
            ["-A", chain, "-d", "192.168.0.0/16", "-m", "conntrack", "--ctstate", "NEW", "-j", "DROP"],
            ["-A", chain, "-j", "DROP"],
          ],
        },
      }
    },
  }

  function absent(message) {
    const error = new Error(message)
    error.stderr = message
    return error
  }

  async function run(command, args, options = {}) {
    commands.push({ command, args, options })
    const first = args[0]
    if (first === "pull") return { stdout: "", stderr: "" }
    if (first === "build") return { stdout: "", stderr: "" }
    if (command === "sudo") {
      if (counterReadFails) throw new Error("iptables unavailable")
      return {
        stdout: `${state.dropPackets} 0 DROP 0 -- * * 0.0.0.0/0 10.0.0.0/8 ctstate NEW\n`,
        stderr: "",
      }
    }
    if (first === "image" && args[1] === "inspect") {
      const tag = args[2]
      if (removedImages.has(tag)) throw absent(`Error: No such image: ${tag}`)
      return { stdout: JSON.stringify([imageInfo]), stderr: "" }
    }
    if (first === "image" && args[1] === "rm") {
      if (imageCleanupFails) throw new Error("image rm failed")
      removedImages.add(args[3])
      return { stdout: "", stderr: "" }
    }
    if (first === "network" && args[1] === "inspect") {
      return {
        stdout: JSON.stringify([
          { Name: network.name, EnableIPv6: false, IPAM: { Config: [{ Subnet: network.subnet, Gateway: "172.30.0.1" }] } },
        ]),
        stderr: "",
      }
    }
    if (first === "create") {
      state.sequence += 1
      const name = args[args.indexOf("--name") + 1]
      const label = args[args.indexOf("--label") + 1]
      const owner = label.slice(label.indexOf("=") + 1)
      const id = `${state.sequence}`.repeat(64).slice(0, 64)
      const record = { id, name, args, owner }
      created.push(record)
      if (createAmbiguous && /^habi-review-[0-9a-f]{8}$/.test(name) && !state.ambiguousUsed) {
        state.ambiguousUsed = true
        if (!ambiguousLabelMatches) record.owner = "unrelated-owner"
        throw new Error("client connection lost after create")
      }
      return { stdout: `${id}\n`, stderr: "" }
    }
    if (first === "inspect") {
      if (args[1] === "--format") {
        const id = args[3]
        if (removedContainers.has(id)) throw absent(`Error: No such object: ${id}`)
        if (String(args[2]).includes("OOMKilled")) return { stdout: "false", stderr: "" }
        return { stdout: id, stderr: "" }
      }
      const target = args[1]
      const record = created.find((entry) => entry.name === target || entry.id === target)
      if (!record || removedContainers.has(record.id)) throw absent(`Error: No such object: ${target}`)
      return { stdout: JSON.stringify([inspectInfo(network.name, record)]), stderr: "" }
    }
    if (first === "rm" && args[1] === "-f") {
      const id = args[2]
      const record = created.find((entry) => entry.id === id)
      const attempts = (rmAttempts.get(id) ?? 0) + 1
      rmAttempts.set(id, attempts)
      const shouldFail =
        rmAlwaysFail ||
        (failRmFor && failRmFor(record, attempts)) ||
        attempts <= rmFailures
      if (shouldFail) throw new Error("rm failed")
      removedContainers.add(id)
      return { stdout: "", stderr: "" }
    }
    if (first === "kill") return { stdout: "", stderr: "" }
    throw new Error(`unexpected command: ${command} ${args.join(" ")}`)
  }

  function spawn(command, args, options) {
    spawns.push({ command, args, options })
    const id = args[args.length - 1]
    const record = created.find((entry) => entry.id === id)
    const child = new EventEmitter()
    child.stdout = new PassThrough()
    child.stderr = new PassThrough()
    child.stdin = new PassThrough()
    child.killed = false
    child.kill = () => {
      child.killed = true
    }
    const chunks = []
    child.stdin.on("data", (chunk) => chunks.push(chunk))
    child.stdin.on("end", () => {
      const input = Buffer.concat(chunks).toString("utf8")
      inputs.push({ id, name: record?.name ?? "", input })
      if (hangReview && /^habi-review-[0-9a-f]{8}$/.test(record?.name ?? "")) return
      queueMicrotask(() => {
        let stdout = ""
        if (record?.name.includes("selftest")) {
          if (incrementDrop) state.dropPackets += 1
          stdout = JSON.stringify(selftestPayload(input, { hostCode }))
        } else {
          stdout = `${JSON.stringify({ type: "step_finish", part: { reason: "stop" } })}\n`
        }
        child.stdout.end(stdout)
        child.stderr.end("")
        child.emit("close", 0, null)
      })
    })
    return child
  }

  return {
    run,
    spawn,
    commands,
    created,
    inputs,
    spawns,
    cleanup,
    network,
    networkModule,
    state,
    removedContainers,
    removedImages,
  }
}

function baseOptions(cliPath, harness, overrides = {}) {
  return {
    cliPath,
    prompt: "# Trusted review\nOnly review the provided diff.",
    config: buildContainedConfig(),
    timeoutMs: 5_000,
    maxBuffer: 2 * 1024 * 1024,
    run: harness.run,
    spawn: harness.spawn,
    networkModule: harness.networkModule,
    imageInspector: async () => IMAGE_INFO,
    verifyCli: async () => {},
    ...overrides,
  }
}

test("buildContainedConfig passes the container config policy", () => {
  const config = buildContainedConfig()
  assert.equal(validateReviewConfig(config).model, MODEL)
  assert.deepEqual(config.permission, { "*": "deny", read: "allow", bash: "allow" })
  assert.deepEqual(config.agent.review.permission, { "*": "deny", read: "allow", bash: "allow" })
  assert.deepEqual(config.agent.review.options, { reasoningEffort: "low" })
  assert.equal(config.share, "disabled")
})

test("entry accepts only the exact approved low reasoning effort option", () => {
  const config = buildContainedConfig()
  assert.deepEqual(validateReviewConfig(config).agent.review.options, { reasoningEffort: "low" })

  const withOptions = (options) => {
    const next = buildContainedConfig()
    next.agent.review.options = options
    return next
  }
  for (const options of [
    { reasoningEffort: "high" },
    { reasoningEffort: "max" },
    { reasoningEffort: "none" },
    {},
    { reasoningEffort: "low", temperature: 0 },
    { reasoningEffort: "low", topP: 1 },
    { reasoningEffort: "low", headers: {} },
    { reasoningEffort: "low", baseURL: "https://example.invalid" },
  ]) {
    assert.throws(() => validateReviewConfig(withOptions(options)), /config-agent-options/)
  }
  for (const options of [
    { reasoningEffort: "low", apiKey: "sk-test" },
    { reasoningEffort: "low", token: "secret" },
  ]) {
    assert.throws(() => validateReviewConfig(withOptions(options)), /config-(agent-options|secret)/)
  }

  const missing = buildContainedConfig()
  delete missing.agent.review.options
  assert.throws(() => validateReviewConfig(missing), /config-agent-options/)
})

test("entry rejects provider secrets, wrong models, and expanded permissions", () => {
  const withKey = { ...buildContainedConfig(), apiKey: "sk-test" }
  assert.throws(() => validateReviewConfig(withKey), /config-secret/)
  assert.throws(() => validateReviewConfig({ ...buildContainedConfig(), model: "openai/gpt-5" }), /config-model/)
  assert.throws(
    () =>
      validateReviewConfig({
        ...buildContainedConfig(),
        permission: { "*": "deny", read: "allow", bash: "allow", edit: "allow" },
      }),
    /config-permission/,
  )
  assert.throws(
    () => validateReviewConfig({ ...buildContainedConfig(), share: "enabled" }),
    /config-share/,
  )
})

test("entry builds the fixed CLI invocation and strips forbidden environment", () => {
  assert.deepEqual(CLI_ARGS, [
    "run",
    "--dir",
    "/tmp/work",
    "--agent",
    "review",
    "--model",
    MODEL,
    "--title",
    "PR review",
    "--format",
    "json",
  ])
  const config = buildContainedConfig()
  const env = buildCliEnv(
    {
      PATH: "/bin",
      OPENCODE_PURE: "1",
      GITHUB_TOKEN: "ghs_secret",
      ACTIONS_RUNTIME_TOKEN: "runtime-secret",
      OPENCODE_API_KEY: "sk-secret",
      HTTPS_PROXY: "http://proxy.invalid",
    },
    config,
  )
  assert.equal(env.PATH, "/bin")
  assert.equal(env.OPENCODE_PURE, "1")
  assert.equal(env.OPENCODE_CONFIG_CONTENT, JSON.stringify(config))
  assert.equal(env.OPENCODE_PERMISSION, JSON.stringify(config.permission))
  for (const forbidden of ["GITHUB_TOKEN", "ACTIONS_RUNTIME_TOKEN", "OPENCODE_API_KEY", "HTTPS_PROXY"]) {
    assert.equal(env[forbidden], undefined)
  }
})

test("entry envelope accepts a bounded config and prompt only", () => {
  const config = buildContainedConfig()
  const envelope = parseEnvelope(buildEnvelope(config, "prompt"))
  assert.equal(envelope.prompt, "prompt")
  assert.deepEqual(envelope.config, config)
  assert.throws(() => parseEnvelope(JSON.stringify({ version: 1, config, prompt: "x".repeat(120_001) })), /input-too-large/)
  assert.throws(() => parseEnvelope("{}"), /invalid-envelope/)
})

test("hardened create arguments cannot bind host resources", () => {
  const args = buildHardenedCreateArgs({
    name: "habi-review-abc",
    network: "habi-review-net",
    image: "image",
    env: buildContainerEnv(),
    owner: "owner-token",
  })
  const joined = args.join(" ")
  assert.match(joined, /--read-only/)
  assert.match(joined, /--cap-drop ALL/)
  assert.match(joined, /--security-opt no-new-privileges/)
  assert.match(joined, /--user 65534:65534/)
  assert.match(joined, /--dns 1.1.1.1/)
  assert.match(joined, /--log-driver none/)
  assert.match(joined, /--label habi\.review\.owner=owner-token/)
  assert.doesNotMatch(joined, /(^| )-p( |$)|--publish/)
  assert.doesNotMatch(joined, /(^| )-v( |$)|--volume|--mount|--volumes-from/)
  assert.doesNotMatch(joined, /--privileged|--network[= ]host|--pid[= ]host|--ipc[= ]host/)
  assert.doesNotMatch(joined, /docker\.sock|\/var\/run\/docker/)
  for (const key of ["GITHUB_TOKEN", "ACTIONS_RUNTIME_TOKEN", "OPENCODE_API_KEY", "HTTPS_PROXY"]) {
    assert.doesNotMatch(joined, new RegExp(key))
  }
})

test("container inspection rejects unconfined seccomp and host mounts", () => {
  const network = "habi-review-net-test"
  const good = inspectInfo(network)
  assert.doesNotThrow(() => assertContainerInfo(good, network))

  const unconfined = inspectInfo(network)
  unconfined.HostConfig.SecurityOpt = ["no-new-privileges", "seccomp=unconfined"]
  assert.throws(() => assertContainerInfo(unconfined, network), /container-invalid/)

  const mounted = inspectInfo(network)
  mounted.Mounts = [{ Type: "bind", Destination: "/workspace" }]
  assert.throws(() => assertContainerInfo(mounted, network), /container-invalid/)

  const logging = inspectInfo(network)
  logging.HostConfig.LogConfig = { Type: "json-file", Config: {} }
  assert.throws(() => assertContainerInfo(logging, network), /container-invalid/)

  const publicDifferentNetwork = inspectInfo(network)
  publicDifferentNetwork.HostConfig.NetworkMode = "host"
  assert.throws(() => assertContainerInfo(publicDifferentNetwork, network), /container-invalid/)
})

test("CLI digest verification rejects a mismatched binary", async () => {
  const { dir, file } = tempFile("not-the-official-binary")
  try {
    assert.equal(CLI_SHA256.length, 64)
    assert.match(await sha256File(file), /^[0-9a-f]{64}$/)
    await assert.rejects(() => verifyCliFile(file), /cli-integrity/)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test("streamAttached enforces timeout, overflow, and cancellation", async () => {
  const liveChild = () => {
    const child = new EventEmitter()
    child.stdout = new PassThrough()
    child.stderr = new PassThrough()
    child.stdin = new PassThrough()
    child.kill = () => {}
    return child
  }
  const killed = []
  const run = async (command, args) => {
    killed.push(args.join(" "))
  }

  const timeout = await streamAttached({
    run,
    spawn: () => liveChild(),
    containerId: "a".repeat(64),
    env: {},
    input: "x",
    timeoutMs: 15,
    maxBuffer: 1024,
  })
  assert.equal(timeout.error.code, "ETIMEDOUT")
  assert.ok(killed.some((value) => value.startsWith("kill ")))

  const overflowing = liveChild()
  const overflowPromise = streamAttached({
    run,
    spawn: () => overflowing,
    containerId: "b".repeat(64),
    env: {},
    input: "x",
    timeoutMs: 1_000,
    maxBuffer: 4,
  })
  overflowing.stdout.write("too-many-bytes")
  const overflow = await overflowPromise
  assert.equal(overflow.status, null)
  assert.equal(overflow.error.code, "ENOBUFS")

  const controller = new AbortController()
  const cancelPromise = streamAttached({
    run,
    spawn: () => liveChild(),
    containerId: "c".repeat(64),
    env: {},
    input: "x",
    timeoutMs: 1_000,
    maxBuffer: 1024,
    signal: controller.signal,
  })
  controller.abort()
  const cancelled = await cancelPromise
  assert.equal(cancelled.error.code, "ECANCELED")
})

test("runContainedCli builds, self-tests, streams one exact envelope, and cleans owned resources", async () => {
  const { dir, file } = tempFile()
  const harness = makeHarness()
  try {
    const result = await runContainedCli(baseOptions(file, harness))
    assert.equal(result.status, 0)
    assert.equal(harness.created.length, 2)

    const [selftest, review] = harness.created
    assert.ok(selftest.name.includes("selftest"))
    assert.equal(selftest.args[selftest.args.length - 1], "--self-test")
    assert.equal(review.name.startsWith("habi-review-"), true)
    assert.equal(review.args[review.args.length - 1], "habi-review-runtime:" + review.name.split("-").pop())

    // The PR prompt is not present in create/build arguments or container env.
    for (const { args } of harness.created) {
      assert.doesNotMatch(args.join(" "), /Only review the provided diff/)
      assert.doesNotMatch(args.join(" "), /OPENCODE_CONFIG_CONTENT|OPENCODE_API_KEY|GITHUB_TOKEN|ACTIONS_RUNTIME_TOKEN/)
    }

    const reviewInput = harness.inputs.find((entry) => entry.name === review.name)
    const envelope = JSON.parse(reviewInput.input)
    assert.equal(envelope.version, 1)
    assert.equal(envelope.prompt, "# Trusted review\nOnly review the provided diff.")
    assert.deepEqual(envelope.config, buildContainedConfig())

    for (const { args } of harness.created) {
      assert.equal(args[args.indexOf("--log-driver") + 1], "none")
    }
    const selftestInput = harness.inputs.find((entry) => entry.name === selftest.name)
    const selftestProbes = JSON.parse(selftestInput.input)
    assert.ok(
      selftestProbes.tcp.some(
        (probe) => probe.name === "private-443" && probe.host === "10.255.255.254" && probe.port === 443,
      ),
    )
    const counters = harness.commands.filter((entry) => entry.command === "sudo")
    assert.equal(counters.length, 2)
    const networkId = selftest.name.split("-").pop()
    for (const counter of counters) {
      assert.deepEqual(counter.args.slice(-2), ["-L", `HBRV-DU-${networkId}`])
    }

    // Self-test must run before the inference container exists.
    const selftestSpawn = harness.spawns.findIndex((entry) => entry.args.at(-1) === selftest.id)
    const reviewSpawn = harness.spawns.findIndex((entry) => entry.args.at(-1) === review.id)
    assert.ok(selftestSpawn >= 0 && reviewSpawn > selftestSpawn)

    const dockerCall = harness.commands.find((entry) => entry.args[0] === "create")
    assert.ok(dockerCall.options.env)
    assert.ok(dockerCall.options.env.DOCKER_CONFIG.endsWith("docker"))
    for (const key of Object.keys(dockerCall.options.env)) {
      assert.doesNotMatch(key, /^(GITHUB|ACTIONS)_|^OPENCODE_API_KEY$|_PROXY$/)
    }

    assert.equal(harness.cleanup.network, 1)
    const removals = harness.commands.filter((entry) => entry.args[0] === "rm" && entry.args[1] === "-f")
    const known = new Set(harness.created.map((entry) => entry.id))
    for (const removal of removals) assert.ok(known.has(removal.args[2]))
    assert.ok(removals.some((entry) => entry.args[2] === review.id))
    assert.ok(
      harness.commands.some(
        (entry) => entry.args[0] === "image" && entry.args[1] === "rm" && String(entry.args[3]).startsWith("habi-review-runtime:"),
      ),
    )
    assert.equal(harness.commands.some((entry) => entry.args.includes("prune")), false)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test("self-test container receives the same hardened environment as the review container", async () => {
  const { dir, file } = tempFile()
  const harness = makeHarness()
  try {
    const result = await runContainedCli(baseOptions(file, harness))
    assert.equal(result.status, 0)
    const [selftest, review] = harness.created

    const envArgs = (record) => {
      const values = []
      record.args.forEach((arg, index) => {
        if (arg === "--env") values.push(record.args[index + 1])
      })
      return values
    }
    const expected = Object.entries(buildContainerEnv()).map(([key, value]) => `${key}=${value}`)
    assert.deepEqual(envArgs(selftest), expected)
    assert.deepEqual(envArgs(review), expected)
    assert.deepEqual(envArgs(selftest), envArgs(review))

    // The self-test must not inherit the host Docker client environment.
    for (const entry of envArgs(selftest)) {
      const key = entry.slice(0, entry.indexOf("="))
      assert.doesNotMatch(
        key,
        /^(GITHUB|ACTIONS)_|^ACTIONS_RUNTIME_TOKEN$|^OPENCODE_API_KEY$|^(HTTPS?|ALL|NO|FTP|SOCKS)_PROXY$/i,
      )
      assert.notEqual(key, "DOCKER_CONFIG")
      assert.doesNotMatch(entry, /DOCKER_CONFIG|habi-review-container-|OPENCODE_API_KEY|GITHUB_TOKEN|ACTIONS_RUNTIME_TOKEN|HTTPS_PROXY/)
      assert.notEqual(entry, `HOME=${os.homedir()}`)
    }

    // Both attached streams still use the trusted host Docker client environment.
    for (const record of [selftest, review]) {
      const attached = harness.spawns.find((entry) => entry.args.at(-1) === record.id)
      assert.ok(attached.options.env)
      assert.ok(attached.options.env.DOCKER_CONFIG.endsWith("docker"))
      assert.equal(attached.options.env.TMPDIR, attached.options.env.HOME)
      assert.match(attached.options.env.HOME, /habi-review-container-.*[/\\]home$/)
    }

    // The actual review container keeps the hardened runtime settings.
    assert.equal(review.args[review.args.indexOf("--user") + 1], "65534:65534")
    assert.ok(review.args.includes("--read-only"))
    assert.equal(review.args[review.args.indexOf("--security-opt") + 1], "no-new-privileges")
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test("runContainedCli requires the owned private-destination drop counter to increase", async () => {
  const { dir, file } = tempFile()
  try {
    await assert.rejects(
      () => runContainedCli(baseOptions(file, makeHarness({ incrementDrop: false }))),
      (error) => error instanceof ContainerFailure && error.code === "forward-proof-failed",
    )
    await assert.rejects(
      () => runContainedCli(baseOptions(file, makeHarness({ counterReadFails: true }))),
      (error) => error instanceof ContainerFailure && error.code === "forward-proof-failed",
    )
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test("runContainedCli retries owned container removal and confirms absence", async () => {
  const { dir, file } = tempFile()
  const harness = makeHarness({ rmFailures: 1 })
  try {
    const result = await runContainedCli(baseOptions(file, harness))
    assert.equal(result.status, 0)
    const review = harness.created.find((entry) => /^habi-review-[0-9a-f]{8}$/.test(entry.name))
    const attempts = harness.commands.filter(
      (entry) => entry.args[0] === "rm" && entry.args[1] === "-f" && entry.args[2] === review.id,
    )
    assert.ok(attempts.length >= 2)
    assert.equal(harness.removedContainers.has(review.id), true)
    assert.equal(harness.cleanup.network, 1)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test("runContainedCli hard-fails and keeps network policy when container removal is unresolved", async () => {
  const { dir, file } = tempFile()
  const harness = makeHarness({
    failRmFor: (record) => Boolean(record && /^habi-review-[0-9a-f]{8}$/.test(record.name)),
  })
  try {
    await assert.rejects(
      () => runContainedCli(baseOptions(file, harness)),
      (error) => error instanceof ContainerFailure && error.code === "cleanup-failed",
    )
    const review = harness.created.find((entry) => /^habi-review-[0-9a-f]{8}$/.test(entry.name))
    assert.equal(harness.removedContainers.has(review.id), false)
    assert.equal(harness.cleanup.network, 1)
    assert.equal(
      harness.commands.some((entry) => entry.command === "sudo" && entry.args.some((arg) => /^-F$/.test(arg))),
      false,
    )
    assert.equal(harness.commands.some((entry) => entry.args.includes("prune")), false)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test("runContainedCli hard-fails when image cleanup is unresolved", async () => {
  const { dir, file } = tempFile()
  const harness = makeHarness({ imageCleanupFails: true })
  try {
    await assert.rejects(
      () => runContainedCli(baseOptions(file, harness)),
      (error) => error instanceof ContainerFailure && error.code === "cleanup-failed",
    )
    assert.equal(harness.cleanup.network, 1)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test("runContainedCli hard-fails when network cleanup reports failure", async () => {
  const { dir, file } = tempFile()
  const harness = makeHarness({ networkCleanupOk: false })
  try {
    await assert.rejects(
      () => runContainedCli(baseOptions(file, harness)),
      (error) => error instanceof ContainerFailure && error.code === "cleanup-failed",
    )
    assert.equal(harness.cleanup.network, 1)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test("failed self-test container removal stops before creating the inference container", async () => {
  const { dir, file } = tempFile()
  const harness = makeHarness({
    failRmFor: (record) => Boolean(record?.name.includes("selftest")),
  })
  try {
    await assert.rejects(
      () => runContainedCli(baseOptions(file, harness)),
      (error) => error instanceof ContainerFailure && error.code === "cleanup-failed",
    )
    assert.equal(harness.created.length, 1)
    assert.equal(harness.created[0].name.includes("selftest"), true)
    assert.equal(harness.spawns.length, 1)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test("ambiguous docker create adopts only a container matching the owned name and label", async () => {
  const { dir, file } = tempFile()
  const harness = makeHarness({ createAmbiguous: true })
  try {
    await assert.rejects(
      () => runContainedCli(baseOptions(file, harness)),
      (error) => error instanceof ContainerFailure && error.code === "container-create-ambiguous",
    )
    const review = harness.created.find((entry) => /^habi-review-[0-9a-f]{8}$/.test(entry.name))
    assert.ok(review)
    assert.equal(harness.removedContainers.has(review.id), true)
    assert.equal(harness.cleanup.network, 1)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test("ambiguous docker create never adopts an unrelated same-name container", async () => {
  const { dir, file } = tempFile()
  const harness = makeHarness({ createAmbiguous: true, ambiguousLabelMatches: false })
  try {
    await assert.rejects(() => runContainedCli(baseOptions(file, harness)))
    const review = harness.created.find((entry) => /^habi-review-[0-9a-f]{8}$/.test(entry.name))
    assert.ok(review)
    assert.equal(
      harness.commands.some(
        (entry) => entry.args[0] === "rm" && entry.args[1] === "-f" && entry.args[2] === review.id,
      ),
      false,
    )
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test("build context contains only the trusted CLI, entry, and pinned Dockerfile", async () => {
  const { dir, file } = tempFile("#!/bin/sh\n")
  const harness = makeHarness()
  let listing = null
  let dockerfile = ""
  const run = async (command, args, options) => {
    if (args[0] === "build") {
      const buildDir = args[args.length - 1]
      listing = fs.readdirSync(buildDir).sort()
      dockerfile = fs.readFileSync(path.join(buildDir, "Dockerfile"), "utf8")
    }
    return harness.run(command, args, options)
  }
  try {
    await runContainedCli(baseOptions(file, harness, { run }))
    assert.deepEqual(listing, ["Dockerfile", "opencode", "review-container-entry.mjs"])
    assert.match(dockerfile, /FROM node:24\.20\.0-bookworm-slim@sha256:[0-9a-f]{64}/)
    assert.match(dockerfile, /ENTRYPOINT \["node", "\/opt\/habi\/review-container-entry\.mjs"\]/)
    assert.doesNotMatch(dockerfile, /apt-get|npm install|curl|wget|COPY \./)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test("runContainedCli timeout removes the owned review container and network", async () => {
  const { dir, file } = tempFile()
  const harness = makeHarness({ hangReview: true })
  try {
    const result = await runContainedCli(baseOptions(file, harness, { timeoutMs: 150 }))
    assert.equal(result.error.code, "ETIMEDOUT")
    const review = harness.created.find((entry) => /^habi-review-[0-9a-f]{8}$/.test(entry.name))
    assert.ok(review)
    assert.ok(
      harness.commands.some(
        (entry) => entry.args[0] === "rm" && entry.args[1] === "-f" && entry.args[2] === review.id,
      ),
    )
    assert.equal(harness.cleanup.network, 1)
    assert.equal(harness.commands.some((entry) => entry.args.includes("prune")), false)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test("runContainedCli fails closed when the isolation module is missing or refuses", async () => {
  const { dir, file } = tempFile()
  try {
    await assert.rejects(
      () =>
        runContainedCli({
          ...baseOptions(file, makeHarness()),
          networkModule: {},
        }),
      (error) => error instanceof ContainerFailure && error.code === "isolation-failed",
    )
    await assert.rejects(
      () =>
        runContainedCli({
          ...baseOptions(file, makeHarness()),
          networkModule: {
            createIsolatedNetwork: async () => {
              throw new Error("network policy rejected")
            },
          },
        }),
      (error) => error instanceof ContainerFailure && error.code === "isolation-failed",
    )
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test("runContainedCli cleans a network resource that fails policy validation", async () => {
  const { dir, file } = tempFile()
  let cleaned = 0
  const invalid = {
    ...NETWORK,
    dns: ["9.9.9.9"],
    cleanup: async () => {
      cleaned += 1
      return { ok: true, errors: [] }
    },
  }
  try {
    await assert.rejects(
      () =>
        runContainedCli(
          baseOptions(file, makeHarness(), {
            networkModule: { createIsolatedNetwork: async () => invalid },
          }),
        ),
      (error) => error instanceof ContainerFailure && error.code === "isolation-failed",
    )
    assert.equal(cleaned, 1)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test("runContainedCli rejects config secrets before touching Docker", async () => {
  const { dir, file } = tempFile()
  const harness = makeHarness()
  try {
    await assert.rejects(
      () =>
        runContainedCli(
          baseOptions(file, harness, {
            config: { ...buildContainedConfig(), apiKey: "sk-secret" },
          }),
        ),
      (error) => error instanceof ContainerFailure && error.code === "config-secret",
    )
    assert.equal(harness.commands.length, 0)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test("runContainedCli rejects base images with declared volumes", async () => {
  const { dir, file } = tempFile()
  const harness = makeHarness({ imageInfo: { Os: "linux", Architecture: "amd64", Config: { Volumes: { "/data": {} } } } })
  try {
    await assert.rejects(
      () =>
        runContainedCli(
          baseOptions(file, harness, {
            imageInspector: async () => ({
              Os: "linux",
              Architecture: "amd64",
              Config: { Volumes: { "/data": {} } },
            }),
          }),
        ),
      (error) => error instanceof ContainerFailure && error.code === "image-invalid",
    )
    assert.equal(harness.commands.some((entry) => entry.args[0] === "build"), false)
    assert.equal(harness.created.length, 0)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test("runContainedCli treats a reachable host probe as an isolation failure before inference", async () => {
  const { dir, file } = tempFile()
  const harness = makeHarness({ hostCode: "ECONNREFUSED" })
  try {
    await assert.rejects(
      () => runContainedCli(baseOptions(file, harness)),
      (error) => error instanceof ContainerFailure && error.code === "isolation-failed",
    )
    assert.equal(harness.created.length, 1)
    assert.equal(harness.created[0].name.includes("selftest"), true)
    assert.equal(harness.created.some((entry) => /^habi-review-[0-9a-f]{8}$/.test(entry.name)), false)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test("runContainedCli returns cancellation before creating any Docker resource", async () => {
  const { dir, file } = tempFile()
  const harness = makeHarness()
  const controller = new AbortController()
  controller.abort()
  try {
    const result = await runContainedCli(baseOptions(file, harness, { signal: controller.signal }))
    assert.equal(result.error.code, "ECANCELED")
    assert.equal(harness.commands.length, 0)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

const SIGNAL_FIXTURE = String.raw`
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { EventEmitter } from "node:events"
import { PassThrough } from "node:stream"

const { runContainedCli, buildContainedConfig, OWNER_LABEL } = await import(process.env.MODULE_URL)
const signal = process.env.TEST_SIGNAL
const networkName = "habi-review-net-test"
const state = { drop: 0, sequence: 0, created: [], removed: new Set(), removedImages: new Set(), networkCleanup: 0 }
const cliDir = fs.mkdtempSync(path.join(os.tmpdir(), "habi-signal-cli-"))
const cliPath = path.join(cliDir, "opencode")
fs.writeFileSync(cliPath, "fixture")

function absent(message) {
  const error = new Error(message)
  error.stderr = message
  return error
}

function info(record) {
  return {
    Id: record.id,
    Name: "/" + record.name,
    State: { Running: false, OOMKilled: false },
    Config: {
      User: "65534:65534",
      Volumes: null,
      ExposedPorts: null,
      Env: [],
      Labels: { [OWNER_LABEL]: record.owner },
    },
    HostConfig: {
      ReadonlyRootfs: true,
      Privileged: false,
      LogConfig: { Type: "none", Config: {} },
      CapDrop: ["ALL"],
      SecurityOpt: ["no-new-privileges"],
      NetworkMode: networkName,
      PidsLimit: 64,
      Memory: 1073741824,
      NanoCpus: 1000000000,
      Dns: ["1.1.1.1"],
      Ulimits: [{ Name: "core", Soft: 0, Hard: 0 }],
      Tmpfs: { "/tmp": "rw,nosuid,nodev,size=268435456" },
      Sysctls: {
        "net.ipv6.conf.all.disable_ipv6": "1",
        "net.ipv6.conf.default.disable_ipv6": "1",
      },
      Binds: null,
      VolumesFrom: null,
      PortBindings: {},
      IpcMode: "private",
      PidMode: "",
      UTSMode: "",
    },
    Mounts: [],
    NetworkSettings: { Networks: { [networkName]: { GlobalIPv6Address: "" } } },
  }
}

async function run(command, args) {
  if (command === "sudo") {
    return { stdout: state.drop + " 0 DROP 0 -- * * 0.0.0.0/0 10.0.0.0/8 ctstate NEW\n", stderr: "" }
  }
  const first = args[0]
  if (first === "pull" || first === "build" || first === "kill") return { stdout: "", stderr: "" }
  if (first === "network" && args[1] === "inspect") {
    return {
      stdout: JSON.stringify([
        { Name: networkName, EnableIPv6: false, IPAM: { Config: [{ Subnet: "172.30.0.0/16", Gateway: "172.30.0.1" }] } },
      ]),
      stderr: "",
    }
  }
  if (first === "create") {
    state.sequence += 1
    const name = args[args.indexOf("--name") + 1]
    const label = args[args.indexOf("--label") + 1]
    const record = { id: String(state.sequence).repeat(64), name, owner: label.slice(label.indexOf("=") + 1) }
    state.created.push(record)
    return { stdout: record.id + "\n", stderr: "" }
  }
  if (first === "inspect") {
    if (args[1] === "--format") {
      const id = args[3]
      if (state.removed.has(id)) throw absent("Error: No such object: " + id)
      if (String(args[2]).includes("OOMKilled")) return { stdout: "false", stderr: "" }
      return { stdout: id, stderr: "" }
    }
    const record = state.created.find((entry) => entry.name === args[1] || entry.id === args[1])
    if (!record || state.removed.has(record.id)) throw absent("Error: No such object: " + args[1])
    return { stdout: JSON.stringify([info(record)]), stderr: "" }
  }
  if (first === "rm" && args[1] === "-f") {
    state.removed.add(args[2])
    return { stdout: "", stderr: "" }
  }
  if (first === "image" && args[1] === "inspect") {
    if (state.removedImages.has(args[2])) throw absent("Error: No such image: " + args[2])
    return { stdout: JSON.stringify([{ Os: "linux", Architecture: "amd64", Config: { Volumes: null } }]), stderr: "" }
  }
  if (first === "image" && args[1] === "rm") {
    state.removedImages.add(args[3])
    return { stdout: "", stderr: "" }
  }
  throw new Error("unexpected command: " + command + " " + args.join(" "))
}

function spawn(command, args) {
  const id = args[args.length - 1]
  const record = state.created.find((entry) => entry.id === id)
  const child = new EventEmitter()
  child.stdout = new PassThrough()
  child.stderr = new PassThrough()
  child.stdin = new PassThrough()
  child.kill = () => {}
  const chunks = []
  child.stdin.on("data", (chunk) => chunks.push(chunk))
  child.stdin.on("end", () => {
    const input = Buffer.concat(chunks).toString("utf8")
    if (record?.name.includes("selftest")) {
      const probes = JSON.parse(input)
      state.drop += 1
      const payload = {
        ok: true,
        checks: {},
        probes: {
          tcp: probes.tcp.map((probe) => ({ name: probe.name, ok: false, code: "ETIMEDOUT" })),
          dns: probes.dns.map((host) => ({ name: host, ok: true, address: "203.0.113.10" })),
          https: probes.https.map((probe) => ({ name: probe.name, ok: true, status: 200 })),
          ipv6: probes.ipv6.map((probe) => ({ name: probe.name, ok: false, code: "ENETUNREACH" })),
        },
        failures: [],
      }
      queueMicrotask(() => {
        child.stdout.end(JSON.stringify(payload))
        child.stderr.end("")
        child.emit("close", 0, null)
      })
      return
    }
    setTimeout(() => process.kill(process.pid, signal), 25)
  })
  return child
}

const network = {
  name: networkName,
  bridge: "hbrvtest",
  dns: "1.1.1.1",
  subnet: "172.30.0.0/16",
  cleanup: async () => {
    state.networkCleanup += 1
    return { ok: true, errors: [] }
  },
}

const keepAlive = setTimeout(() => {}, 10_000)
const result = await runContainedCli({
  cliPath,
  prompt: "fixture prompt",
  config: buildContainedConfig(),
  timeoutMs: 5000,
  maxBuffer: 2 * 1024 * 1024,
  run,
  spawn,
  networkModule: {
    createIsolatedNetwork: async () => network,
    assertNetworkIsolation: () => ({
      policy: {
        dockerUserChain: "HBRV-DU-test",
        dockerUserRules: [[
          "-A", "HBRV-DU-test", "-d", "10.0.0.0/8",
          "-m", "conntrack", "--ctstate", "NEW", "-j", "DROP",
        ]],
      },
    }),
  },
  imageInspector: async () => ({ Os: "linux", Architecture: "amd64", Config: { Volumes: null } }),
  verifyCli: async () => {},
})

clearTimeout(keepAlive)
const review = state.created.find((entry) => /^habi-review-[0-9a-f]{8}$/.test(entry.name))
fs.rmSync(cliDir, { recursive: true, force: true })
process.stdout.write(
  JSON.stringify({
    code: result.error?.code ?? null,
    networkCleanup: state.networkCleanup,
    reviewRemoved: Boolean(review && state.removed.has(review.id)),
    created: state.created.length,
  }) + "\n",
)
`

test("SIGINT and SIGTERM abort, clean up, and preserve 130/143 exit codes", async () => {
  const scriptDir = fs.mkdtempSync(path.join(os.tmpdir(), "habi-signal-fixture-"))
  const script = path.join(scriptDir, "signal-fixture.mjs")
  fs.writeFileSync(script, SIGNAL_FIXTURE)
  try {
    for (const [signal, expected] of [
      ["SIGINT", 130],
      ["SIGTERM", 143],
    ]) {
      let stdout = ""
      let exitCode = 0
      try {
        const result = await execFileAsync(process.execPath, [script], {
          env: { ...process.env, MODULE_URL, TEST_SIGNAL: signal },
          timeout: 15_000,
        })
        stdout = result.stdout
      } catch (error) {
        stdout = error.stdout ?? ""
        exitCode = Number(error.code ?? error.exitCode)
      }
      assert.equal(exitCode, expected)
      const payload = JSON.parse(stdout.trim().split(/\r?\n/).at(-1))
      assert.equal(payload.code, "ECANCELED")
      assert.equal(payload.networkCleanup, 1)
      assert.equal(payload.reviewRemoved, true)
      assert.equal(payload.created, 2)
    }
  } finally {
    fs.rmSync(scriptDir, { recursive: true, force: true })
  }
})
