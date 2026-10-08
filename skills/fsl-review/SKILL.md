---
name: fsl-review
description: Review how an app uses firebase-structured-logger and propose how it could best serve that code. Takes a scope (the app, a folder or a file). Use when asked what fsl could do for this code, whether fsl is used correctly, or what to add or fix.
fsl-version: <version>
---

# /fsl-review [scope]

The scope is the app, a folder or a file. If none is given, it is the whole app.

1. Find the installed package nearest the scope: walk up from the scope to the first
   `node_modules/@dasasian/firebase-structured-logger`. If there is none, say so and stop.
2. If the scope is the whole app, run `npx fsl doctor --json` in the project root and keep
   its findings. For a folder or a file, skip this step.
3. Read `CAPABILITIES.md` in that package. It is the only source of what fsl can do, how to
   add it, and what goes wrong. Do not rely on memory of fsl.
4. Read the code in the scope, and find how it uses fsl today: what it imports from the
   package, what it calls, and what the code does that a capability covers.
5. Propose, as a short list, how fsl could best serve this code. Additions and fixes, in
   the order you would do them. Fold in doctor's findings if you ran it. Say nothing
   about code that is already right.
6. Stop. Make no edits and open no issues; the user trims the list and decides what next.
