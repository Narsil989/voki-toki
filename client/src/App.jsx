import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import './App.css'

const MIME_CANDIDATES = [
  'audio/webm;codecs=opus',
  'audio/ogg;codecs=opus',
  'audio/webm',
  'audio/ogg',
  'audio/mp4',
]

const formatBytes = (bytes) => {
  if (!bytes && bytes !== 0) return '--'
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`
}

const formatTime = (timestamp) => {
  if (!timestamp) return '--'
  const date = new Date(timestamp)
  return date.toLocaleTimeString()
}

function App() {
  const [wsStatus, setWsStatus] = useState('disconnected')
  const [error, setError] = useState('')
  const [devices, setDevices] = useState([])
  const [selectedDeviceId, setSelectedDeviceId] = useState('')
  const [supportedTypes, setSupportedTypes] = useState([])
  const [selectedType, setSelectedType] = useState('')
  const [timeslice, setTimeslice] = useState(250)
  const [isRecording, setIsRecording] = useState(false)
  const [logEntries, setLogEntries] = useState([])
  const [lastTx, setLastTx] = useState(null)
  const [lastRx, setLastRx] = useState(null)
  const [incomingMeta, setIncomingMeta] = useState({ mimeType: '', sampleRate: null, channels: null })

  const wsRef = useRef(null)
  const recorderRef = useRef(null)
  const streamRef = useRef(null)
  const playQueueRef = useRef(Promise.resolve())
  const incomingMetaRef = useRef(incomingMeta)

  const supported = useMemo(() => {
    if (!window.MediaRecorder) return []
    return MIME_CANDIDATES.filter((type) => window.MediaRecorder.isTypeSupported(type))
  }, [])

  useEffect(() => {
    if (!window.MediaRecorder) {
      setError('MediaRecorder is not supported in this browser.')
    }
    setSupportedTypes(supported)
    if (supported.length > 0) {
      setSelectedType((prev) => (supported.includes(prev) ? prev : supported[0]))
    }
  }, [supported])

  useEffect(() => {
    incomingMetaRef.current = incomingMeta
  }, [incomingMeta])

  const appendLog = useCallback((message, level = 'info') => {
    setLogEntries((prev) => {
      const entry = {
        id: `${Date.now()}-${Math.random().toString(16).slice(2)}`,
        message,
        level,
        time: Date.now(),
      }
      return [entry, ...prev].slice(0, 8)
    })
  }, [])

  const refreshDevices = useCallback(async () => {
    if (!navigator.mediaDevices?.enumerateDevices) {
      setError('Media devices API not available in this browser.')
      return
    }

    try {
      const deviceList = await navigator.mediaDevices.enumerateDevices()
      const microphones = deviceList.filter((device) => device.kind === 'audioinput')
      setDevices(microphones)
      if (!selectedDeviceId && microphones[0]) {
        setSelectedDeviceId(microphones[0].deviceId)
      }
    } catch (err) {
      setError(err?.message || 'Unable to list audio devices.')
    }
  }, [selectedDeviceId])

  useEffect(() => {
    refreshDevices()
    const handler = () => refreshDevices()
    navigator.mediaDevices?.addEventListener?.('devicechange', handler)
    return () => navigator.mediaDevices?.removeEventListener?.('devicechange', handler)
  }, [refreshDevices])

  const connectWs = useCallback(() => {
    if (wsRef.current && wsRef.current.readyState <= 1) {
      return
    }

    const protocol = window.location.protocol === 'https:' ? 'wss' : 'ws'
    const url = `${protocol}://${window.location.host}/ws`

    const socket = new WebSocket(url)
    socket.binaryType = 'arraybuffer'
    setWsStatus('connecting')

    socket.onopen = () => {
      setWsStatus('connected')
      appendLog('WebSocket connected')
    }

    socket.onclose = () => {
      setWsStatus('disconnected')
      appendLog('WebSocket disconnected', 'warn')
    }

    socket.onerror = () => {
      setWsStatus('error')
      appendLog('WebSocket error', 'error')
    }

    socket.onmessage = (event) => {
      if (typeof event.data === 'string') {
        try {
          const payload = JSON.parse(event.data)
          if (payload.type === 'audio-config') {
            setIncomingMeta({
              mimeType: payload.mimeType || '',
              sampleRate: payload.sampleRate || null,
              channels: payload.channels || null,
            })
            appendLog(`Incoming format: ${payload.mimeType || 'unknown'}`)
          }
        } catch (err) {
          appendLog('Received non-JSON message', 'warn')
        }
        return
      }

      const data = event.data
      const mime = incomingMetaRef.current.mimeType || selectedType || 'audio/webm'
      const blob = new Blob([data], { type: mime })
      setLastRx({ bytes: data.byteLength || data.size || 0, at: Date.now() })

      playQueueRef.current = playQueueRef.current.then(
        () =>
          new Promise((resolve) => {
            const url = URL.createObjectURL(blob)
            const audio = new Audio(url)
            audio.onended = () => {
              URL.revokeObjectURL(url)
              resolve()
            }
            audio.onerror = () => {
              URL.revokeObjectURL(url)
              resolve()
            }
            audio.play().catch(() => {
              URL.revokeObjectURL(url)
              resolve()
            })
          })
      )
    }

    wsRef.current = socket
  }, [appendLog, selectedType])

  useEffect(() => {
    connectWs()
    return () => {
      wsRef.current?.close()
    }
  }, [connectWs])

  const stopRecording = useCallback(() => {
    const recorder = recorderRef.current
    if (recorder && recorder.state !== 'inactive') {
      recorder.stop()
      return
    }
    if (streamRef.current) {
      streamRef.current.getTracks().forEach((track) => track.stop())
      streamRef.current = null
    }
    setIsRecording(false)
  }, [])

  const startRecording = useCallback(async () => {
    if (isRecording) return
    setError('')

    if (!navigator.mediaDevices?.getUserMedia) {
      setError('getUserMedia is not supported in this browser.')
      return
    }

    if (!wsRef.current || wsRef.current.readyState !== WebSocket.OPEN) {
      setError('WebSocket is not connected.')
      return
    }

    let stream
    try {
      const constraints = {
        audio: selectedDeviceId ? { deviceId: { exact: selectedDeviceId } } : true,
      }

      stream = await navigator.mediaDevices.getUserMedia(constraints)
      streamRef.current = stream

      const options = selectedType ? { mimeType: selectedType } : undefined
      const recorder = new MediaRecorder(stream, options)
      recorderRef.current = recorder

      const trackSettings = stream.getAudioTracks()[0]?.getSettings?.() || {}
      const meta = {
        type: 'audio-config',
        mimeType: recorder.mimeType || selectedType,
        sampleRate: trackSettings.sampleRate || null,
        channels: trackSettings.channelCount || null,
        timeSliceMs: Number(timeslice) || 250,
      }

      wsRef.current.send(JSON.stringify(meta))

      recorder.ondataavailable = (event) => {
        if (!event.data || event.data.size === 0) return
        if (!wsRef.current || wsRef.current.readyState !== WebSocket.OPEN) return
        wsRef.current.send(event.data)
        setLastTx({ bytes: event.data.size, at: Date.now() })
      }

      recorder.onstop = () => {
        stream.getTracks().forEach((track) => track.stop())
        streamRef.current = null
        setIsRecording(false)
        appendLog('Recording stopped')
      }

      recorder.onerror = () => {
        stream.getTracks().forEach((track) => track.stop())
        streamRef.current = null
        setIsRecording(false)
        setError('Recorder error')
        appendLog('Recorder error', 'error')
      }

      recorder.start(Math.max(50, Number(timeslice) || 250))
      setIsRecording(true)
      appendLog('Recording started')
    } catch (err) {
      if (stream) {
        stream.getTracks().forEach((track) => track.stop())
      }
      setError(err?.message || 'Unable to access microphone.')
      appendLog('Microphone access failed', 'error')
    }
  }, [appendLog, isRecording, selectedDeviceId, selectedType, timeslice])

  useEffect(() => {
    const handleKeyDown = (event) => {
      if (event.code === 'Space' && !event.repeat) {
        event.preventDefault()
        startRecording()
      }
    }
    const handleKeyUp = (event) => {
      if (event.code === 'Space') {
        event.preventDefault()
        stopRecording()
      }
    }

    window.addEventListener('keydown', handleKeyDown)
    window.addEventListener('keyup', handleKeyUp)
    return () => {
      window.removeEventListener('keydown', handleKeyDown)
      window.removeEventListener('keyup', handleKeyUp)
    }
  }, [startRecording, stopRecording])

  const canRecord = wsStatus === 'connected' && supportedTypes.length > 0

  return (
    <div className="app">
      <header className="app__header">
        <div>
          <p className="eyebrow">Voki Toki</p>
          <h1>WebSocket Walkie Talkie Lab</h1>
          <p className="subheading">
            Capture mic audio, send over WebSocket, and test different container formats.
          </p>
        </div>
        <div className={`status status--${wsStatus}`}>
          <span className="status__dot" />
          <span className="status__label">WS {wsStatus}</span>
          <button className="ghost" type="button" onClick={connectWs}>
            Reconnect
          </button>
        </div>
      </header>

      <main className="app__main">
        <section className="panel">
          <div className="panel__header">
            <h2>Capture</h2>
            <span className="pill">PTT</span>
          </div>

          <div className="field">
            <label htmlFor="device">Microphone</label>
            <div className="field__row">
              <select
                id="device"
                value={selectedDeviceId}
                onChange={(event) => setSelectedDeviceId(event.target.value)}
              >
                {devices.length === 0 && <option value="">No devices found</option>}
                {devices.map((device, index) => (
                  <option key={device.deviceId || index} value={device.deviceId}>
                    {device.label || `Microphone ${index + 1}`}
                  </option>
                ))}
              </select>
              <button className="ghost" type="button" onClick={refreshDevices}>
                Refresh
              </button>
            </div>
          </div>

          <div className="field">
            <label htmlFor="format">Recorder format</label>
            <select
              id="format"
              value={selectedType}
              onChange={(event) => setSelectedType(event.target.value)}
              disabled={supportedTypes.length === 0}
            >
              {supportedTypes.length === 0 && <option value="">Unsupported</option>}
              {supportedTypes.map((type) => (
                <option key={type} value={type}>
                  {type}
                </option>
              ))}
            </select>
          </div>

          <div className="field">
            <label htmlFor="timeslice">Chunk size</label>
            <div className="field__row">
              <input
                id="timeslice"
                type="range"
                min="100"
                max="1000"
                step="50"
                value={timeslice}
                onChange={(event) => setTimeslice(event.target.value)}
              />
              <span className="chip">{timeslice} ms</span>
            </div>
          </div>

          <button
            className={`ptt ${isRecording ? 'ptt--active' : ''}`}
            type="button"
            disabled={!canRecord}
            onPointerDown={startRecording}
            onPointerUp={stopRecording}
            onPointerLeave={stopRecording}
            onClick={() => (isRecording ? stopRecording() : startRecording())}
          >
            {isRecording ? 'Transmitting' : 'Hold to Talk'}
          </button>
          <p className="hint">Tip: hold Space to transmit</p>

          {error && <p className="error">{error}</p>}
        </section>

        <section className="panel">
          <div className="panel__header">
            <h2>Stream</h2>
            <span className="pill">Monitor</span>
          </div>

          <div className="stats">
            <div>
              <p className="stat__label">Outgoing</p>
              <p className="stat__value">{selectedType || 'Unknown'}</p>
              <p className="stat__meta">
                Last chunk: {formatBytes(lastTx?.bytes)} at {formatTime(lastTx?.at)}
              </p>
            </div>
            <div>
              <p className="stat__label">Incoming</p>
              <p className="stat__value">{incomingMeta.mimeType || 'Waiting...'}</p>
              <p className="stat__meta">
                Last chunk: {formatBytes(lastRx?.bytes)} at {formatTime(lastRx?.at)}
              </p>
            </div>
          </div>

          <div className="meta">
            <div>
              <span>Sample rate</span>
              <strong>{incomingMeta.sampleRate || '--'}</strong>
            </div>
            <div>
              <span>Channels</span>
              <strong>{incomingMeta.channels || '--'}</strong>
            </div>
          </div>

          <div className="log">
            <div className="log__header">
              <h3>Activity</h3>
              <span>{logEntries.length} events</span>
            </div>
            {logEntries.length === 0 ? (
              <p className="muted">No events yet.</p>
            ) : (
              <ul>
                {logEntries.map((entry) => (
                  <li key={entry.id} className={`log__item log__item--${entry.level}`}>
                    <span>{entry.message}</span>
                    <time>{formatTime(entry.time)}</time>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </section>
      </main>
    </div>
  )
}

export default App
