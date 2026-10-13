---
name: fsl-review
description: Review how an app uses firebase-structured-logger and propose how it could best serve that code. Takes a scope (the app, a folder or a file). Use when asked what fsl could do for this code, whether fsl is used correctly, or what to add or fix.
fsl-version: <version>
---

# /fsl-review [scope]

The scope is the app, a folder or a file. If none is given, it is the whole app.

1. Find the installed package. For a folder or a file, walk up from the scope to the first
   `node_modules/@dasasian/firebase-structured-logger`. For the whole app, use the one in the
   project root; if the root has none, look in each folder one level down. When the installs in the project
   have different versions, name each version in the proposal. If there is none, say so and stop.
2. If the scope is the whole app, run `node_modules/.bin/fsl doctor --json`, with the install
   folder from step 1 in front of the path, from the project root, and keep its findings.
   Run it once, with any one install, when the installs in the project have the same version.
   Never run it through npx: with no install in the folder, npx reaches for another package. For a folder
   or a file, skip this step.
3. Read `CAPABILITIES.md` in that package. It is the only source of what fsl can do, how to
   add it, and what goes wrong. Do not rely on memory of fsl.
4. Read the code in the scope, and find how it uses fsl today: what it imports from the
   package, what it calls, and what the code does that a capability covers.
   Before you decide where a capability fits, list what is in the scope: each component
   file, and each block that is rendered on a condition. Then decide for each item which
   capability covers it, or none. The words in "Fits when" help to find places; they are not
   the limit of the search.
5. For each capability the code already uses, hold each Mistakes line of that capability
   against the code in the scope, one line at a time. Code that uses a capability is not right
   for that reason. Call it right only after every Mistakes line of that capability was held
   against it and none fits.
6. Propose, as a short list, how fsl could best serve this code. Additions and fixes, in
   the order you would do them. Fold in doctor's findings if you ran it. Name every Mistakes
   line from step 5 that fits. Say nothing about code that is right after step 5.
   Say in one line what you read: how many files, and the kinds of place you looked for.
   Before you propose to remove code, read the comments at that place. When the code says
   why it is there, give both sides and do not call the removal a fix.
   When one capability fits more than about ten places in the scope, do not list the places.
   The count is for that one capability over the whole scope. Do not add the places of
   different capabilities together.
   Group them by user flow, meaning what the user is trying to do, and give the count for
   each flow. Say in a few words which flow you would do first and why. End the proposal
   with one question that asks which flows matter most to the user.
7. Stop. Make no edits and open no issues; the user trims the list and decides what next.
