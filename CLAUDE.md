# CLAUDE.md — working conventions for this repo

## What this is

Structured logging for Firebase apps — a client logger (`/client`), a Cloud Functions
logger (`/functions`), and the `fsl` CLI (`/tools`). Published as
`@dasasian/firebase-structured-logger` — an npm library, **not** an MCP server, so there is
no MCP registry step.

## Build / test

`npm run build` (tsc) · `npm run typecheck` · `npm test`.

**TypeScript 6, not 7, on purpose.** Both were tried against this repo: the emitted `.js`
is byte-identical across 5.9, 6.0 and 7.0, and 7 changes only quote style in one `.d.ts`.
6 is chosen because 7.0 has no programmatic compiler API until 7.1, and tools this
package may want (typedoc, typescript-eslint) need it. Both builds use `module`/
`moduleResolution: node16` — TS 7 removed `Node` (node10) — so moving to 7 later is a
version bump. Dependabot ignores TypeScript majors for that reason.

`typecheck` runs **two** configs. `tsconfig.json` is the build — CommonJS, `rootDir ./src`,
and it covers `src/` only. `tsconfig.check.json` covers `tests/` and `smoke/` as well, with
ESM settings and `noEmit`, because `smoke/run.ts` uses `import.meta` and CommonJS rejects it
(TS1470). Neither file was type-checked at all until #38, which is how
`entry.metadata.errorGroups` — a field the Logging client does not surface — reached a live
smoke run and reported, wrongly, that Cloud Error Reporting had grouped nothing.

`.gitignore` ignores `*.json` (Firebase credentials) and lists the exceptions. A new JSON
config needs its own `!` line, or `git add -A` skips it silently and it only exists on
your machine — `tsconfig.check.json` did exactly that, and CI failed with TS5058.

That only works while the harness stays typed. `smoke/run.ts` has no `any` in it on purpose:
`any` is what let that bug through, so re-introducing one silently disarms the check for the
file that most needs it.

`tsc` does not remove output for sources you deleted, so `dist/` keeps stale files and
`npm pack` will happily ship them — `packDeploy.js` was still in the 0.4.0 tarball after
its source was removed. `prepublishOnly` runs `clean && build` for that reason. Check
`npm pack --dry-run` after deleting any source file.

`.nvmrc` pins **22** for local work — `nvm use` picks it up in this directory. Keep the
installed 22 current (`nvm install 22`): jsdom 30, a test dependency, needs 22.22.2 or
later. Node 20 fails in ways that look like code problems: `firebase-functions` pulls in
`jwks-rsa` → `jose` 6, which is ESM-only, so `firebase deploy` dies during codebase
analysis with `ERR_REQUIRE_ESM` and a plain `require()` of the built `/functions` entry
point does the same.

**Node 22 is the supported floor, and CI runs 22 and 24.** `engines` says `>=22`;
`firebase-admin` 14 and `@google-cloud/storage` 8 both require it; 24 is the current LTS.
Node 20 was dropped at 1.0 — it reached end of life on 2026-04-30 and gets no security
fixes. If you change the matrix, update the required status checks on `main` too
(`build (22)`, `build (24)` today), or PRs wait forever on a check that never runs.

`npm test` runs the `tests/*.ts` tsx suites. Keep them green.

Most functions-side suites — `errorPayload`, `requestLogger`, `handler`, `symbolication` —
run under `FUNCTIONS_EMULATOR=true` (already set in the `test` script) so they exercise
emulator mode without live credentials, writing to a throwaway `dev.jsonl`.

**`productionOutput` and `handlerSymbolication` deliberately run with that flag UNSET.** `writeLog` has two branches
that emit structurally different entries — emulator nests `jsonPayload`, production spreads
it to top level — and for a long time only the emulator branch was tested. It captures
**stdout and stderr** (firebase-functions routes ERROR to `console.error`, so a stdout-only
capture misses every error entry) and asserts the exact bytes Cloud Logging ingests. Change
the emitted shape and this is the suite that should stop you.

`handlerSymbolication` drives `createClientLogHandler` end to end — minified stack in,
source location out. It needs no cloud: `getSourceMap` checks the embedded map before
falling through to Storage, so maps written to `sourcemaps/current/` satisfy the whole
path. `FUNCTIONS_EMULATOR` is an environment **variable**, not a process — nothing has to
be started. It uses `app-HANDLER1.js` and friends because `symbolication` writes to the
same directory under the same cwd, and a shared fixture name would let one suite's map
silently satisfy the other's lookup.

`storageChain` also runs with the flag unset. `firebase-admin` is an optional peer, so
Storage resolves down a chain (firebase-admin → a named bucket via `@google-cloud/storage`
→ none); the suite stages "not installed" with a `Module._load` hook, because the package
is always present in this repo. `STORAGE_EMULATOR_HOST` points at a closed local port in
it and in `productionOutput`, so no attachment upload can reach real Storage with this
machine's credentials.

`entrySize` runs with the flag unset too — the 90 KiB shrink-and-warn path lives entirely
in `writeLog`'s production branch; the local file has no line-length ceiling, so there is
nothing there to test. It reuses `storageChain`'s
`Module._load` hook for the "no Storage at all" case, and `productionOutput`'s closed-port
`STORAGE_EMULATOR_HOST` so the overflow upload fails fast instead of reaching real Storage.
One case needs the failure itself — it asserts the failed upload names the overflow
object — and that warning arrives from the upload's own `.catch`, asynchronously, after
`writeLog` has already returned; the test has to keep its `console.warn` stub in place
across a flush, not just the synchronous call, or the warning fires after the stub is
gone and the assertion sees nothing.

**`npm run smoke:install`** is the check nothing in `npm test` can do: it builds, packs,
installs the tarball into an empty temp directory with no optional peers, and sends one
ERROR through `createHttpLogHandler` from CommonJS and ESM. It needs the npm registry and
nothing else. Run it before a release — it is how the `firebase-admin` import in
`sourceMapCache.ts` was found, after a require hook that blocked only `firebase-functions`
had passed.

Three support modules, not suites themselves:

- `tests/testHelpers.ts` — `assert`, `reportResults`, `readLastEntry(dir)`, `clearLog(dir)`,
  `makeRequest(payload)`. Every suite uses these; don't re-roll them per file.
- `tests/browserStubs.ts` — in-memory `sessionStorage`, a fake `window` with
  `dispatchWindowEvent`/`listenerCount`, a stub `navigator`, and `withFrozenTime`.
  **Import it before the module under test** — `rateLimiter` reads `window` and
  `client/logger` reads `navigator` at module load, so a later stub is too late.
- `tests/logsHelpers.ts` — `runFsl(argv, { cwd, cloud, gcloudOutput, env })` runs `fsl logs`
  against a fake transport and returns stdout, stderr, the exit code and every request the
  transport saw; `cloudEntry()` builds a `gcloud logging read --format json` element.
  The fake project id and bucket are sentinels the suites assert never appear in output.

`labelKeys` drives the client and functions loggers through every scenario that emits a
label and fails on a key `BaseLabels` does not declare. `BaseLabels` is what `fsl logs`
validates `--where labels.<key>` against and what the shipped `.d.ts` tells an agent fsl
writes, so a new label gets a field and a one-line comment there in the same change.
`logsLocal` runs with `FUNCTIONS_EMULATOR=true` because the emulator's default severity floor
is DEBUG and it writes an INFO entry; it reads files the logger really wrote.

`localLogFile` is the suite for the rule in "The backend writes the local log file in
development only". The logger reads `FUNCTIONS_EMULATOR`, `K_SERVICE` and `NODE_ENV` when its
module loads, so each case starts `localLogFileApp` as a child process with the environment
under test and compares the file and the printed bytes. It strips those three variables from
the parent's environment first, so it passes under any `NODE_ENV`.

`errorPayload` is the parity suite: the client and functions loggers must build an identical
`ErrorPayload`. They share `src/shared/error.ts` now, but they drifted once before.

## Module-scoped state — the rule

Two bugs came from the same mistake, so it is worth stating plainly:

> **A config value stored in module scope must not be accepted as a per-call or
> per-instance parameter.**

`new Logger({ rateLimitOptions })` and `createClientLogHandler({ bucketName })`
both *looked* scoped to the thing being constructed. Neither was — a second call
silently changed the first caller's behaviour, with no error. The parameter
position was the lie, not the global state.

Two honest resolutions when you hit this: make it global in the API too (a
separate `configureX()` the caller invokes once), or make it genuinely
per-instance.

What is legitimately module-scoped here, and why:

| State | Why global is correct |
|---|---|
| breadcrumbs, current screen, active activity | one user, one session, one path |
| the client `Logger` singleton | see below |
| source-map and TraceMap caches | pure caches, keyed by content |
| `AsyncLocalStorage` in `requestLogger` | per-request by design, not global |
| the set of errors a backend logger has written | a `WeakSet` keyed by the error object itself: no config, no size, gone with the error |

**Repeat summaries live in `localStorage`, and that is shared across tabs.** The budget
and duplicate counts are per tab (`sessionStorage`), but a pending summary has to survive
the tab closing, so it goes where every tab of the origin can see it. Each summary has its
own id, is keyed by signature + `releaseId` + `userId`, and is removed by the tab that
sends it; a rare double-send is visible by that id. Anything added there needs the same
treatment: an id, an owner, a size cap and an expiry.

**fsl sends repeat summaries itself, and the logger has no method for it.** Sending is two
steps: counts become queued summaries when the tab goes hidden or their hour is up, and
the queue is then sent, also once after `initLogger` for a previous visit's. One step
offered as a public method reads as the whole job and sends nothing by itself.
`tests/publicApi.ts` pins the client logger's public members, so a method that becomes
public by accident fails the typecheck. A test sends summaries the way a browser does:
`setVisibility('hidden')`.

**The client logger is a session singleton.** `Logger` is exported as a *type
only* — annotate with `Logger<AppLabels>`, construct via `initLogger()`. A
second instance would silently share breadcrumbs, screen, activity and the
rate-limit budget while looking independent. The functions side is the opposite
and correctly so: requests are concurrent, so each gets its own writer via
`AsyncLocalStorage`.

`tests/publicApi.ts` pins the exported names of each entry point.
`tests/configureTwice.ts` asserts the second-call semantics of every
`configureX`/`init`. **A new configure/init function needs a case in that
file** — its absence is what let both bugs ship.

## Shared SDKs — one copy in the user's tree

`@google-cloud/storage` is a real dependency, and users almost always have a second
route to it: `firebase-admin` brings it as an optional dependency (13.x → `^7`, 14.5+ →
`^8`). If our range and theirs do not overlap, npm installs two copies. So the range is
`^7.19.0 || ^8.1.0`, wide on purpose, the way `firebase-functions` accepts four majors
of `firebase-admin`: npm reuses whichever copy is already there. Widening a range is
not a breaking change. `npm run smoke:install` installs each major and pushes an
attachment through it, so both keep working rather than merely loading. Keep the
range covering every major a supported `firebase-admin` uses.

## Optional peers — never at module load

`firebase`, `firebase-functions` and `firebase-admin` are optional peers, and the package
has to load without any of them: the browser half posts anywhere, and
`createHttpLogHandler` runs on Cloud Run or any Node server that may not be Firebase at
all. A top-level import of a peer breaks that for everyone who has not installed it, and
nothing in `npm test` notices on its own, because this repo always has them installed.
That shipped twice in one release cycle (#39): first `firebase-functions`, then
`firebase-admin/storage`, which a check for the first did not cover.

So a peer is loaded lazily, in a **named loader at the top of the file** with a comment
saying why — `loadFirebaseWrite`, `loadFirebaseHttps`, `loadFirebaseAdminStorage` — and
its types come from an `import type` line, which erases. `require` inside the loader, not
`await import`: the call sites are synchronous, and this CommonJS build compiles a
dynamic import to `require` anyway.

Where a peer is missing, say what that costs, once — never fail silently. The Storage
chain in `sourceMapCache.ts` is the worked example.

`tests/loadsWithoutOptionalPeers.ts` checks every `src/` file for a top-level value
import of any peer. `npm run smoke:install` does it for real against the packed tarball.

## fsl doctor — facts, not guesses

Doctor reports only what it can read from a file with a fixed format — `firebase.json`,
`package.json`, `node_modules/*/package.json`, `dist/`, `.release` — and never infers
from source code. A check that has to guess ("is `initLogger` called?") stays out, or
ships later as a finding marked as a hint. A doctor that is sometimes wrong is ignored.

The Setup lines follow the same rule. The Storage line names the library the installed
packages give, and no bucket: an app can name a bucket in code, and doctor does not read
code.

A finding's fix must work as written. `install-skills` does not replace a skill file that
is there unless it can ask or gets `--force`, so the fix of `skill-out-of-date` names
`--force`; without it an agent runs the fix, nothing changes, and the finding stays.
Replacing a stamped file with no flag was rejected: a person may have changed it.

A check that cannot run is the error `could-not-check`, never a pass: expo-doctor once
exited 0 when it could not read its config, and CI went green on projects nobody
checked. The finding ids and `--json` fields are public API from 1.0.

**Doctor finds each half of the app in a fixed order, and the first answer wins.** The
backend folder: `--backend`; then the `functions` key of `firebase.json`; then a search;
then no answer. The web build: `--dist`; then each `hosting.public`; then no answer. A
flag wins because a person typed it. `firebase.json` answers only for a key it holds: a
file with `hosting` and no `functions` key names a web build and no backend, which is a
Hosting app whose backend runs on Cloud Run.

The search is a deduction from two files with a fixed format, never from source code. The
candidates are the project root and each folder one level down whose `package.json` lists
this package as a dependency. A candidate that holds a web build folder is the web side
and is removed. The search answers only when the web build is known and exactly one
candidate is left; with no known web build, one folder with fsl could be either half. No
candidate left means the backend is not checked, and doctor does not say that the app has
none. More than one left, or one with no known web build, is `could-not-check`: the
message names the folders and the fix names the flag. A `package.json` the search cannot
parse, in a folder that is not a web build, is also `could-not-check`: that folder may be
the backend.

The kind is `firebase` only when the backend folder is the one the `functions` key names,
so `callable-without-firebase-functions` can appear only when that key is there.
`setup.backendFrom` says which step answered (`flag`, `firebase.json`, `search`), and the
Setup line marks a backend that the search found, so a person can see the deduction and
correct it with `--backend`. The search has one case it gets wrong: a second web app that
has fsl, is not in `hosting`, and is the only candidate left is taken for the backend.

**A skill runs the `fsl` of the installed package it found.** `fsl` on npm is another
author's package, and `npx fsl` in a folder with no local install reaches for that one. A
project root can be such a folder: an app with `backend/` and `frontend/` and no root
`package.json` has no install there. A project root with no install must name the folder
that has one anyway, so a skill runs the bin by its path,
`<install folder>/node_modules/.bin/fsl`, which asks npm nothing.

## Skills and `fsl logs` are for agents

The skills and the CLI are read by a coding agent far more often than by a person, and
they are designed for that reader.

`CAPABILITIES.md` is written for an agent reader, never a person: every capability has the
same four headings in the same order (Gives, Fits when, Add, Mistakes); each section stands alone,
with no "see above" and no pointer to another section; Fits when lists things to grep for
(imports, calls, markup), not situations; Add is one entry point and one minimal example
that `tests/capabilities.ts` checks against the real exports; each mistake reads
pattern → why it is wrong → the fix. No motivation, no history. Keep that shape when you edit it.

**An example in `CAPABILITIES.md` must work as written, because an agent copies it.** So
every client `initLogger` example passes `releaseId` and `logFunction`, which the type
requires, and `tests/capabilities.ts` checks each one. Two more
have a reason that the example cannot show. A labels type is a `type` alias: the limit on
`AppLabels` is `Record<string, string | undefined>`, an `interface` has no index signature,
and `initLogger<MyAppLabels>` then fails with TS2344. `tests/` type-checks both forms, so
the Mistakes line about it stays true. And `createHttpLogHandler` is mounted with `app.all`:
the handler answers the browser's `OPTIONS` request itself, and under `app.post` Express
answers it first, with no CORS headers, so the browser blocks every log from another origin.

**Every deprecated name is a Mistakes line.** The review knows a deprecated name only
through `CAPABILITIES.md`; the run-time warning and the `@deprecated` tag need a person at
a console or an editor. So each name has a line with its replacement, in the section a
reader of that code is in, and a test joins the list the deprecation tests use to those
lines: a new deprecation with no line fails. Doctor reads no source code and has no check
for this.

**A comment names no README section and no page of the site.** Doc comments reach apps
through the `.d.ts` files, and agents read them there; a section can be cut and a page
address can change. A comment says by itself what a caller must know.

**Facts live in the package; skills hold only steps.** `install-skills` copies a skill
into the app, and the copy does not change when the app updates fsl — POUR5 ran a copy
that still taught `bc.nav` for months. So what an app can add to its code and config is in
`CAPABILITIES.md`, which ships in the package and always matches the installed version:
for each capability, what it gives, when it fits, how to add it, and the mistakes to
avoid. The tools an agent runs are not capabilities and are not in it: `/fsl-review` runs
`fsl doctor` itself, and `/fsl-logs` and the command's own errors teach `fsl logs`. A skill says how to
work (read the file, read the code, propose, stop) and names nothing that a release can
change. The one thing a stale copy can still get wrong is its own steps, so
`install-skills` stamps `fsl-version` into the frontmatter and doctor reports
`skill-out-of-date` when it differs from the fsl running doctor — the same package that
stamped it, read from its own `package.json`, within doctor's rule. Labels an app adds are not in `CAPABILITIES.md`: `fsl logs schema` reads
them from the logs, and an agent reads `AppLabels` and the `labels` arguments in the
app's own code for what it *could* write.

**`/fsl-review` proposes and stops.** It reads `CAPABILITIES.md` and the code in the
scope, and says how fsl could best serve that code. No levels, no fixed output shape,
no `file:line` quota: the user trims the proposal, and what happens next — edits, issues,
subagents — is an ordinary request to their agent, not the skill's business. It runs
`fsl doctor` only when the scope is the whole project; doctor checks the setup, and the
setup has nothing to say about `src/checkout`.

**The review lists what the code has before it decides where a capability fits.** The
"Fits when" lines of `CAPABILITIES.md` are words to search for, and an agent that has a
word list searches the list and stops: an app with hand-made overlays has none of the
words. So the review first lists what is in the scope, each component file and each block
that is rendered on a condition, and then decides for each item which capability covers
it, or none. The words help to find places; they are not the limit of the search. The
proposal says in one line what was read, so the owner can see what was not looked for.

**Before the review proposes to remove code, it reads the comments at that place.** A
line that matches a Mistakes pattern can be there for a reason the pattern does not know.
When the code says why it is there, the proposal gives both sides and does not call the
removal a fix.

**The review checks every Mistakes line of a capability the code already uses.** A
capability that is in the code is not, for that reason, used correctly: an app had
`bc.handledError` one line above `logger.error`, and a review that saw the client setup
"present and correct" did not name it. "Say nothing about code that is already right" is
a rule for the proposal, and "right" is decided only after the Mistakes lines of that
capability were held against the code.

**Where a capability fits many places, the proposal is by user flow and ends with a
question.** The review can see where a mark fits; only the owner knows which flows matter,
and a mark on everything fills the trail with small clicks. So the proposal groups the
places by what the user is trying to do ("Checkout: 5 controls"), says which flow it would
do first, and asks which flows matter most. The question comes after the code is read,
never before: a goal asked for with nothing to choose from gets a vague answer. The skill
states this step in general terms and names no capability. Which flows to prefer for a
capability is a fact, so it lives in that capability's section of `CAPABILITIES.md`.

**`fsl logs` is flags named after SQL clauses, never a SQL string.** An agent writes
`--where labels.screen=Checkout --group-by labels.screen` reliably; a single
`"SELECT ... WHERE severity='ERROR'"` needs nested quotes, and one extra shell quoting
layer is the most common way an agent's command fails. Flags are also checkable one at a
time, so an unknown field is an error that names the valid ones and shows an example —
agents invent flags, and the error is where they learn. Output is JSONL, `--select` is the
field mask, `--limit` is 100 by default and 1000 at most, and a cut result says on stderr
how many more there were and how to narrow. The transport is `gcloud logging read`:
every path to Cloud Logging needs `gcloud` for ADC anyway, so a Google library would add
install weight for 1.5 seconds. The transport is one function behind the filter builder,
so `@google-cloud/logging` can replace it later without touching a flag. The query
processor and the local-file reader are the ones from `firebase-mcp-server`, copied, not
shared as a package: two users do not justify a third repo. Group by, distinct and
aggregates stay because they are what lets an agent answer "which screen?" in ten lines
instead of five thousand; `dist/tools` never reaches an app's bundle, so its size is
not a cost.

**`fsl logs` sends a condition to the server only when it surely means the same there.**
A label key nobody has confirmed (not in `BaseLabels`, `schema.json` or the entries read)
stays client-side: a typo sent to Cloud Logging returns zero entries and leaves nothing to
compare the key against, and the "Did you mean" error would never fire. The bucket for
`attachments` comes from `--bucket` or `FIREBASE_STORAGE_BUCKET`, the variable
`upload-sourcemaps` reads: `firebase.json` holds no bucket name, and doctor's rule is to
read only what a file's fixed format says.

**`fsl logs` reads the entries fsl wrote, unless `--all` asks for every line.** The scan
stops at 5000 entries, and on Cloud Run a service's own request lines fill it: a question
over seven days was answered from the last day, and `schema` showed two labels. So the
filter asks Cloud Logging for entries that carry the `appId` label, which every entry fsl
writes has. `--all` reads every line of the service, for the failure where fsl wrote
nothing: out of memory, a crash at startup. A query that finds nothing says that `--all`
exists, because that is the moment an agent needs it. When the scan stopped at its limit
and nothing matched, the answer is "not known", never "0 matched": the tool read the
newest entries only.

**A flag's value comes after `=` or after a space, in every `fsl` command.** `fsl logs`
takes `--project my-id`, so a person types `--backend backend` for doctor too; read as a
switch, that was a backend folder named `true`. A flag that takes a value and gets none
is an error that shows the correct form, never the word `true`.

**An error's example is for the command that was typed.** A wrong flag on
`fsl logs schema` shows a `schema` example, never a query: an agent copies the example.

**A word `fsl logs` does not know is an error.** `schema` and `attachments` come directly
after `logs`. A word anywhere else was ignored, so `fsl logs --local schema` ran a plain
query and printed "0 entries matched", which reads as an empty schema. The error shows the
correct form, as the errors for an unknown flag and an unknown field do.

**The tools sign in with a key file when one is named, and then with nothing else.** The
name is `GOOGLE_APPLICATION_CREDENTIALS`, Google's own, a path to a key file; the tools
load `.env.local`, so an app writes it once. `fsl upload-sourcemaps` passes the file to
the Storage library. `fsl logs` starts `gcloud`, which ignores that name, so it hands the
file to its `gcloud` process alone through `CLOUDSDK_AUTH_CREDENTIAL_FILE_OVERRIDE`; the
person's own `gcloud` login is not touched. With no key file named, `gcloud logging read`
signs in with `gcloud auth login`, not application-default credentials.

The key wins: a tool that was given a key never falls back to the personal login. A
fallback hides the real fault (the last error is about the login, not the key), works on
one machine and fails on the next, and lets a person's account do an upload that was
meant for the service account. So a key that may not read logs is one error that names the
role, `roles/logging.viewer`, and a path to a file that is not there is an error from the
tool that reads it, never a silent use of another account. Doctor has no check for the
key: no key file is a correct setup, and a role cannot be read from disk.

A leading `~` in the path is the home folder: `.env.local` is read by fsl and not by a
shell, so nothing else expands it, and a person writes the path as in a terminal.

Only a path. The key as text in a variable has no standard name, and `gcloud` takes a
file, so fsl would write a secret to disk on every run. No flag either: the line in
`.env.local` is written once, and a flag is typed on every command.
`FIREBASE_SERVICE_ACCOUNT_PATH` is the deprecated name for the same path. It still works,
warns once, and wins when both are set, which is what `upload-sourcemaps` did before.

**`fsl logs schema` keeps two kinds of knowledge apart.** `fromLogs` is what the logs
show — keys, counts, up to three sample values — and `--refresh` rewrites it. `fromCode`
is what an agent found by reading the app, added with `--add name [meaning]`, and
`--refresh` leaves it alone. Samples are skipped for `userId` and for any app-added key whose name
contains `email`, `name` or `phone`, so the file can be pasted into an issue; keys in
`BASE_LABEL_KEYS` other than `userId` are fsl's own and keep theirs (`functionName` is a
code name, not a person's). The cache is `.fsl-logs/schema.json`, per machine, and ignored
by git because every folder fsl creates for logs holds a `.gitignore` of `*`
(`makeSelfIgnoringFolder`, which never overwrites one): dev logs and downloaded
attachments can hold user data, and a setup step an app must remember is one it forgets.

**`install-skills` asks before it removes a skill**, and `--force` answers yes. It
removes only skills this package used to ship (`logs`, `query-logs`), never anything an
app wrote itself.

## Tests run from a fresh clone

Everything in `npm test` and `npm run smoke:install` must run for someone who has just
cloned the repo and run `npm install` — no Google Cloud project, no `.env` files, no
installs in `smoke/`. Doctor's tests build small fake projects in temp folders rather
than pointing at `smoke/functions` or `smoke/cloudrun`, which depend on the maintainer's
private smoke setup. Only `npm run smoke` needs a real project.

## Where the user is — one way in for each kind of place

A page with a URL change is navigation (`enableNavigation`); a page without one is
`navigatedTo`; anything inside or on top of a page is a view (`enableViews()` and
`data-fsl-view` markup), a label and never a breadcrumb; what the user did is `bc.action` or markup
(`data-fsl-action` with `enableActions()`). Each produces one breadcrumb or label, never two for the same
event — that is why `bc.nav` and `setScreen` are ignored once navigation is on.
`labelsFor` customises the default `history` wrapper only. A router adapter
(`/client/navigation/vue-router`, `/client/navigation/react-router`) is a second source
of the same event, not a `labelsFor`: it listens to the router instead of wrapping
`history`, because the router knows the pattern and name and `pushState` does not. Its
one option, `adjust`, edits the router's answer. Only one source runs — the adapter wins
over `enableNavigation()` with one warning, and a second adapter call stops the first.

The adapters type the router structurally and have no peer dependency: they read
`router.subscribe` / `state.matches` (React Router data router, 6.4+ and 7) and
`afterEach` / `currentRoute` (Vue Router 4). The rules that keep one change one crumb:
React records the first page only once `router.state.initialized` is true — before
that, matches exist but loaders have not run, so a first-load redirect would record a
page nobody saw — and after that only when `location.key` changes, so a loader
`redirect()` collapses to its final page, while a `<Navigate>` element records both the page
that renders it and the page it ends on; `route` is joined from the route configs, so it never holds the `basename`, while
`path` (`location.pathname`) does; Vue skips a navigation with a `failure` and
anything before the first real match (`START_LOCATION`), and uses `to.path`, never
`fullPath`. Tests drive real routers in memory — `createMemoryRouter`, and
`createRouter` with `createMemoryHistory` — with both React Router majors installed
through npm aliases.

## Errors a framework catches are logged where it catches them

`setupGlobalErrorHandler()` hears only what reaches `window`, and a framework that catches
an error stops it there. So fsl takes each error at the hook of whoever caught it, and every
error has exactly one way in:

| Caught by | Hook | Wired by |
|---|---|---|
| nothing | `window` `error` / `unhandledrejection` | `setupGlobalErrorHandler()` |
| a React boundary — React Router's default page, an `errorElement`, an `ErrorBoundary` | `createRoot(el, { onCaughtError })` | the app, with `handleReactError` |
| Vue | `app.config.errorHandler` | the app, with `handleVueError` |
| a data router's loader or action | `router.state.errors` | the React Router adapter, always on |
| Vue Router — a guard that throws, a lazy route that fails | `router.onError` | the Vue Router adapter, always on |

The sets do not overlap — tested with real routers: a render error reaches only
`onCaughtError`, a loader error only `router.state.errors` — so nothing is logged twice, and
the app's own boundary shows UI and never logs. `onCaughtError` cannot move into the
adapter: the root exists before the router. Route labels need no extra work, because
navigation already puts them on every entry. A `redirect()` is a page change, never an error;
an adapter called again, or stopped, takes its error listener with it, so an app that makes
a new router at each sign-in does not log twice.

## An error that reaches the browser logger leaves one breadcrumb

The trail of an entry is self-contained: the reader of one feedback entry, or of a later
error, sees what happened before it with no second query. So an error that reached the
logger must be in the trail of everything after it, and the app must not have to say so:
the error is stated once, at `logger.error()` or at the hook that caught it.

When an entry that carries an error reaches the client logger, the logger adds one `error`
breadcrumb whose name is the entry's `errorType`, and no data. It reads that entry's own
trail first, so an entry never lists itself, and it does both before `error()` returns, so
feedback sent in the same tick shows the error. Every way in ends at the same place
(`logger.error()`, the global handler, the React and Vue hooks, the router adapters), so
each gets the breadcrumb with no code of its own.

Sent or not. An error the rate limiter counts as a duplicate, or refuses, still happened,
and a breadcrumb lives for five minutes while a duplicate is counted for far longer: with
a breadcrumb for sent entries only, a crash at 10:00, the same crash at 10:20 and feedback
at 10:21 gave a trail with no crash in it. What the limiter decides is what goes to the
server; the trail is what the user went through.

Never twice in a row. When the newest breadcrumb in the trail is already an `error` with
the same name, the logger adds nothing, so a loop that throws fifty times leaves one
breadcrumb and the user's clicks stay in the trail. A crash, a click and the same crash
are three breadcrumbs, which is the true story. A repeat summary adds nothing; it is sent
later and is not an event of that moment. The repeat signature reads `action` breadcrumbs
only, so this changes no signature.

`bc.handledError` stays for the opposite case: an error the code handled and did not log.

## The backend writes the local log file in development only

`fsl logs --local` reads a file the backend writes on the developer's machine, into
`logLocalDir`. The Functions emulator is one kind of development; a server started with
`tsx watch` or `node` is another, and it gets the same file. So the file is written when
`logLocalDir` is set and the process is not in production, and production is read from two
facts: `K_SERVICE` is set, which Cloud Run and Cloud Functions both do, or `NODE_ENV` is
`production`, the Node convention that covers a VM and every other host. Inside the
emulator the file is written as before.

A test run is not development either. An app's unit tests call the same logger, and their
errors in `dev.jsonl` would answer "what failed just now" with failures nobody had. So
`NODE_ENV` `test` writes no file, as `production` does; Jest and Vitest both set it before
any app code loads. A runner that sets no `NODE_ENV` (Mocha, `node --test`) still writes,
and its app sets `NODE_ENV=test` in the test script. Inside the emulator `NODE_ENV` is not
read.

An app sets `logLocalDir` once, in code that also runs live, so the check is fsl's and not
the app's. With no `logLocalDir`, no file is ever written. The case fsl cannot see is a
live server off Google Cloud that never set `NODE_ENV`: there the file is written, bounded
by its record and rotation limits, and the app can pass `logLocalDir` only when it knows it
is in development.

Only the file is new off the emulator. What the process prints is the production shape, as
before, and an entry in the file has the shape the emulator branch writes, which is the
one `fsl logs --local` reads. The severity floor does not move either: `DEBUG` in the
emulator, `WARNING` everywhere else, so the file of a dev server holds warnings and errors
until the app passes `minSeverity`. A lower floor would also change what that server
prints, which is a second change.

## A backend handler's throw is logged by `withLogging`

Logging is an aspect: a handler reads the same with logging or without it. So a handler
needs no `try`/`catch` only to log. `withLogging` already wraps the handler, which makes it
the one place that can log a throw with the request's labels, and it then throws the same
value again, unchanged — the caller's result, a schedule's failure and a task's retry are
what they were.

The severity follows the rule the React Router adapter uses for responses. An error that
carries an HTTP status below 500 is an answer to the caller, not a fault, and is a
`WARNING` with its code and status and no stack: `permission-denied`, `not-found`,
`invalid-argument`. Anything else is an `ERROR` with the full error payload: a plain
`Error`, a status of 500 or more. The status is read from the error's own
`httpErrorCode.status`, the shape of the Firebase `HttpsError`, so nothing imports
`firebase-functions` for it.

An error is logged once. Every backend `error()` call remembers the object it was given,
and `withLogging` skips a throw it finds there. So a handler that still has
`catch (err) { logError(err); throw err }` keeps one entry, and an app removes those blocks
when it wants to. A handler that logs one error and throws a different one gets two
entries, because they are two errors. `withLogging` remembers the object of a `WARNING`
too, so a throw through two nested `withLogging` is one entry, written by the inner one. A
`WARNING` carries the `errorType` label, the error's `name`, as an `ERROR` does.

There is no option to turn this off. A handler that wants silence catches the error and
does not throw it again; a refusal that is not a fault is an `HttpsError` with a 4xx code.

Firebase also logs: for a callable that throws anything but an `HttpsError`, the SDK writes
its own `Unhandled error` entry at `ERROR`, with none of fsl's labels. fsl leaves it there.
The only way to stop it is to throw a different error from the one the app threw, and fsl
never changes an app's error. So such a throw is two `ERROR` entries: ours, which the
labels find, and Firebase's.

Only `withLogging` does this. `createHttpLogHandler` receives a browser's logs and wraps
no handler of the app's.

## Views are read when an entry is written

`/client/views` keeps no state about what is open: no listeners, no observers, no
open/close calls. When an entry is built, the core asks the reader that
`enableViews()` registered through `setViewReader()` in `breadcrumbs.ts` — a named
setter, not a general "extra labels" hook, so a later helper cannot silently replace it.
The reader joins the names of visible `[data-fsl-view]` marks in page order;
visibility is `checkVisibility()` with `getClientRects()` as the fallback. Repeat
summaries skip it: they are sent later, and the view at send time is not where the
errors happened. jsdom has no layout, so tests stub `checkVisibility` in
`tests/browserStubs.ts`.

## `/testing` is for apps' tests, and asserts what ships

`captureEntries()` is a `logFunction` that keeps what the logger sends — the real
output, after cleaning, size limits and the rate limiter — not a getter of internal
state; a getter would let an app's test pass while the sent entry is wrong.
`resetSession()` is separate from `capture.clear()` on purpose: one resets the
logger's session state, the other the test's list. No core module imports
`/testing`, and nothing in it may need a DOM.

Log calls return `void`: a promise would be a floating promise at every log call in an
app. So a test waits with `capture.settled()`. The core tells `/testing` about each send
through `setSendWatcher` in `logger.ts`, a named setter that no entry point exports. With
no watcher set, the call does nothing, and the list of running sends lives in `/testing`,
so production keeps none. The logger has one watcher, so a second `captureEntries()` replaces
the first's — and the running sends are one list in `/testing`, not one per capture, or the
first capture's `settled()` would return at once while its entries were still on the way.
`tests/configureTwice.ts` pins that.

## Repeats are told apart by what the user did

A repeat's signature is the error type, the message, the screen, and the names of the last
3 `action` breadcrumbs at most since the last `nav` breadcrumb. Two paths to one crash are
often two bugs, so each gets its own full copies and summary. Only signals that move at
human speed go in: a flood repeats with no new click between, so it keeps one signature and
stays collapsed. Never `data`, timestamps, `state` breadcrumbs (an app can emit them in a
loop) or network breadcrumbs (their URLs carry ids). There is no option: an app with no
actions gets the signature it always had. No label shows the path on a summary;
`repeatKey` joins it to a full copy, whose breadcrumbs do.

## Marked actions are recorded where the browser delivers them

`/client/actions` adds three listeners on the document, all in the capture phase:
`click`, `submit` and `change`. Capture, so a crumb is recorded before the app's handler
runs (an error that handler throws carries the click) and `stopPropagation` in the app
cannot hide it. Each event finds the nearest `[data-fsl-action]` on `composedPath()`, so a
mark inside an open shadow root counts. The marked element decides which event is its
action, so nothing is recorded twice: `<form>` on `submit`; `<select>`, `<input>`,
`<textarea>` on `change`; anything else on `click`. An event whose nearest mark expects a
different event is ignored. Only the attribute's value is read, and it becomes an `action`
breadcrumb through `addBreadcrumb`; never the element's text, value or other attributes,
which can hold personal data. Observe only: no browser API is wrapped.

## Optional client helpers are separate entry points

Navigation, and the helpers after it (#51 timing, #58 views, #52 marked actions, #53 network), each
ship as their own subpath — `/client/navigation`, not an `initLogger` option. A bundler
cannot drop code behind a runtime option, and this package is CommonJS, which bundlers
barely trim at all; a separate file that is never imported costs nothing. The core
`/client` must not import a helper — `tests/` bundles `/client` and asserts none of the
helper's code is in it. A helper hands data to the core through a small setter in a core
module (as `screen` does through `breadcrumbs.ts`), never the other way round.

Dynamic `import()` was considered and rejected: in a CommonJS build it compiles to
`require`, so nothing splits, and a late load misses the route changes made before it
arrives.

## Traces report misbehaviour, nothing else

Timing traces (`/client/timing`, `/functions`) exist to explain the slow case. A run that
finishes within its limits sends nothing — no entry, no breadcrumb, no console line —
and there is no sampling or percentile story, on purpose: measuring what is normal is a
monitoring tool's job. A run that was hidden or paused is never judged, because a
browser pausing a page is not the app being slow; the late-tick watchdog exists because
laptop sleep often fires no event. The server judges only when a step or trace ends: no
timers, since the CPU can be throttled after a response.

## Wrapping browser APIs

Navigation tracking wraps `history.pushState` and `replaceState` — browsers send no
event when a single-page app changes route, so there is no other way to see it. That is
patching someone else's page, so it is opt-in (`enableNavigation()`), and the wrapper must
call the original with the same arguments and `this` and return its result, wrap once
however often `initLogger` runs, and leave alone any wrapper another tool installed
before or after it. Prefer observing to wrapping wherever the browser offers it
(`popstate`, `PerformanceObserver`); a wrapper is the exception that needs a reason.

## Docs for people live on the site, not in this repo

`https://fsl.dasasian.com/` is the product site (Starlight, in the `dasasian-web` repo).
It holds every page a person reads. This repo holds three things: a short `README.md`,
`CAPABILITIES.md` for agents, and the code with its doc comments.

The README is the front page: the one npm and GitHub show, and the one a visitor judges
the package by in a few seconds. It holds what answers "what is this and why would I
click": the pitch, the picture of how it works (`assets/how-it-works.svg`, whose `alt`
text says the same in words), six results that each link to their page, the install
line, a quick start for both halves, the idea in one table ("Say it once, where it
happens": where, what you write, what you get), and a map of every page of the site.
Those are its parts. It explains nothing more, and a new part needs a reason this
paragraph can state: the long README grew one good section at a time. Two copies of one explanation drift, and the long README was where 1.4.0's
examples that did not compile lived.

So the quick start is compiled. Its two code blocks are the text of two files under
`tests/`, which the typecheck covers, and a test fails when the README and those files
differ. Every name in code type in the "Say it once" table must exist in `src/`; the
same test fails on one that does not, and on one it has no check for. A page list has no such check: when the site adds, moves or removes a page, the
`dasasian-web` session says so, and the map changes here. README links to the site end
with a slash, because the site redirects an address without one.

Text for people never moves into `CAPABILITIES.md`; that file keeps its shape for its
reader. A deprecation is stated in the code, with a `@deprecated` tag that names the
replacement: the `.d.ts` files are the only place in the package that can say it. When
a change needs a page changed, tell the `dasasian-web` session what changed; this repo
does not hold the page.

## Releasing

A library → **npm only** (no registry, no `server.json`, no tag-triggered publish workflow).
Full process + gotchas: `../PUBLISHING.md`. The short version:

1. Update `CHANGELOG.md` ([Keep a Changelog](https://keepachangelog.com) format): rename
   `[Unreleased]` to `[X.Y.Z] — <date>`, open a fresh empty `[Unreleased]`, and update the
   two link refs at the bottom of the file.
2. Bump `version` in `package.json`.
3. Commit `chore: release X.Y.Z` and push.
4. **Wait for CI on `main` to go green** (`gh run list --branch main --limit 1`). 0.7.0
   shipped on a red `main`: `tsconfig.check.json` was never committed, local typecheck
   passed because the file existed here, and nobody looked at the run.
5. `npm publish` — needs your OTP. Traps: a `404 on PUT` = lapsed token (`npm login`);
   `npm view` can 404 for ~2 min after a *successful* publish (confirm with
   `npm access list packages`, don't re-publish).
6. `git tag vX.Y.Z && git push origin vX.Y.Z`; `gh release create vX.Y.Z` with the CHANGELOG notes.
7. Update the pages of `fsl.dasasian.com` in `dasasian-web`. Only
   `npm publish` and the release need your credentials; an agent drives the rest.
