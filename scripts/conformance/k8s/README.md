# Live conformance fixture on Kubernetes (`mx-golden`)

A reproducible host for the **live two-daemon mx-agent fixture** the gated e2e /
conformance arms need (everything behind `MXL_CONFORMANCE_TWO_DAEMON=1`,
`MXL_CONFORMANCE_GOLDEN_POLICY=1`, `MXL_AUDIT_PG=1`, `MXL_PORTABILITY_MATRIX=1`,
`MXL_TASK_E2E=1`). It wraps the existing `scripts/conformance/*` bring-up in a
throwaway namespace so the homeserver + daemons + tests all run **in-cluster**,
co-located with the daemon's Unix socket.

> Validated end-to-end through **Tier 0/1** on the `stargate` RKE2 cluster:
> daemon A registers + runs and the toolbelt conformance suite passes 36/37 of its
> active tests (the 2 misses are real v0.2.1 wire divergences — see *Findings*).
> Daemon B / golden / portability reuse the same recipe and `bootstrap-daemon-b.sh`.

## Bring-up

```sh
# 1. Substrate: throwaway tuwunel homeserver + Postgres (ephemeral).
kubectl apply -f scripts/conformance/k8s/substrate.yaml
kubectl -n mx-golden rollout status deploy/tuwunel deploy/postgres

# 2. Service ClusterIPs — the runner reaches in-cluster services by IP, NOT name
#    (the runner uses an external resolver; see Gotchas).
TUW=$(kubectl -n mx-golden get svc tuwunel  -o jsonpath='{.spec.clusterIP}')
PG=$(kubectl  -n mx-golden get svc postgres -o jsonpath='{.spec.clusterIP}')

# 3. Runner pod (clones the repo + installs the toolchain on first exec).
kubectl apply -f scripts/conformance/k8s/runner.yaml
kubectl -n mx-golden wait --for=condition=Ready pod/mxl-runner --timeout=180s

# 4. In-pod setup: clone, pnpm install, install the pinned mx-agent binary.
kubectl -n mx-golden exec mxl-runner -- bash -lc '
  cd /work && git clone --depth 1 https://github.com/kortiene/mx-loom && cd mx-loom
  corepack disable; npm i -g pnpm@9.12.0; pnpm install --frozen-lockfile
  MX_AGENT_ASSET=mx-agent-0.2.1-x86_64-unknown-linux-gnu.tar.gz \
    bash scripts/conformance/install-mx-agent.sh'

# 5. Daemon A (Tier 0/1). MX_REGISTER_CMD registers the synthetic user via the
#    tuwunel single-stage registration-token UIA. MATRIX_HOMESERVER_URL is the
#    tuwunel ClusterIP from step 2.
#    (See the daemon-A snippet in this directory's history / the session notes.)
#    Then run the suite with the daemon's XDG dirs exported so BOTH transports
#    (direct IPC and the spawned `mx-agent` CLI) resolve the socket:
kubectl -n mx-golden exec mxl-runner -- bash -lc '
  export PATH=/tmp/mxl-conformance/bin:$PATH
  export XDG_RUNTIME_DIR=/tmp/mxl-conformance/a/runtime XDG_DATA_HOME=/tmp/mxl-conformance/a/data
  cd /work/mx-loom
  MXL_CONFORMANCE=1 MXL_CONFORMANCE_SOCKET=$XDG_RUNTIME_DIR/mx-agent/daemon.sock \
    pnpm --filter @mx-loom/toolbelt test:conformance'

# 6. Daemon B (Tier 2 / golden): pass A's emitted coordinates + MXL_SERVER_NAME=mxg.local
#    + POLICY_FIXTURE=policy.b.toml (plain Tier 2) or policy.golden.toml (golden),
#    then run the two-daemon / golden / task / portability arms.

# Teardown (scrubs everything):
kubectl delete ns mx-golden
```

## Gotchas (all discovered/validated standing this up)

- **No in-cluster DNS in the runner.** The pod uses an external resolver
  (`dnsConfig.nameservers`) so it can clone GitHub / npm by name, but it therefore
  cannot resolve `*.svc` names. **Reach tuwunel/postgres by ClusterIP.**
- **Nested release tarball.** The v0.2.1 `*-linux-gnu` asset ships the binary under
  `mx-agent-0.2.1-x86_64-unknown-linux-gnu/`, not at the archive root. Handled by
  `install-mx-agent.sh` (it now finds + links the binary); always set
  `MX_AGENT_ASSET=mx-agent-0.2.1-x86_64-unknown-linux-gnu.tar.gz`.
- **CLI transport needs the daemon XDG env.** The toolbelt's CLI transport spawns
  `mx-agent`, which resolves the socket via `XDG_RUNTIME_DIR`. Export the daemon's
  `XDG_RUNTIME_DIR`/`XDG_DATA_HOME` when running the suite, not just
  `MXL_CONFORMANCE_SOCKET`.
- **glibc ≥ 2.38** for the gnu binary → Debian **trixie** (not bookworm/Ubuntu-22.04);
  **privileged** for the bubblewrap exec sandbox; **tini** as PID 1 so the daemon's
  double-fork detach-parents are reaped.
- **Server name** is `mxg.local` here → pass `MXL_SERVER_NAME=mxg.local` to
  `bootstrap-daemon-b.sh` (it defaults to `golden.local`).

## Findings surfaced by the live run (real v0.2.1 divergences, not infra faults)

- `agent.list` is rejected with `invalid type: null, expected struct
  ListAgentsOptions` (rpc -32602) — the toolbelt sends `null` params where v0.2.1
  wants a `{}` struct.
- `mxWorkspaceStatus` (T108) failed on a `createRoom` Matrix call (rpc -32603).
- The **golden gate** still hits the #73 design gap: v0.2.1 `requires_approval` is
  **per-agent** (`[rooms."…".agents."<sender>"]`) but the golden scenario assumes
  **per-tool** — a maintainer decision, not a fixture fix.
