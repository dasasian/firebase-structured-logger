---
name: fsl-logs
description: Answer a question from an app's logs with `fsl logs` — production through gcloud, or the emulator's local files. Use when asked what happened to a user, which screen or release fails most, how often an error really happened, or to fetch the files an entry saved.
fsl-version: <version>
---

# /fsl-logs

Answer the question with the fewest, smallest queries. `fsl logs` prints one JSON entry per
line, so narrow with flags before you read anything.

## 1. Missing or odd logs? Check the setup first

No entries at all, stacks that stay minified, no attachments: run `npx fsl doctor --json`
before reading logs to explain it. Most of those are setup problems doctor reads off disk.

## 2. Ask the question

Production needs `gcloud` signed in and a project (`--project <id>`, or `.firebaserc`).
Add `--local` to ask `.fsl-logs/` instead; the flags and the output are the same.

```
# One user's story, client and server
npx fsl logs --where labels.userId=<uid> --since 2h --select timestamp,severity,labels.screen,message

# How many errors, per screen, in one release
npx fsl logs --where severity=ERROR --where labels.releaseId=<sha> --group-by labels.screen --select labels.screen,count --order-by "count desc" --limit 10

# What failed just now on this machine
npx fsl logs --local --where severity=ERROR --since 30m --select timestamp,message,jsonPayload.error.message

# Which values a label takes
npx fsl logs --distinct labels.screen --since 1d

# Entries whose message contains a word
npx fsl logs --where message~timeout --since 1d --select timestamp,labels.screen,message --limit 20
```

Group, count and `--select` before you fetch whole entries: ten lines of counts beat five
thousand lines of entries. Whole entries carry stacks and breadcrumbs; ask for them for one
entry at a time.

If a command fails, read the error. It lists the valid flags or fields and shows an
example; an unknown field also suggests the nearest one.

## 3. Find the labels

`npx fsl logs schema` lists every label the logs carry, with counts and sample values.
For what the code could write that the logs have not shown yet:

- The meaning of the labels fsl writes itself: `BaseLabels` in
  `node_modules/@dasasian/firebase-structured-logger/dist/shared/types.d.ts`.
- The labels this app adds: grep for `AppLabels`, `setUser(`, `createLogWriter(`,
  `withRequestLogger(`, and the `labels` argument of `.error(`, `.warning(`, `.info(`, `.debug(`.
- Record one for the next reader: `npx fsl logs schema --add <name> "<meaning>"`.

## 4. How often did an error happen?

Never count entries. A repeating error sends a few full copies and then one summary with
the rest. Take its `labels.repeatKey` and run `npx fsl logs --repeats <repeatKey>`: it prints
the copies, the summaries and a last line with the true count.

## 5. Files an entry saved

When `labels.hasAttachments` is `true`, run `npx fsl logs attachments <labels.logId>`. It
downloads to `.fsl-logs/attachments/<logId>/` and prints each file's path.
