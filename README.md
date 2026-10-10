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

## Install
```bash
npm install @dasasian/firebase-structured-logger
```
Needs Node 22 or later.

## Docs
[fsl.dasasian.com](https://fsl.dasasian.com/) · [Changelog](CHANGELOG.md)

- [Get started](https://fsl.dasasian.com/start/) · [React](https://fsl.dasasian.com/react/) · [Vue](https://fsl.dasasian.com/vue/)
- [Cloud Functions](https://fsl.dasasian.com/cloud-functions/) · [Cloud Run](https://fsl.dasasian.com/cloud-run/) · [Source maps](https://fsl.dasasian.com/source-maps/) · [Troubleshooting](https://fsl.dasasian.com/troubleshooting/)
- API reference: [client](https://fsl.dasasian.com/reference/client/) · [functions](https://fsl.dasasian.com/reference/functions/) · [CLI](https://fsl.dasasian.com/reference/cli/)

## For coding agents

`npx fsl install-skills` adds `/fsl-review` and `/fsl-logs` to your project. `node_modules/@dasasian/firebase-structured-logger/CAPABILITIES.md` says what an app can add. [`llms.txt`](https://fsl.dasasian.com/llms.txt) lists every page.

## License

MIT © Dasasian
