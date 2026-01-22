const http = require('http')
const { WebSocketServer } = require('ws')

const PORT = process.env.PORT || 8080

const server = http.createServer((req, res) => {
  if (req.url === '/health') {
    res.writeHead(200, { 'Content-Type': 'text/plain' })
    res.end('ok')
    return
  }

  res.writeHead(404, { 'Content-Type': 'text/plain' })
  res.end('not found')
})

const wss = new WebSocketServer({ server, path: '/ws' })

const broadcast = (sender, data, isBinary) => {
  for (const client of wss.clients) {
    if (client === sender || client.readyState !== client.OPEN) {
      continue
    }
    client.send(data, { binary: isBinary })
  }
}

wss.on('connection', (socket, req) => {
  const remoteAddress = req.socket.remoteAddress || 'unknown'
  console.log(`[ws] connected ${remoteAddress}`)

  socket.on('message', (data, isBinary) => {
    broadcast(socket, data, isBinary)
  })

  socket.on('close', () => {
    console.log(`[ws] disconnected ${remoteAddress}`)
  })

  socket.on('error', (err) => {
    console.error('[ws] socket error', err)
  })
})

server.listen(PORT, () => {
  console.log(`[server] listening on http://localhost:${PORT}`)
})
