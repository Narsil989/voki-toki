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
const ROOM_LIMIT = 2
const rooms = new Map()
const socketToRoom = new Map()

const sendJson = (socket, payload) => {
  if (socket.readyState === socket.OPEN) {
    socket.send(JSON.stringify(payload))
  }
}

const getRoomSet = (room) => {
  if (!rooms.has(room)) {
    rooms.set(room, new Set())
  }
  return rooms.get(room)
}

const leaveRoom = (socket) => {
  const room = socketToRoom.get(socket)
  if (!room) return null
  const members = rooms.get(room)
  if (members) {
    members.delete(socket)
    if (members.size === 0) {
      rooms.delete(room)
    } else {
      for (const peer of members) {
        sendJson(peer, { type: 'room-state', room, count: members.size, limit: ROOM_LIMIT })
      }
    }
  }
  socketToRoom.delete(socket)
  return room
}

const joinRoom = (socket, room) => {
  const cleanRoom = room?.trim()
  if (!cleanRoom) {
    sendJson(socket, { type: 'error', code: 'invalid-room', message: 'Room is required.' })
    return
  }

  leaveRoom(socket)
  const members = getRoomSet(cleanRoom)
  if (members.size >= ROOM_LIMIT) {
    sendJson(socket, { type: 'error', code: 'room-full', message: 'Room is full.' })
    return
  }

  members.add(socket)
  socketToRoom.set(socket, cleanRoom)

  for (const peer of members) {
    sendJson(peer, { type: 'room-state', room: cleanRoom, count: members.size, limit: ROOM_LIMIT })
  }
}

const broadcastToRoom = (sender, data, isBinary) => {
  const room = socketToRoom.get(sender)
  if (!room) return
  const members = rooms.get(room)
  if (!members) return
  for (const client of members) {
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
    if (!isBinary) {
      const text = data.toString()
      try {
        const payload = JSON.parse(text)
        if (payload.type === 'join') {
          joinRoom(socket, payload.room)
          return
        }
        if (payload.type === 'leave') {
          leaveRoom(socket)
          return
        }
        if (payload.type === 'audio-config') {
          broadcastToRoom(socket, data, false)
          return
        }
      } catch (err) {
        // fall through: ignore invalid json
      }
    }
    broadcastToRoom(socket, data, isBinary)
  })

  socket.on('close', () => {
    leaveRoom(socket)
    console.log(`[ws] disconnected ${remoteAddress}`)
  })

  socket.on('error', (err) => {
    console.error('[ws] socket error', err)
  })
})

server.listen(PORT, () => {
  console.log(`[server] listening on http://localhost:${PORT}`)
})
