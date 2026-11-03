# H-007 — Bounded VM measurement and capacity decision

- **Status:** Owner-authorized bounded measurement, executed 2026-11-03. Records a **single short observation window**, not a sustained benchmark. H-007 was accepted on this basis at planning fidelity; the residual limits are listed in §7 and are not waived.
- **Phase:** P0 — Feasibility (H-007).
- **Scope:** Read-only host and container observation on the shared VM, plus a limits/runtime decision for the planned Habi API, worker, and web containers. No deployment, image build, container change, or synthetic load was performed.
- **Authority:** Owner instruction on 2026-11-03: accept the three open P0 decisions and authorize the bounded H-007 measurement window. The owner explicitly accepted the GreenCloud CPU-accounting ambiguity as a residual risk for this window.

## 1. What was run

| Step | Command shape | Duration | Effect |
|---|---|---|---|
| Connectivity and baseline | `ssh … 'date; uptime; nproc; free -m; df -h /'` | one-shot | read-only |
| Host sampling | `/proc/loadavg`, `/proc/meminfo` loop | 18 samples × 10 s (170 s) | read-only |
| CPU utilisation | two `/proc/stat` reads | 30 s interval | read-only |
| Container snapshot | `docker stats --no-stream` | one-shot | read-only |
| Container CPU sampling | `docker stats --no-stream` loop | 12 samples × 4 s (48 s) | read-only |
| Container limits | `docker inspect HostConfig.Memory/NanoCpus` | one-shot | read-only |

No `docker run`, `docker build`, `docker pull`, file write, service restart, or configuration change occurred on the VM. SSH used the owner-provided key with `BatchMode=yes`.

## 2. Host baseline (2026-11-03T07:08Z)

| Metric | Value |
|---|---|
| vCPU | 4 |
| RAM total | 7,888 MiB (7.704 GiB) |
| RAM used / available | 4,099 MiB / 3,789 MiB |
| Swap | 5,119 MiB, unused |
| Root filesystem | 58 GB, 28 GB used, 30 GB free (48%) |
| Load average (1/5/15 min) | 0.26 / 0.16 / 0.11 |
| Host CPU utilisation over 30 s | **0.6 %** |

## 3. Observation window (170 s)

| Metric | Range observed |
|---|---|
| Load average (1 min) | 0.04 – 0.22 |
| Memory available | 3,818 – 3,834 MiB |
| Memory used | 4,054 – 4,070 MiB |

The window is idle-to-light. It captures the existing applications at their natural background level, not their peak.

## 4. Container inventory and consumption

| Container | Memory | Share of host | CPU (peak sample) | Limits set |
|---|---:|---:|---:|---|
| `sonarqube` | 2.367 GiB | 30.7 % | 1.62 % | none |
| `azure-vm-blink-web-1` | 419 MiB | 5.3 % | ~0 % | none |
| `azure-vm-transformlit-worker-1` | 238 MiB | 3.0 % | ~0 % | none |
| `azure-vm-transformlit-api-1` | 227 MiB | 2.9 % | ~0 % | none |
| `azure-vm-postgres-1` | 129 MiB | 1.6 % | 3.96 % | none |
| `azure-vm-blink-api-1` | 117 MiB | 1.5 % | ~0 % | none |
| `azure-vm-transformlit-web-1` | 63 MiB | 0.8 % | ~0 % | none |
| `azure-vm-nginx-1` | 15 MiB | 0.2 % | ~0 % | none |
| `azure-vm-transformlit-static-1` | 5 MiB | 0.1 % | ~0 % | none |

**Every running container reports `HostConfig.Memory = 0` and `HostConfig.NanoCpus = 0`.** The host therefore has no per-container memory or CPU ceiling today; a single runaway neighbour can consume the remaining headroom. That is a host-level risk Habi cannot fix from its own compose file, and it is the main caveat on the fit decision.

## 5. Fit decision

Measured headroom after existing workloads: **≈ 3.8 GiB RAM free and ≈ 3.9 of 4 vCPU idle**.

Proposed per-container ceilings for Habi, applied in Habi's own compose configuration:

| Service | Memory limit | CPU limit | Basis |
|---|---:|---:|---|
| `web` (Next.js) | 512 MiB | 0.5 | off-host single-sample RSS 114 MiB, plus build/runtime headroom |
| `api` (NestJS) | 512 MiB | 0.5 | off-host RSS 102 MiB, plus request headroom |
| `worker` (inert now) | 384 MiB | 0.5 | off-host RSS 91 MiB; no queue or provider work yet |
| **Total** | **1.4 GiB** | **1.5 vCPU** | leaves ≈ 2.4 GiB and ≈ 2.5 vCPU for existing apps |

**Decision: one API + one worker + the web shell fit alongside the current workloads with these ceilings and the measured headroom.** The conclusion rests on the observed 3.8 GiB free and the off-host process sizes; it is not a measured result of the Habi stack under VM load (see §7).

Concurrency for P1 remains capped at one worker and one API process per the H-001 boundary; no browser worker or parallel agent run is authorized.

## 6. Runtime decision

**Node.js 24.20.0 remains the P1 launch runtime.** Bun 1.4.2 is not adopted.

- Node is the documented runtime for Next.js 16.4.2 and NestJS 12.2.0; Bun is documented by Next only as a deployment adapter and by Nest only as a package manager.
- The off-host smoke showed both runtimes starting the prebuilt API, worker, and web shell with equivalent readiness/HTTP/shutdown predicates, but that is a single macOS sample, not Linux capacity or support evidence.
- Existing scripts invoke `node` directly and the Nest CLI spawns `node` by default; keeping Node avoids an untested execution path.

Bun may be re-evaluated only after dependency and production tests pass on Linux.

## 7. Limits of this measurement (not waived)

1. **One window, no sustained load.** 170 s of passive sampling and a 30 s CPU sample. No peak-hour capture, no concurrency, no soak test.
2. **The Habi stack was not measured on the VM.** No images exist (H-009 Docker contexts remain open), so the RSS figures come from the off-host smoke and are used only as sizing input.
3. **Existing containers have no limits.** Headroom can disappear without warning; Habi's ceilings protect the host from Habi, not from neighbours.
4. **GreenCloud CPU accounting is unresolved.** The provider's averaging window and denominator are unknown; the owner accepted this risk for this window rather than resolving it.
5. **No backup/restore rehearsal.** That remains H-012.
6. **The observation itself is not load.** No abort threshold was needed because nothing was loaded; any future active test must define one before it starts.

## 8. Evidence

- SSH target: owner-provided key, `root@172.93.185.14`, 2026-11-03T07:08Z.
- Raw outputs are summarized above; account identifiers, hostnames beyond the shared VM role, and any unrelated process data are omitted.
- Companion evidence: [off-host Node/Bun smoke](./2026-10-28-h007-next-evidence-plan.md), [read-only baseline](./2026-10-23-shared-vm-readonly-baseline.md), [GreenCloud CPU policy research](./2026-10-23-greencloud-budget-kvm-cpu-policy.md).
