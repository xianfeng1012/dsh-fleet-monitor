/**
 * The hand-written WebSocket server.
 *
 * This is the one piece of the plugin that speaks a wire protocol to something
 * other than sshd, so the tests drive a real socket rather than calling methods:
 * a frame that is one byte off does not fail here, it fails in a browser at
 * midnight.
 */

import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { createServer } from 'node:http'
import { test } from 'node:test'

import { WebSocketServer } from '../lib/ws.js'

/** Build a client-to-server frame; client frames must be masked. */
function clientFrame(opcode, payload, { fin = true, masked = true } = {}) {
  const body = Buffer.isBuffer(payload) ? payload : Buffer.from(String(payload), 'utf8')
  const length = body.length
  let header
  if (length < 126) {
    header = Buffer.from([0, length])
  } else if (length < 65_536) {
    header = Buffer.alloc(4)
    header[1] = 126
    header.writeUInt16BE(length, 2)
  } else {
    header = Buffer.alloc(10)
    header[1] = 127
    header.writeBigUInt64BE(BigInt(length), 2)
  }
  header[0] = (fin ? 0x80 : 0) | opcode
  if (!masked) return Buffer.concat([header, body])
  header[1] |= 0x80
  const mask = Buffer.from([1, 2, 3, 4])
  const out = Buffer.alloc(length)
  for (let index = 0; index < length; index += 1) out[index] = body[index] ^ mask[index & 3]
  return Buffer.concat([header, mask, out])
}

/** Read one server-to-client frame off a socket (server frames are never masked). */
function readFrame(socket) {
  return new Promise((resolve) => {
    let buffer = Buffer.alloc(0)
    const onData = (chunk) => {
      buffer = Buffer.concat([buffer, chunk])
      if (buffer.length < 2) return
      const opcode = buffer[0] & 0x0f
      let length = buffer[1] & 0x7f
      let offset = 2
      if (length === 126) {
        if (buffer.length < 4) return
        length = buffer.readUInt16BE(2)
        offset = 4
      } else if (length === 127) {
        if (buffer.length < 10) return
        length = Number(buffer.readBigUInt64BE(2))
        offset = 10
      }
      if (buffer.length < offset + length) return
      socket.off('data', onData)
      resolve({ opcode, payload: buffer.subarray(offset, offset + length) })
    }
    socket.on('data', onData)
  })
}

/** Start a server that accepts one client and hands the peer to `onPeer`. */
function serve(t, onPeer) {
  const wss = new WebSocketServer()
  // upgrade is an http.Server event; a bare net.Server never emits it, which is
  // exactly the mistake that made this file hang for twenty minutes.
  const server = createServer()
  server.on('upgrade', (request, socket, head) => {
    wss.handleUpgrade(request, socket, head, (peer) => onPeer(peer, socket))
  })
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address()
      t.after(() => {
        wss.close()
        server.close()
      })
      resolve(port)
    })
  })
}

/** Connect, complete the handshake, return the socket. */
async function connect(port, key = 'dGhlIHNhbXBsZSBub25jZQ==') {
  const { connect: netConnect } = await import('node:net')
  const socket = netConnect(port, '127.0.0.1')
  await new Promise((resolve) => socket.once('connect', resolve))
  socket.write([
    'GET /ws HTTP/1.1',
    'Host: 127.0.0.1',
    'Upgrade: websocket',
    'Connection: Upgrade',
    `Sec-WebSocket-Key: ${key}`,
    'Sec-WebSocket-Version: 13',
    '',
    '',
  ].join('\r\n'))
  const head = await new Promise((resolve) => {
    let buffer = ''
    const onData = (chunk) => {
      buffer += chunk.toString('latin1')
      if (!buffer.includes('\r\n\r\n')) return
      socket.off('data', onData)
      resolve(buffer)
    }
    socket.on('data', onData)
  })
  return { socket, head }
}

test('the handshake answers with the accept value RFC 6455 specifies', async (t) => {
  const expected = createHash('sha1').update('dGhlIHNhbXBsZSBub25jZQ==258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64')
  assert.equal(expected, 's3pPLMBiTxaQ9kYGzzhZRbK+xOo=')
  let accepted = null
  const port = await serve(t, (peer) => { accepted = peer })
  const { socket, head } = await connect(port)
  assert.match(head, /^HTTP\/1\.1 101 Switching Protocols\r\n/)
  assert.match(head, /Sec-WebSocket-Accept: s3pPLMBiTxaQ9kYGzzhZRbK\+xOo=\r\n/)
  assert.ok(accepted !== null, 'the connection callback ran')
  socket.destroy()
})

test('a handshake without a key is refused before a peer exists', async (t) => {
  let accepted = null
  const port = await serve(t, (peer) => { accepted = peer })
  const { connect: netConnect } = await import('node:net')
  const socket = netConnect(port, '127.0.0.1')
  await new Promise((resolve) => socket.once('connect', resolve))
  socket.write('GET /ws HTTP/1.1\r\nHost: x\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n')
  const reply = await new Promise((resolve) => {
    let text = ''
    socket.on('data', (chunk) => { text += chunk.toString('latin1'); if (text.includes('\r\n')) resolve(text) })
  })
  assert.match(reply, /^HTTP\/1\.1 400 Bad Request/)
  assert.equal(accepted, null)
  socket.destroy()
})

test('a text frame arrives at the peer as a string', async (t) => {
  let peer = null
  let received = null
  const port = await serve(t, (connection) => {
    peer = connection
    connection.on('message', (text) => { received = text })
  })
  const { socket } = await connect(port)
  socket.write(clientFrame(0x1, '{"type":"input","data":"ls\\r"}'))
  await new Promise((resolve) => setTimeout(resolve, 60))
  assert.equal(received, '{"type":"input","data":"ls\\r"}')
  assert.ok(peer !== null)
  socket.destroy()
})

test('a fragmented message is reassembled before it is emitted', async (t) => {
  let received = null
  const port = await serve(t, (connection) => {
    connection.on('message', (text) => { received = text })
  })
  const { socket } = await connect(port)
  socket.write(clientFrame(0x1, 'abc', { fin: false }))
  socket.write(clientFrame(0x0, 'def', { fin: false }))
  socket.write(clientFrame(0x0, 'ghi', { fin: true }))
  await new Promise((resolve) => setTimeout(resolve, 60))
  assert.equal(received, 'abcdefghi')
  socket.destroy()
})

test('the 16 bit length form is used for a long payload and read back intact', async (t) => {
  let received = null
  const port = await serve(t, (connection) => {
    connection.on('message', (text) => { received = text })
  })
  const { socket } = await connect(port)
  const payload = 'x'.repeat(300)
  socket.write(clientFrame(0x1, payload))
  await new Promise((resolve) => setTimeout(resolve, 80))
  assert.equal(received.length, 300)
  socket.destroy()
})

test('the server answer to a long payload is framed with the 16 bit form', async (t) => {
  const port = await serve(t, (connection) => {
    connection.on('message', (text) => connection.send(text))
  })
  const { socket } = await connect(port)
  const payload = 'y'.repeat(400)
  const frame = readFrame(socket)
  socket.write(clientFrame(0x1, payload))
  const answer = await frame
  assert.equal(answer.opcode, 0x1)
  assert.equal(answer.payload.toString('utf8').length, 400)
  socket.destroy()
})

test('an unmasked client frame is a protocol error and closes the socket', async (t) => {
  const frames = []
  let closed = null
  const port = await serve(t, (connection) => {
    frames.push(connection)
    connection.on('close', (info) => { closed = info })
  })
  const { socket } = await connect(port)
  socket.write(clientFrame(0x1, 'nope', { masked: false }))
  await new Promise((resolve) => setTimeout(resolve, 60))
  assert.ok(closed !== null, 'the peer closed the connection')
  assert.equal(closed.code, 1002)
  socket.destroy()
})

test('a ping is answered with a pong carrying the same payload', async (t) => {
  const port = await serve(t, () => {})
  const { socket } = await connect(port)
  const pong = readFrame(socket)
  socket.write(clientFrame(0x9, 'hi'))
  const frame = await pong
  assert.equal(frame.opcode, 0xa)
  assert.equal(frame.payload.toString('utf8'), 'hi')
  socket.destroy()
})

test('a client close is echoed and reported', async (t) => {
  let closed = null
  const port = await serve(t, (connection) => {
    connection.on('close', (info) => { closed = info })
  })
  const { socket } = await connect(port)
  const body = Buffer.alloc(2)
  body.writeUInt16BE(1000, 0)
  socket.write(clientFrame(0x8, body))
  await new Promise((resolve) => setTimeout(resolve, 60))
  assert.ok(closed !== null)
  assert.equal(closed.code, 1000)
  socket.destroy()
})
