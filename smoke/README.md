# Smoke test

A manual, pre-release check that writes real log entries through deployed Cloud
Functions and queries them back. It exists to test the one contract nothing else
can reach:

```
our code  ->  stdout JSON       tests/productionOutput.ts proves this, in CI
stdout    ->  queryable entry   only observable from deployed compute
```

`labels` arriving at Google as a top-level key does not guarantee it becomes an
**entry label** you can filter on. That mapping took real trial and error, and
"structured, queryable entries" is the product promise — so it should not rest
on nothing.

**Not part of `npm test`.** Needs credentials, a deploy, and a minute of
ingestion lag.

## Setup

Needs your own Firebase project on Blaze. Project ids and bucket names are not
committed — copy `.env.example` to `.env.local` and fill it in.

```
cp smoke/.env.example smoke/.env.local     # then edit
cp smoke/.env.example smoke/functions/.env # bucket + app id only
gcloud auth application-default login
```

Blaze is required because deploying a function needs Cloud Build, Artifact
Registry and Cloud Storage enabled — not because of cost. Usage sits inside the
free tier.

## Running

```
npm run smoke:deploy    # builds against the PUBLISHED package, then deploys
npm run smoke           # invokes, waits for ingestion, asserts, cleans up
```

Both pass `--project` explicitly. Nothing here relies on `.firebaserc` or on
whatever project the Firebase CLI last considered active.

## Notes on the design

**The functions depend on the published package**, not the local build. A run
therefore exercises the artifact a consumer installs — the exports map, the
files contents, the peer dependencies. To smoke an unreleased change, publish a
prerelease first:

```
npm version prerelease && npm publish --tag beta
cd smoke/functions && npm i @dasasian/firebase-structured-logger@beta
```

**Every run generates a ULID** and tags every entry with it. Without that, a
second run would match the first run's entries and pass for the wrong reason.

**The broad query matches on the run id in the payload text, not on labels.**
If it filtered on labels and found nothing, we could not tell "labels were not
promoted" from "nothing was logged". The label filter is asserted separately, as
a *result*.

**Absence is never asserted.** You cannot prove an entry will not arrive, only
that it has not arrived yet — a slow ingestion is indistinguishable from a
correct drop. Anything about entries *not* being written stays in the unit
suites, where it is deterministic.

**Symbolication here uses the Storage path on purpose.** The release id is
unique per run, so no embedded map exists and the lookup must fall through to
`loadStorageSourceMap` — the old-release branch that runs when a user on a stale
build hits an error. The embedded path is covered by
`tests/handlerSymbolication.ts` with no cloud at all.

**The deployed callables are publicly invokable**, as Firebase callables
normally are. `maxInstances: 1` caps the blast radius, and the project is
disposable — but do not point this at a project you care about.
