# Voki Toki

WebSocket walkie-talkie lab for testing browser audio formats.

## Dev setup

From the repo root:

```powershell
npm install
npm --prefix client install
npm --prefix server install
npm run dev
```

This runs:
- Vite React client on port 5173
- WebSocket server on port 8080

## Repo layout

```
client/   # Vite + React
server/   # Node WS relay
```

## Notes

- Client connects to `/ws` and Vite proxies to `ws://localhost:8080` in dev.
- Hold the PTT button (or Space) to transmit audio.
- Join the same room in two tabs or browsers to talk (2 users max per room).
