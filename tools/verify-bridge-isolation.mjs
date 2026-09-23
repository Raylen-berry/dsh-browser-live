import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { BridgeServer } from '../bridge.js'

// In-memory sockets reproduce messages already queued when an extension reconnects.
class Socket extends EventEmitter {
  readyState = 1
  sent = []
  send(text) { this.sent.push(JSON.parse(text)) }
  close() { this.readyState = 2 }
  receive(value) { this.emit('message', JSON.stringify(value)) }
}
const bridge = new BridgeServer({ log: () => {} })
bridge.token = 'test-only'
const connect = (browser) => {
  const socket = new Socket()
  bridge._onConnection(socket)
  socket.receive({ type: 'hello', token: 'test-only', browser })
  return socket
}
try {
  const oldChrome = connect('chrome')
  const edge = connect('edge')
  const chrome = connect('chrome')
  const events = []
  bridge.on('Page.loadEventFired', (params, sid, kind) => events.push({ sid, kind }))
  const request = bridge.send('Runtime.evaluate', {}, 'chrome:1', 1000)
  const id = chrome.sent.at(-1).id
  let resolved = false
  request.then(() => { resolved = true })
  oldChrome.receive({ type: 'cdp', id, sessionId: 'chrome:1', result: 'stale' })
  edge.receive({ type: 'cdp', id, sessionId: 'chrome:1', result: 'wrong browser' })
  oldChrome.receive({ type: 'event', method: 'Page.loadEventFired', sessionId: 'chrome:1' })
  edge.receive({ type: 'event', method: 'Page.loadEventFired', sessionId: 'chrome:1' })
  await Promise.resolve()
  const ignoredInvalidReplies = !resolved
  chrome.receive({ type: 'cdp', id, sessionId: 'chrome:1', result: 'current' })
  assert.equal(await request, 'current', 'only the current Chrome connection can complete its request')
  assert.equal(ignoredInvalidReplies, true)
  assert.equal(events.length, 0, 'stale and cross-browser events must be ignored')
  chrome.receive({ type: 'event', method: 'Page.loadEventFired', sessionId: 'chrome:1' })
  assert.deepEqual(events, [{ sid: 'chrome:1', kind: 'chrome' }])
  assert.doesNotThrow(() => chrome.receive(null), 'valid JSON null must not crash the bridge')
  console.log('PASS: current connection owns replies/events; stale and cross-browser traffic ignored; null safely ignored')
} finally {
  await bridge.stop()
}
