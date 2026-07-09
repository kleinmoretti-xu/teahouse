import { createServer, createConnection, type Server, type Socket } from 'node:net'
import { createHash } from 'node:crypto'
import { createReadStream, createWriteStream, mkdirSync, renameSync, rmSync, statSync } from 'node:fs'
import { dirname, join, sep } from 'node:path'
import { resolve as pathResolve } from 'node:path'
import { EventEmitter } from 'node:events'
import type { DoneFrame, Envelope, PullFrame, PullOkFrame, TcpFrame } from '../../shared/protocol'
import { encodeFrame, FrameReader } from './frame'

// 文件传输数据面（protocol §8，拉取式）：
// 发送方被动开 TCP 服务，按 pull 帧供流（边读边算 SHA-256）；
// 接收方主动连接，逐文件 pull → 收裸流 → 校验 → .part 改名落盘。
// 零 Electron 依赖，vitest 直接回环测试。

export interface OutgoingFile {
  fileId: string
  absPath: string
  size: number
}

export interface OutgoingLookup {
  /** 仅 accepted 状态的传输可被拉取；返回 null 拒绝 */
  resolve(transferId: string, fileId: string): OutgoingFile | null
  /** 超长文本 TCP 控制帧入口；返回 true 表示已接收并应 ACK */
  receiveMessage?: (env: Envelope) => boolean
}

export type ReadStreamFactory = (
  path: string,
  options?: { start?: number }
) => ReturnType<typeof createReadStream>

export type WriteStreamFactory = (
  path: string,
  options?: { flags?: string }
) => ReturnType<typeof createWriteStream>

/** 发送侧 TCP 服务。事件：'progress'(transferId, bytesDelta)、'served'(transferId) */
export class TransferServer extends EventEmitter {
  private server: Server | null = null
  /** 活跃连接：stop 时强制销毁，避免 server.close 因残留 socket 挂起 */
  private readonly sockets = new Set<Socket>()

  constructor(
    private readonly port: number,
    private readonly lookup: OutgoingLookup,
    private readonly bindAddress?: string,
    private readonly openReadStream: ReadStreamFactory = createReadStream
  ) {
    super()
  }

  start(): Promise<void> {
    return new Promise((resolve, reject) => {
      const server = createServer((socket) => this.serve(socket))
      server.once('error', reject)
      server.listen(this.port, this.bindAddress, () => {
        server.removeListener('error', reject)
        server.on('error', () => undefined) // 运行期错误不致命
        this.server = server
        resolve()
      })
    })
  }

  stop(): Promise<void> {
    return new Promise((resolve) => {
      if (!this.server) return resolve()
      const server = this.server
      this.server = null
      for (const socket of this.sockets) {
        socket.destroy()
      }
      this.sockets.clear()
      let settled = false
      const done = (): void => {
        if (settled) return
        settled = true
        resolve()
      }
      server.close(() => done())
      // 残留半开连接时 close 可能迟迟不回调；强制收口避免测试 afterEach 挂死
      setTimeout(done, 1_000)
    })
  }

  private serve(socket: Socket): void {
    this.sockets.add(socket)
    socket.setNoDelay(true)
    let busy = false // 同一连接内文件串行（协议约定），防交叉 pull
    let activeStreams: Array<ReturnType<ReadStreamFactory>> = []
    /** 发送端写缓冲满时只挂一个 drain，避免重复 resume 与泄漏 listener */
    let waitingDrain = false

    const send = (frame: TcpFrame): void => {
      socket.write(encodeFrame(frame))
    }
    const trackStream = (
      stream: ReturnType<ReadStreamFactory>
    ): ReturnType<ReadStreamFactory> => {
      activeStreams.push(stream)
      stream.once('close', () => {
        activeStreams = activeStreams.filter((item) => item !== stream)
      })
      return stream
    }

    const reader = new FrameReader(
      (frame) => {
        if (frame.type === 'finish') {
          this.emit('served', frame.transferId)
          return
        }
        if (frame.type === 'msg') {
          const ok = this.lookup.receiveMessage?.(frame.envelope) ?? false
          if (ok) send({ type: 'msg-ack', ackFor: frame.envelope.id })
          else send({ type: 'err', reason: 'bad-msg' })
          return
        }
        if (frame.type !== 'pull' || busy) {
          if (frame.type === 'pull') send({ type: 'err', reason: 'busy' })
          return
        }
        const pull = frame as PullFrame
        const file = this.lookup.resolve(pull.transferId, pull.fileId)
        if (!file) {
          send({ type: 'err', reason: 'not-found' })
          return
        }
        const offset = Number.isInteger(pull.offset) && pull.offset >= 0 ? pull.offset : 0
        if (offset > file.size) {
          send({ type: 'err', reason: 'bad-offset' })
          return
        }
        busy = true
        const len = file.size - offset
        send({ type: 'pull-ok', fileId: file.fileId, len } satisfies PullOkFrame)

        const hash = createHash('sha256')
        const asBuffer = (chunk: Buffer | string): Buffer =>
          Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
        const sendDataChunk = (
          stream: ReturnType<ReadStreamFactory>,
          chunk: Buffer | string
        ): void => {
          const data = asBuffer(chunk)
          this.emit('progress', pull.transferId, data.length)
          if (!socket.write(data) && !waitingDrain) {
            waitingDrain = true
            stream.pause()
            socket.once('drain', () => {
              waitingDrain = false
              if (!socket.destroyed) stream.resume()
            })
          }
        }
        const finish = (sha256: string): void => {
          send({ type: 'done', fileId: file.fileId, sha256 } satisfies DoneFrame)
          busy = false
        }

        if (offset === 0) {
          // 首次拉取时同一条读流边发边算哈希；避免大文件先整盘预读导致 UI 长时间 0B。
          const dataStream = trackStream(this.openReadStream(file.absPath))
          dataStream.on('data', (chunk) => {
            hash.update(asBuffer(chunk))
            sendDataChunk(dataStream, chunk)
          })
          dataStream.on('error', () => socket.destroy())
          dataStream.on('end', () => finish(hash.digest('hex')))
          return
        }

        // 断点续传仍需整文件哈希；数据流先启动，哈希流完成后再发送 done。
        let dataEnded = len === 0
        let digest: string | null = null
        const finishResumeIfReady = (): void => {
          if (!dataEnded || digest === null) return
          finish(digest)
        }

        const hashStream = trackStream(this.openReadStream(file.absPath))
        hashStream.on('data', (chunk) => hash.update(chunk))
        hashStream.on('error', () => socket.destroy())
        hashStream.on('end', () => {
          digest = hash.digest('hex')
          finishResumeIfReady()
        })

        if (len === 0) {
          finishResumeIfReady()
          return
        }
        const dataStream = trackStream(this.openReadStream(file.absPath, { start: offset }))
        dataStream.on('data', (chunk) => sendDataChunk(dataStream, chunk))
        dataStream.on('error', () => socket.destroy())
        dataStream.on('end', () => {
          dataEnded = true
          finishResumeIfReady()
        })
      },
      () => socket.destroy(),
      () => socket.destroy()
    )

    socket.on('data', (chunk) => reader.feed(chunk))
    socket.on('error', () => undefined)
    socket.on('close', () => {
      this.sockets.delete(socket)
      for (const stream of activeStreams.splice(0)) stream.destroy()
      busy = false
    })
  }
}

export interface IncomingFilePlan {
  fileId: string
  /** 已 sanitize 的相对路径（'/' 分隔） */
  relPath: string
  size: number
  isDir?: boolean
}

export interface PullOptions {
  host: string
  port: number
  selfId: string
  transferId: string
  files: IncomingFilePlan[]
  saveDir: string
  onProgress: (bytesDelta: number) => void
  /** 由服务侧设置以支持取消：destroy 当前 socket */
  cancelRef: { canceled: boolean; socket: Socket | null }
  /** 测试注入：默认写入真实文件系统 */
  openWriteStream?: WriteStreamFactory
}

/** 接收侧：连接发送方逐文件拉取；保留 .part 时可从 offset 断点续传。 */
export function pullTransfer(opts: PullOptions): Promise<void> {
  return new Promise((resolvePromise, reject) => {
    const root = pathResolve(opts.saveDir)
    const socket = createConnection({ host: opts.host, port: opts.port })
    opts.cancelRef.socket = socket
    socket.setNoDelay(true)

    const queue = [...opts.files]
    let current: {
      plan: IncomingFilePlan
      partPath: string
      finalPath: string
      stream: ReturnType<WriteStreamFactory>
      hash: ReturnType<typeof createHash>
      left: number
    } | null = null
    let settled = false
    /** 写盘背压 pause 后，文件切换时 end() 可能吞掉 drain，须显式 resume */
    let socketPaused = false
    const removePart = (path: string): void => {
      try {
        rmSync(path, { force: true })
      } catch {
        // 清理失败不覆盖原始传输失败原因。
      }
    }
    const resumeSocket = (): void => {
      if (!socketPaused) return
      socketPaused = false
      if (!settled && !socket.destroyed) socket.resume()
    }

    const fail = (reason: string): void => {
      if (settled) return
      settled = true
      resumeSocket()
      if (current) {
        current.stream.destroy()
        if (
          reason === 'canceled' ||
          reason === 'hash-mismatch' ||
          reason === 'size-mismatch' ||
          reason === 'path-escape' ||
          reason === 'part-read-error'
        ) {
          removePart(current.partPath)
        }
      }
      socket.destroy()
      reject(new Error(reason))
    }

    const succeed = (): void => {
      if (settled) return
      settled = true
      resumeSocket()
      socket.end()
      resolvePromise()
    }

    const next = (): void => {
      if (opts.cancelRef.canceled) {
        fail('canceled')
        return
      }
      const plan = queue.shift()
      if (!plan) {
        socket.write(encodeFrame({ type: 'finish', transferId: opts.transferId }))
        succeed()
        return
      }
      const finalPath = join(root, ...plan.relPath.split('/'))
      if (!pathResolve(finalPath).startsWith(root + sep)) {
        fail('path-escape') // sanitize 之外的最后一道闸
        return
      }
      if (plan.isDir) {
        try {
          mkdirSync(finalPath, { recursive: true })
        } catch {
          fail('write-error')
          return
        }
        next()
        return
      }
      try {
        mkdirSync(dirname(finalPath), { recursive: true })
      } catch {
        fail('write-error')
        return
      }
      const partPath = `${finalPath}.part`
      let offset = 0
      try {
        offset = Math.min(statSync(partPath).size, plan.size)
      } catch {
        offset = 0
      }
      if (offset > 0) opts.onProgress(offset)
      const hash = createHash('sha256')
      const startPull = (): void => {
        current = {
          plan,
          partPath,
          finalPath,
          stream: (opts.openWriteStream ?? createWriteStream)(partPath, { flags: offset > 0 ? 'a' : 'w' }),
          hash,
          left: plan.size - offset
        }
        current.stream.on('error', () => fail('write-error'))
        socket.write(
          encodeFrame({
            type: 'pull',
            from: opts.selfId,
            transferId: opts.transferId,
            fileId: plan.fileId,
            offset
          })
        )
      }
      if (offset === 0) {
        startPull()
        return
      }
      const existing = createReadStream(partPath, { start: 0, end: offset - 1 })
      existing.on('data', (chunk) => hash.update(chunk))
      existing.on('error', () => {
        removePart(partPath)
        fail('part-read-error')
      })
      existing.on('end', startPull)
    }

    const reader = new FrameReader(
      (frame) => {
        if (frame.type === 'err') {
          fail(`peer:${frame.reason}`)
          return
        }
        if (frame.type === 'pull-ok' && current) {
          if (frame.len !== current.left) {
            fail('size-mismatch')
            return
          }
          if (frame.len > 0) reader.expectRaw(frame.len)
          return
        }
        if (frame.type === 'done' && current) {
          const item = current
          current = null
          // Node Writable 在 end/finish 路径上可能不再 emit drain；
          // 若上一文件写盘背压 pause 了 socket，不 resume 则下一文件 pull-ok 永远读不到（死锁）。
          resumeSocket()
          item.stream.end(() => {
            const got = item.hash.digest('hex')
            if (got !== frame.sha256) {
              removePart(item.partPath)
              fail('hash-mismatch')
              return
            }
            // 重名避让（F-FILE-3 不覆盖）：根级避让在服务层，此处兜底逐文件避让
            try {
              renameSync(item.partPath, dedupeTargetPath(item.finalPath))
            } catch {
              removePart(item.partPath)
              fail('write-error')
              return
            }
            next()
          })
        }
      },
      (chunk) => {
        if (!current) return
        current.hash.update(chunk)
        current.left -= chunk.length
        if (!current.stream.write(chunk) && !socketPaused) {
          socketPaused = true
          socket.pause()
          current.stream.once('drain', () => resumeSocket())
        }
        opts.onProgress(chunk.length)
      },
      (reason) => fail(reason)
    )

    socket.on('data', (chunk) => reader.feed(chunk))
    socket.on('error', () => fail('socket-error'))
    socket.on('close', () => fail('closed'))
    socket.on('connect', () => next())
  })
}

/** 发送前对落盘目标做重名避让：name.ext → name(1).ext（F-FILE-3 不覆盖） */
export function dedupeTargetPath(path: string): string {
  try {
    statSync(path)
  } catch {
    return path // 不存在，直接用
  }
  const dir = dirname(path)
  const base = path.slice(dir.length + 1)
  const dot = base.lastIndexOf('.')
  const stem = dot > 0 ? base.slice(0, dot) : base
  const ext = dot > 0 ? base.slice(dot) : ''
  for (let i = 1; i < 1000; i++) {
    const candidate = join(dir, `${stem}(${i})${ext}`)
    try {
      statSync(candidate)
    } catch {
      return candidate
    }
  }
  return join(dir, `${stem}(${Date.now()})${ext}`)
}
