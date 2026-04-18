# Homelab customization strategy

This document defines how `kcc-casa/openclaw` should track upstream `openclaw/openclaw` while still carrying homelab-specific source patches and runtime tooling.

## Goals

- Stay as close to upstream OpenClaw releases as practical.
- Treat **OpenClaw source patching as a normal expected path**, not an exception.
- Keep stable custom tooling isolated from fast-moving upstream runtime changes.
- Make branch selection, image publication, and deployment updates predictable.

## Repository model

### Remotes

- `upstream` -> `openclaw/openclaw`
- `origin` -> `kcc-casa/openclaw`

### Branches

- `main`
  - track upstream `main` as closely as practical
  - do not use as the production customization branch
  - useful for watching upstream movement and testing future changes early
- `homelab/release-<version>`
  - production-oriented customization branch for a specific upstream release tag
  - example: `homelab/release-2026.4.14`
  - branch from `v2026.4.14`, then apply homelab-specific commits there
- short-lived feature branches
  - branch from the relevant `homelab/release-<version>` branch
  - examples:
    - `homelab/bluebubbles-triage`
    - `homelab/github-auth-runtime`

## Release update process

When upstream ships a new release:

1. fetch upstream tags
2. create a new branch from the upstream release tag
3. replay the maintained homelab commits onto that branch
4. build and publish the custom image from that release branch
5. update homelab GitOps to the new image tag
6. validate runtime behavior before treating it as production-ready

### Example

```bash
git fetch upstream --tags
git checkout -b homelab/release-2026.4.15 v2026.4.15
# cherry-pick or replay homelab commits here
```

## What belongs where

### Stable custom tooling belongs in the thin image overlay

Examples:

- `qmd`
- pinned Python runtime
- `gh`
- `remote-assets-cli`
- other helper CLIs that are useful across releases

These should live in a thin additive image layer so upstream release bumps mostly mean changing the base tag and rebuilding.

### Source behavior changes belong in the release-pinned fork branch

Examples:

- BlueBubbles inbound triage logic
- runtime auth behavior changes inside OpenClaw
- extension patches
- queueing or session behavior fixes specific to homelab needs

These are expected and should be maintained as normal commits on `homelab/release-*` branches.

## Image strategy

The practical strategy is hybrid:

- use an upstream release image as the conceptual base
- keep stable homelab tooling in a thin, boring additive layer
- carry OpenClaw source patches in release-pinned fork branches

That keeps the volatile part close to upstream while avoiding repeated work for stable helper tooling.

## GitHub Actions workflow strategy

The fork workflow should build from release-pinned branches, not moving `main`.

Current workflow contract:

- workflow file: `.github/workflows/homelab-images.yml`
- trigger: `homelab/release-*`
- Vault role: `kcc-casa-openclaw-images`
- registry: `cr.home.kcc.casa`
- image repo: `cr.home.kcc.casa/openclaw/openclaw`
- tag shape: `release-<version>-<shortsha>`

Example tag:

- `cr.home.kcc.casa/openclaw/openclaw:release-2026.4.14-74ba1d977f`

## Deployment strategy

Keep deployment updates manual first.

After a successful image build:

1. choose the specific produced image tag
2. update `~/repos/homelab/gitops/base/openclaw/kustomization.yaml`
3. let Argo CD sync
4. validate runtime behavior

Avoid automatic GitOps write-back from the fork workflow until the source-patch + release-pinned process has been exercised a few times successfully.

## Rules of thumb

- Do not build production intent from moving `main`.
- Do not mix stable tooling concerns and source behavior changes mentally, even if they land in the same resulting image.
- Treat upstream releases as the unit of adoption.
- Treat `homelab/release-*` branches as the durable source of truth for deployed custom behavior.
- Keep each homelab-specific commit small and easy to replay onto the next release branch.

## First concrete use case

The first planned source-patch consumer of this strategy is BlueBubbles inbound triage in the OpenClaw source tree. That work should land on a release-pinned `homelab/release-*` branch, not on fork `main`.
