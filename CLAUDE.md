# CLAUDE.md — working conventions for this repo

## What this is

Structured logging for Firebase apps — a client logger (`/client`), a Cloud Functions
logger (`/functions`), and the `fsl` CLI (`/tools`). Published as
`@dasasian/firebase-structured-logger` — an npm library, **not** an MCP server, so there is
no MCP registry step.

## Build / test

`npm run build` (tsc) · `npm run typecheck` (tsc --noEmit) · `npm test`.

`npm test` runs the `tests/*.ts` tsx suites. The `handler` and `symbolication` suites run
under `FUNCTIONS_EMULATOR=true` (already set in the `test` script) so they exercise emulator
mode without live credentials. Keep them green.

## Releasing

A library → **npm only** (no registry, no `server.json`, no tag-triggered publish workflow).
Full process + gotchas: `../PUBLISHING.md`. The short version:

1. Update `CHANGELOG.md` (`[Unreleased]` → `[X.Y.Z] — <date>`). **No `CHANGELOG.md` yet?**
   Create one ([Keep a Changelog](https://keepachangelog.com) format) and backfill the
   already-published versions from `git log` + the GitHub releases.
2. Bump `version` in `package.json`.
3. Commit `chore: release X.Y.Z` and push.
4. `npm publish` — needs your OTP. Traps: a `404 on PUT` = lapsed token (`npm login`);
   `npm view` can 404 for ~2 min after a *successful* publish (confirm with
   `npm access list packages`, don't re-publish).
5. `git tag vX.Y.Z && git push origin vX.Y.Z`; `gh release create vX.Y.Z` with the CHANGELOG notes.
6. Update the `dasasian.com/firebase-structured-logger` page in `dasasian-web`. Only
   `npm publish` and the release need your credentials; an agent drives the rest.
