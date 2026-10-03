# GitHub Actions in this repo

This repo's CI publishes the OSS source — npm packages, sandbox container
image. **It does NOT deploy any worker to a Cloudflare account.**

| Workflow | Purpose |
|---|---|
| `ci.yml` | `verify` runs the full suite including a production frontend build. `release-check` is a separate short job: changesets, changelog coverage, and unreleased pull requests. `image-build` builds the self-host main-node image (no publish) |
| `agent-review.yml` | independent PR patch review; high/critical findings or reviewer failure block the check |
| `release.yml` | changeset-driven npm publish for the SDK / CLI packages. `publish` runs `scripts/release-check.mjs --publish` before `pnpm release` |
| `build-sandbox-image.yml` | builds the agent sandbox base image for OSS users to pull |
| `build-server-image.yml` | verifies and publishes the Node/Console server image to GHCR under an immutable full-Git-SHA tag; release tags add a human version alias |

## PR quality gate setup

Set the repository secret `ANTHROPIC_API_KEY`, then require both `CI / verify`, `CI / image-build` and `Agent code review / review` in branch protection on `main`. The review check **fails closed** when the secret is absent, the provider is unavailable, or a textual patch is truncated/too large; split oversized PRs. The workflow runs trusted base-revision code via `pull_request_target` and reads PR patches as data only; it never checks out or executes PR code with a secret. PR diff content is sent to Anthropic, so do not submit secrets or other sensitive content in a diff. The agent cannot guarantee correctness; human review remains required.

These checks do not yet certify a two-process Managed Session with shared memory and outputs. Add the real cross-replica durability test before claiming that deployment profile is supported; see `AGENTS.md`. Branch protection is a repository setting and cannot be enabled by committing this workflow alone.

## Why no deploy workflows?

Earlier versions of this repo had `deploy.yml`, `deploy-staging.yml`,
`deploy-lane.yml`, etc. Those were removed because:

1. **Repo / deploy concern separation.** A deploy workflow in OSS
   couples this codebase to one operator's CF account. Anyone forking
   for self-host had to either re-wire the workflows or accept a red
   CI badge — neither is good.

2. **Hosted overlay needs to win.** The OSS `apps/*/wrangler.jsonc`
   files are templates; production deployments overlay extra bindings
   (e.g. a billing-meter service binding, real D1 IDs, custom domains).
   Letting OSS auto-deploy on `push: main` clobbered those overlays.

## Self-host deploy

You're on your own — fork the repo, fill in `apps/*/wrangler.jsonc`
with your CF resource IDs, run `wrangler deploy` from each app dir.
The hosted operator's deploy infra (separate private repo) is
documented in their own README and is not maintained here.

## OMA hosted

Deploys run from the operator's private `openma-hosted` repo via its
own GitHub Actions workflows. The `.oma-version` file there pins which
SHA of this repo gets shipped to prod.
