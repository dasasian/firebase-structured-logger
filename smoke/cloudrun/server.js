/**
 * The Cloud Run half of the smoke run: the backend #39 was about.
 *
 * Plain `http`, no framework, and deliberately NO firebase-functions and NO
 * firebase-admin in package.json — the setup a Hono or Express service on Cloud Run
 * actually has. So everything here goes down the fallback paths:
 *
 *   logging   -> writeJsonLine (stdout/stderr JSON), not firebase-functions' write()
 *   trace     -> parsed from the request header by createHttpLogHandler
 *   storage   -> @google-cloud/storage with FSL_SMOKE_BUCKET (step 2 of the chain)
 *
 * The package comes from a local tarball of the working tree, packed by
 * `npm run smoke:deploy:run` — not from npm.
 *
 * Not public: deployed with --no-allow-unauthenticated, so Cloud Run's IAM check is
 * the gate and the handler itself is 'unauthenticated'. The smoke run calls it with
 * an identity token from `gcloud auth print-identity-token`.
 */

const http = require('http')
const { initLogger, createHttpLogHandler } = require('@dasasian/firebase-structured-logger/functions')

initLogger({ appId: process.env.FSL_SMOKE_APP_ID || 'smoke-app', minSeverity: 'DEBUG' })

const logHandler = createHttpLogHandler({
  authorize: 'unauthenticated',
  bucketName: process.env.FSL_SMOKE_BUCKET,
})

const server = http.createServer((req, res) => {
  if (req.url !== '/log') {
    res.statusCode = 404
    res.end()
    return
  }
  let raw = ''
  req.setEncoding('utf8')
  req.on('data', (chunk) => (raw += chunk))
  req.on('end', () => {
    let body = null
    try {
      body = raw ? JSON.parse(raw) : null
    } catch {
      // Left null: the handler answers 400 with the hint about parsing the body.
    }
    Promise.resolve(logHandler({ method: req.method, headers: req.headers, body }, res)).catch((err) => {
      console.error('[smoke-cloudrun] handler threw', err)
      res.statusCode = 500
      res.end()
    })
  })
})

server.listen(Number(process.env.PORT) || 8080)
