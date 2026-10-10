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
npm run smoke:deploy       # packs the WORKING TREE, deploys the functions
npm run smoke:deploy:run   # packs the WORKING TREE, deploys the Cloud Run service
npm run smoke              # invokes, waits for ingestion, asserts, cleans up
npm run smoke:install      # no cloud: installs the tarball with no optional peers
```

All of them pass `--project` explicitly. Nothing here relies on `.firebaserc` or on
whatever project the Firebase CLI or gcloud last considered active.

## The Cloud Run leg

`smoke/cloudrun/` is a plain `http` server on Cloud Run with **no `firebase-functions`
and no `firebase-admin`** — the backend `createHttpLogHandler` is for (#39). It proves
the fallback paths end to end: JSON lines instead of `write()`, Storage through
`@google-cloud/storage` with a named bucket, and a trace id whose project comes from
the metadata server, because Cloud Run puts none in the environment.

The trace check asserts what the console does: `trace="projects/<p>/traces/<id>"` must
find both our entry and Cloud Run's own request log. That is how the bare-id idea was
ruled out — Cloud Logging stores the bare id as written, so it never meets the
request log.

The service is private (`--no-allow-unauthenticated`); the run calls it with
`gcloud auth print-identity-token`. The first deploy creates an Artifact Registry
repository and runs Cloud Build, both inside the free tier at this size. A deploy
can fail once with "Resource readiness deadline exceeded" and no container logs —
that is on Google's side; deploying again worked.

## The big-entry and repeat-summary legs

**A 300 KB entry** goes through the callable. Cloud Functions and Cloud Run cut a log
line at 102,400 bytes, and past that the entry arrives as broken text with no severity
or labels — measured with a throwaway experiment, 99 KB whole and 100 KB broken, on both.
The leg asserts the entry arrives as JSON, marked `truncated`, with its stack resolved
and the whole original in the bucket as `fsl-overflow.json`.

**A repeat summary stamped two hours back**, and a plain WARNING carrying the same stamp.
The summary must be filed at its own time and the plain entry at the server's. This is
the leg that found both of these, after the unit suites had passed:

- An RFC 3339 string under `timestamp` is ignored. Cloud Logging's agent reads a
  `{ seconds, nanos }` object, a `timestampSeconds`/`timestampNanos` pair, or a `time`
  string — nothing else.
- An entry whose body is only `message` is filed as `textPayload`, so a
  `jsonPayload.message` filter never finds it. Give every entry a second field.

## The real-client leg

Every other leg posts a payload the harness built by hand. This one runs the real
`/client` logger from the working tree, in jsdom, with a `logFunction` that calls the
deployed `fslSmokeClient`. So what the client decides (which copy is a repeat, what a
summary carries, which breadcrumbs go with an entry) is checked where it ends up: in
Cloud Logging.

One user reaches the same error on one screen by two paths, four times each:

| Path | First action | How it is recorded |
|---|---|---|
| A | `apply_discount` | `bc.action()` in code |
| B | `edit_quantity` | a click on a `data-fsl-action` button, with `enableActions()` |

Both paths end with `tap_place_order`. Every attempt starts by arriving on the screen
(`navigatedTo('Checkout')`), as a user does: the signature holds the last 3 `action`
breadcrumbs since the last `nav` one, so without the arrival the actions of attempt 1
and attempts 2 to 4 differ (measured: 4 full copies, 2 keys, no summary for one path).
Then the tab goes hidden, which is what sends repeat summaries in a browser. The leg
asserts 6 full copies under 2 `repeatKey`s, 3 each; 2 summaries with `repeatCount` "1",
each `repeatOf` one of those keys; and, on every full copy, the actions since its last
`nav` breadcrumb are its own path's (the trail itself also holds the earlier path's
crumbs, so path B's copies are read from their last arrival on).

`smoke/realClient.ts` is that user, run by `run.ts` as a child process. jsdom's
globals stay out of the process the other legs run in: a `window` there changes how
the Google libraries and `fetch` behave. The child gets the callable's URL, the run id
and the release through its environment and exits non-zero if a send failed; `run.ts`
scrubs the URL from anything the child printed. The leg runs after the older ones, so the
entries it adds under the run id do not change what they wait for; the thrown-error leg
runs after it, and finds its entries by their own messages.

## The thrown-error leg

`withLogging` logs what a handler throws and throws it again. A unit test drives it with
a request the test made, so it cannot show the part that only a deployed callable has:
Firebase's own wrapper, which answers the caller and writes its own `Unhandled error`
entry. This leg calls `fslSmokeThrows`, a callable whose handler throws what the caller
asks for, three times. Each call's message holds the run id.

| Call | The handler | The caller gets | Entries that hold the message |
|---|---|---|---|
| `plain` | throws `new Error(message)` | 500, `INTERNAL` | 2: fsl's `ERROR` with `functionName` and `smokeRunId`, and Firebase's `Unhandled error` with neither |
| `refusal` | throws `new HttpsError('permission-denied', message)` | 403, `PERMISSION_DENIED` | 1: fsl's `WARNING` with `context.code` and `context.status`, and no error payload |
| `logged` | catches, calls `logError(err)`, throws the same error | 500, `INTERNAL` | 2, not 3: fsl's `ERROR` from `logError`, and Firebase's |

The caller's answer is asserted too, because `withLogging` promises to throw the same
value again: a changed error would change the status or the code. The entries are found
by a text search for the message, not by a label: Firebase's entry has no fsl label, and
a label filter would hide the very entry the leg is there to count. The leg waits a short
time (10 seconds) after the expected count arrives, reads once more, and asserts on that
last read, so a late third entry is seen. The leg runs last, so its entries (they hold the
run id too) do not change what the older legs wait for.

## What the deployed fixture covers

`functions/sourcemaps/current/` ships an embedded map for release
`smoke-embedded`, alongside a `.release` marker. Every run uses a unique
release id, so a stack naming that bundle is a genuine mismatch — which
exercises the release-aware resolution added for #20: the marker is read, the
mismatch detected, Storage consulted, and the embedded map used as a fallback.

That also strengthens the Storage assertion. Before the fixture existed the
embedded lookup missed trivially because nothing was deployed; now there ARE
embedded maps, so resolving a run's own release proves the lookup genuinely fell
through to Storage rather than reusing whatever shipped.

## Notes on the design

**Both deploys pack the working tree**, so a run tests the code about to ship,
before it reaches npm. What a consumer installs from npm (the exports map, the
files in the tarball, the peer dependencies) is `npm run smoke:install`'s job:
it packs the tarball and installs it in an empty directory with no cloud. The
functions keep no lockfile, because a local tarball's hash changes at every pack.

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
