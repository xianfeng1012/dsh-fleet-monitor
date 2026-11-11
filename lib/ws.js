/**
 * A WebSocket server covering the subset this plugin actually speaks.
 *
 * `ws` is not a dependency here, and cannot be resolved from this package's real
 * path anyway: Node walks up from the realpath of the importing file, and this
 * plugin lives outside the profile's node_modules. Importing it during `apply`
 * would throw, and a throw during apply tears down every effect registered so
 * far — routes included, which is exactly the failure this plugin already spent
 * an evening recovering from.
 *
 * So: RFC 6455 handshake, the three length forms, client masking, fragmented
 * messages, ping/pong and close. No extensions, no permessage-deflate, no
 * subprotocols. That is all a JSON-frame terminal bridge needs.
 */

import { createHash, randomUUID } from 'node:crypto'
import { EventEmitter } from 'node:events'

const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11'
const OP_TEXT = 0x1
const OP_BINARY = 0x2
const OP_CLOSE = 0x8
const OP_PING = 0x9
const OP_PONG = 0xa
/** A frame bigger than this is refused rather than buffered. */
const MAX_FRAME_BYTES = 4 * 1024 * 1024

function acceptKey(key) {
  return createHash('sha1').update(key + GUID).digest('base64')
}

/**
 * One connected peer.
 *
 * Emits `message` with a string, `close` with `{code, reason}`, and `error`.
 */
export class WebSocket extends EventEmitter {
  constructor(socket, head) {
    super()
    this.socket = socket
    this.id = randomUUID()
    this.closed = false
    this.buffer = head !== undefined && head.length > 0 ? Buffer.from(head) : Buffer.alloc(0)
    this.fragments = []
    this.fragmentOp = 0

    socket.on('data', (chunk) => this.consume(chunk))
    socket.on('close', () => this.finish(1006, 'connection closed'))
    socket.on('error', (error) => {
      this.emit('error', error)
      this.finish(1006, error.message)
    })
    if (this.buffer.length > 0) {
      const pending = this.buffer
      this.buffer = Buffer.alloc(0)
      queueMicrotask(() => this.consume(pending))
    }
  }

  /** Send one text frame. */
  send(text) {
    if (this.closed) return
    this.writeFrame(OP_TEXT, Buffer.from(String(text), 'utf8'))
  }

  /** Send a close frame, then end the socket. */
  close(code = 1000, reason = '') {
    if (this.closed) return
    const payload = Buffer.alloc(2 + Buffer.byteLength(reason))
    payload.writeUInt16BE(code, 0)
    payload.write(reason, 2, 'utf8')
    this.writeFrame(OP_CLOSE, payload)
    this.finish(code, reason)
    try { this.socket.end() } catch {}
  }

  writeFrame(opcode, payload) {
    if (this.closed) return
    const length = payload.length
    let header
    if (length < 126) {
      header = Buffer.alloc(2)
      header[1] = length
    } else if (length < 65_536) {
      header = Buffer.alloc(4)
      header[1] = 126
      header.writeUInt16BE(length, 2)
    } else {
      header = Buffer.alloc(10)
      header[1] = 127
      header.writeBigUInt64BE(BigInt(length), 2)
    }
    header[0] = 0x80 | opcode
    try {
      this.socket.write(Buffer.concat([header, payload]))
    } catch (error) {
      this.finish(1006, error instanceof Error ? error.message : 'write failed')
    }
  }

  consume(chunk) {
    this.buffer = this.buffer.length === 0 ? chunk : Buffer.concat([this.buffer, chunk])
    while (!this.closed) {
      const frame = this.readFrame()
      if (frame === null) return
      this.handleFrame(frame)
    }
  }

  /** @returns `{fin, opcode, payload}` or null when the buffer holds a partial frame. */
  readFrame() {
    const buffer = this.buffer
    if (buffer.length < 2) return null
    const fin = (buffer[0] & 0x80) !== 0
    const opcode = buffer[0] & 0x0f
    const masked = (buffer[1] & 0x80) !== 0
    let length = buffer[1] & 0x7f
    let offset = 2
    if (length === 126) {
      if (buffer.length < offset + 2) return null
      length = buffer.readUInt16BE(offset)
      offset += 2
    } else if (length === 127) {
      if (buffer.length < offset + 8) return null
      const big = buffer.readBigUInt64BE(offset)
      if (big > BigInt(MAX_FRAME_BYTES)) {
        this.close(1009, 'frame too large')
        return null
      }
      length = Number(big)
      offset += 8
    }
    if (length > MAX_FRAME_BYTES) {
      this.close(1009, 'frame too large')
      return null
    }
    // A client frame must be masked; an unmasked one is a protocol error.
    if (!masked) {
      this.close(1002, 'client frames must be masked')
      return null
    }
    if (buffer.length < offset + 4 + length) return null
    const mask = buffer.subarray(offset, offset + 4)
    offset += 4
    const payload = Buffer.alloc(length)
    for (let index = 0; index < length; index += 1) {
      payload[index] = buffer[offset + index] ^ mask[index & 3]
    }
    this.buffer = buffer.subarray(offset + length)
    return { fin, opcode, payload }
  }

  handleFrame({ fin, opcode, payload }) {
    if (opcode === OP_CLOSE) {
      const code = payload.length >= 2 ? payload.readUInt16BE(0) : 1005
      const reason = payload.length > 2 ? payload.subarray(2).toString('utf8') : ''
      this.writeFrame(OP_CLOSE, payload.subarray(0, 2))
      this.finish(code, reason)
      try { this.socket.end() } catch {}
      return
    }
    if (opcode === OP_PING) {
      this.writeFrame(OP_PONG, payload)
      return
    }
    if (opcode === OP_PONG) return

    if (opcode === OP_TEXT || opcode === OP_BINARY) {
      this.fragmentOp = opcode
      this.fragments = [payload]
    } else if (opcode === 0x0) {
      if (this.fragmentOp === 0) {
        this.close(1002, 'continuation without a start frame')
        return
      }
      this.fragments.push(payload)
    } else {
      this.close(1002, `unknown opcode ${opcode}`)
      return
    }

    if (!fin) return
    const complete = Buffer.concat(this.fragments)
    this.fragments = []
    const op = this.fragmentOp
    this.fragmentOp = 0
    this.emit('message', op === OP_TEXT ? complete.toString('utf8') : complete)
  }

  finish(code, reason) {
    if (this.closed) return
    this.closed = true
    this.buffer = Buffer.alloc(0)
    this.emit('close', { code, reason })
  }
}

/**
 * Accepts upgrades for one path.
 *
 * The host's upgrade registry does no loopback or Origin checking, so the caller
 * must fence the request before calling `handleUpgrade` — a browser tab on any
 * site can open a WebSocket to 127.0.0.1 without a preflight.
 */
export class WebSocketServer {
  constructor() {
    this.path = null
  }

  handleUpgrade(request, socket, head, onConnection) {
    const key = request.headers['sec-websocket-key']
    const version = request.headers['sec-websocket-version']
    if (typeof key !== 'string' || key === '' || String(version) !== '13') {
      socket.write('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n')
      socket.end()
      return
    }
    socket.write([
      'HTTP/1.1 101 Switching Protocols',
      'Upgrade: websocket',
      'Connection: Upgrade',
      `Sec-WebSocket-Accept: ${acceptKey(key)}`,
      '',
      '',
    ].join('\r\n'))
    socket.setNoDelay?.(true)
    const peer = new WebSocket(socket, head)
    onConnection(peer)
  }

  close() {
    this.path = null
  }
}
