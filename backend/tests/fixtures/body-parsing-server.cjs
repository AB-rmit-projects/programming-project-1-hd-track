// Test-only HTTP server, run as a child process by bodyParsing.test.ts so a
// request that crashes the process can't take the test runner down with it.
// Listens on 127.0.0.1 only, on a random port it reports to the parent.
//
// Usage: node body-parsing-server.cjs <path to an express module>

const express = require(process.argv[2])

const app = express()
// The same parsers and limits as createApp() in src/app.ts.
app.use(express.json({ limit: '1mb' }))
app.use(express.urlencoded({ extended: true, limit: '1mb' }))

app.post('/echo', (req, res) => res.json({ body: req.body }))
app.get('/alive', (_req, res) => res.json({ alive: true }))
app.use((err, _req, res, _next) => res.status(err.status ?? 500).json({ status: err.status }))

const server = app.listen(0, '127.0.0.1', () => {
  process.send({ port: server.address().port })
})
