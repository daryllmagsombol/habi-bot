# H-007 next evidence plan

- **Status:** Local planning only; H-007 remains open and unaccepted. This note authorizes no server load or deployment.
- **Date:** 2026-10-28. The earlier local VM baseline and CPU policy research remain unpublished; their observations are summarized here, not represented as a capacity pass.

## Existing evidence and gaps

Read-only host samples and owner-confirmed typical-load history were captured on 2026-10-23. One disposable capped Node process served health requests for roughly two seconds. This is not a Nest, worker, real agent, peak-load, or concurrency test. The worker in the current repository is inert.

[H-007](https://github.com/daryllmagsombol/habi-bot/issues/7) still needs representative busy/peak headroom, web/API/worker/database measurements, an evidence-backed Node/Bun choice, numeric limits, log/artifact bounds, backup/restore evidence, and a go/no-go. No production container limit or concurrency number is approved here.

## Provider policy boundary

[GreenCloud's terms](https://greencloudvps.com/terms-of-service.php) state a 30% average CPU guideline and 100% bursts for 10 minutes per 24 hours. The percentage denominator, averaging window, provider measurement, and burst accounting remain unclear. The owner treats the policy as enforced; a successful benchmark cannot clarify its meaning or prove provider approval. A support question was drafted previously but not sent.

## Next steps

1. **Off-host planning:** define comparable Node and Bun workloads, pinned versions, reproducible commands, and the metrics needed to choose a runtime. No runtime is selected merely because it starts.
2. **Preserve evidence:** before temporary artifacts expire, decide a safe local evidence location and record relevant versions and host conditions without credentials or application data.
3. **Clarify policy and window:** obtain the provider's denominator and averaging/burst rules or explicitly record the remaining risk; identify a low-impact test window and reserve for existing services. Provider clarification is not itself a benchmark authorization.
4. **Pre-register a bounded test:** one capped disposable process, a hard wall-clock watchdog, monitoring and rollback, and no actual inference or existing-service modification. Test ceilings must be stated as provisional risk controls, not provider-approved limits or production capacity.
5. **Abort immediately** on loss of monitoring, excessive CPU relative to the agreed ceiling, memory pressure or swap, unexpected service restart/unhealthy state, low disk, or provider warning. Define numeric thresholds against fresh preflight observations before executing; no safe values are inferred from the stale baseline.
6. **Separate decisions:** real agent-run capacity, multi-run enablement, browser workers, backup/restore, and any deployment each need their own evidence and applicable authorization. A stub-provider test measures orchestration only.

No SSH, server writes, load generation, provider inference, or vendor contact occurred for this plan. The previously authorized two-second smoke does not authorize a sustained benchmark.

## Off-host runtime smoke — 2026-10-28

Existing prebuilt web and backend artifacts were tested sequentially on a macOS arm64 workstation, not the target VM. Node `v24.20.0` and Bun `1.4.2` each ran the same prebuilt entries; no dependency installation, rebuild, provider call, or load generation was part of the comparison. Each row is a **single sample**, not a benchmark or evidence of production support.

| Component | Node ready / parent RSS | Bun ready / parent RSS | Outcome |
|---|---|---|---|
| Nest health API | 256.5 ms / 102 MB | 154.3 ms / 67 MB | One loopback health request returned 200 under each; both exited 0 on SIGTERM |
| Inert worker | 153.9 ms / 91 MB | 103.0 ms / 52 MB | No listener observed; both exited 0 on SIGTERM |
| Next production shell | 207.6 ms / 114 MB | 103.5 ms / 98 MB | One loopback request returned 200 and met the shell HTML predicate under each; both exited 143 on SIGTERM |

The RSS numbers are one parent-process snapshot after readiness, not peaks or total process-tree memory. A preliminary harness attempt used an unintended default port; its readiness/port check caught the mistake and the corrected run used isolated loopback ports. A preliminary `lsof` filter was also corrected before the final worker observations. These were harness issues, not established runtime failures.

**Interpretation:** both runtimes handled these particular prebuilt shell components in this off-host smoke. This does not measure Linux/KVM, sustained load, concurrency, a real worker/agent, production support, or provider policy compliance; it cannot decide the H-007 runtime or capacity gate. Existing project scripts use Node and remain the fallback. Raw sanitized per-case results and commands are retained in the approved temporary workspace under `habi-h007-offhost-runtime/evidence/comparison.md`.
