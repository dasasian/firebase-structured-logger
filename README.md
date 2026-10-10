<p align="center">
  <img src="https://raw.githubusercontent.com/dasasian/firebase-structured-logger/main/assets/hero.svg" alt="firebase-structured-logger — structured logging for Firebase apps" width="900">
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/@dasasian/firebase-structured-logger"><img alt="npm" src="https://img.shields.io/npm/v/@dasasian/firebase-structured-logger?style=flat-square&label=npm&color=235a9b"></a>
  <a href="https://github.com/dasasian/firebase-structured-logger/actions/workflows/ci.yml"><img alt="CI" src="https://img.shields.io/github/actions/workflow/status/dasasian/firebase-structured-logger/ci.yml?branch=main&style=flat-square&label=CI"></a>
</p>

<p align="center">
  <a href="https://fsl.dasasian.com/"><strong>fsl.dasasian.com</strong></a>
</p>

# @dasasian/firebase-structured-logger

Structured logging for both halves of a Firebase app.

Your web app crashed at `app-4f2a.js:1:98432`. This tells you it was `Checkout.tsx:42` — in your own Google Cloud project, next to your backend logs. Nothing leaves.

<p align="center">
  <img src="https://raw.githubusercontent.com/dasasian/firebase-structured-logger/main/assets/how-it-works.svg" alt="The browser has no credentials and no source maps. It sends each log to a Cloud Function in your own project, which holds both and writes to Cloud Logging, the same stream your backend functions write to." width="900">
</p>

## What you get

- **A minified stack becomes `Checkout.tsx:42`.** Your source maps stay on your server and never reach the browser. [Source maps](https://fsl.dasasian.com/source-maps/)
- **Browser and backend logs are one stream.** One query finds all that one user did: `labels.userId="…"`. [Labels](https://fsl.dasasian.com/labels/)
- **You see the path to the error.** The pages, the clicks and the open dialog go with each entry. [Breadcrumbs](https://fsl.dasasian.com/breadcrumbs/)
- **Errors are grouped in Cloud Error Reporting.** You add no second product. [How it works](https://fsl.dasasian.com/errors-in-error-reporting/)
- **A flood costs three entries and a count.** Repeats are counted, not dropped. [Volume](https://fsl.dasasian.com/volume/)
- **Your coding agent reads the logs.** `fsl logs` and two skills come with the package. [fsl logs](https://fsl.dasasian.com/fsl-logs/) · [Skills](https://fsl.dasasian.com/skills/)

## Install

```bash
npm install @dasasian/firebase-structured-logger
```

Needs Node 22 or later.

## Quick start

In the browser:

```ts
import { initLogger, setupGlobalErrorHandler } from '@dasasian/firebase-structured-logger/client'
import { getFunctions, httpsCallable } from 'firebase/functions'

export const logger = initLogger({
  appId: 'my-app',
  releaseId: import.meta.env.VITE_RELEASE_ID ?? 'dev',
  logFunction: httpsCallable(getFunctions(), 'logFrontendEvent'),
})

setupGlobalErrorHandler()
```

In your Cloud Functions:

```ts
import { onCall } from 'firebase-functions/v2/https'
import { initLogger, createClientLogFunction, withLogging } from '@dasasian/firebase-structured-logger/functions'

initLogger({ appId: 'my-app' })

export const logFrontendEvent = createClientLogFunction()

export const checkout = onCall(
  withLogging({ functionName: 'checkout' }, async (request) => {
    await chargeCard(request.data)
  }),
)
```

The handler holds no log code. What it throws is logged with `functionName` and the caller's `userId`, and thrown again.

The full setup, with source maps, is in [Get started](https://fsl.dasasian.com/start/).

## Say it once, where it happens

Logging is an aspect of your app, not a part of each function. You state each fact one time, in the place where it is true, and fsl puts it on every entry.

| Where | You write | You get |
|---|---|---|
| At startup | `setupGlobalErrorHandler()` | Every uncaught error, with its stack resolved to your source. |
| Where the user signs in | `logger.setUser(uid)` | The user on every entry from then on. |
| On the button | `data-fsl-action="apply_discount"` | The click, as a step in the trail of any later error. |
| On the dialog | `data-fsl-view="Attachment"` | Every entry written while the dialog is open says so. |
| Around the handler | `withLogging({ functionName: 'checkout' }, handler)` | The function name and the caller's verified user id on every entry, and what the handler throws. |

The two attributes need `enableActions()` and `enableViews()` once at startup. A function takes no logger and no context, and it has no try and catch for the sake of a log. [See one function, before and after.](https://fsl.dasasian.com/#logging-stays-out-of-your-business-logic)

## Docs

[fsl.dasasian.com](https://fsl.dasasian.com/) · [Changelog](CHANGELOG.md)

- **Start:** [Home](https://fsl.dasasian.com/) · [Get started](https://fsl.dasasian.com/start/) · [How it works](https://fsl.dasasian.com/errors-in-error-reporting/)
- **Set up:** [Source maps](https://fsl.dasasian.com/source-maps/) · [React](https://fsl.dasasian.com/react/) · [Vue](https://fsl.dasasian.com/vue/) · [Cloud Functions](https://fsl.dasasian.com/cloud-functions/) · [Cloud Run](https://fsl.dasasian.com/cloud-run/)
- **Capture more:** [Breadcrumbs](https://fsl.dasasian.com/breadcrumbs/) · [Tabs and dialogs](https://fsl.dasasian.com/tabs-and-dialogs/) · [Slow screens](https://fsl.dasasian.com/slow-screens/) · [Feedback](https://fsl.dasasian.com/feedback/) · [Attachments](https://fsl.dasasian.com/attachments/)
- **Find and read:** [Labels](https://fsl.dasasian.com/labels/) · [fsl logs](https://fsl.dasasian.com/fsl-logs/) · [Skills](https://fsl.dasasian.com/skills/)
- **Check and fix:** [Doctor](https://fsl.dasasian.com/doctor/) · [Troubleshooting](https://fsl.dasasian.com/troubleshooting/) · [Volume](https://fsl.dasasian.com/volume/) · [Local development](https://fsl.dasasian.com/local/) · [Testing](https://fsl.dasasian.com/testing/)
- **Reference:** [Browser API](https://fsl.dasasian.com/reference/client/) · [Backend API](https://fsl.dasasian.com/reference/functions/) · [CLI](https://fsl.dasasian.com/reference/cli/)

## For coding agents

`npx fsl install-skills` adds `/fsl-review` and `/fsl-logs` to your project. `node_modules/@dasasian/firebase-structured-logger/CAPABILITIES.md` says what an app can add. [`llms.txt`](https://fsl.dasasian.com/llms.txt) lists every page.

## License

MIT © Dasasian
