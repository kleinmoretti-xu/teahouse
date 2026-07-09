import { afterEach, describe, expect, it } from 'vitest'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { randomBytes } from 'node:crypto'
import { createConnection } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import {
  TransferServer,
  dedupeTargetPath,
  pullTransfer,
  type IncomingFilePlan,
  type OutgoingFile,
  type ReadStreamFactory
} from './transfer'
import { encodeFrame, FrameReader } from './frame'

// 数据面回环测试：真实文件、真实 TCP（127.0.0.1）、真实 SHA-256。
// 控制面（offer/accept）的可靠投递已由 messenger.test 覆盖。

const tmpDirs: string[] = []
const servers: TransferServer[] = []

async function removeTmpWithRetry(dir: string): Promise<void> {
  let lastErr: unknown
  for (let i = 0; i < 5; i++) {
    try {
      rmSync(dir, { recursive: true, force: true })
      return
    } catch (err) {
      lastErr = err
      await new Promise((resolve) => setTimeout(resolve, 25 * (i + 1)))
    }
  }
  throw lastErr
}

function makeTmp(): string {
  const dir = mkdtempSync(join(tmpdir(), 'pantry-transfer-'))
  tmpDirs.push(dir)
  return dir
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

async function waitFor(predicate: () => boolean, timeoutMs = 500): Promise<void> {
  const start = Date.now()
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) throw new Error('timeout')
    await delay(10)
  }
}

class SlowReadable extends Readable {
  private sent = 0
  private timer: ReturnType<typeof setTimeout> | null = null

  constructor(
    private readonly chunk: Buffer,
    private readonly maxChunks: number
  ) {
    super()
  }

  _read(): void {
    if (this.timer || this.destroyed) return
    this.timer = setTimeout(() => {
      this.timer = null
      if (this.destroyed) return
      if (this.sent >= this.maxChunks) {
        this.push(null)
        return
      }
      this.sent += 1
      this.push(this.chunk)
    }, 10)
  }

  _destroy(error: Error | null, callback: (error?: Error | null) => void): void {
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
    callback(error)
  }
}

afterEach(async () => {
  for (const server of servers.splice(0)) await server.stop()
  for (const dir of tmpDirs.splice(0)) await removeTmpWithRetry(dir)
})

let nextPort = 45000 + Math.floor(Math.random() * 1000)

async function startServer(
  files: Map<string, Map<string, OutgoingFile>>,
  openReadStream?: ReadStreamFactory
): Promise<number> {
  nextPort += 1
  const server = new TransferServer(
    nextPort,
    {
      resolve: (transferId, fileId) => files.get(transferId)?.get(fileId) ?? null
    },
    '127.0.0.1',
    openReadStream
  )
  await server.start()
  servers.push(server)
  return nextPort
}

describe('transfer 数据面回环', () => {
  it('文件夹结构 + 大文件 + 空文件：逐文件拉取、哈希校验、结构还原', async () => {
    const src = makeTmp()
    const dst = makeTmp()
    const big = randomBytes(600 * 1024) // 600KB，跨多个 TCP chunk
    mkdirSync(join(src, 'docs'))
    writeFileSync(join(src, 'big.bin'), big)
    writeFileSync(join(src, 'docs', '说明.txt'), '你好，茶话间')
    writeFileSync(join(src, 'empty.dat'), '')

    const outgoing = new Map<string, OutgoingFile>([
      ['f1', { fileId: 'f1', absPath: join(src, 'big.bin'), size: big.length }],
      ['f2', { fileId: 'f2', absPath: join(src, 'docs', '说明.txt'), size: Buffer.byteLength('你好，茶话间') }],
      ['f3', { fileId: 'f3', absPath: join(src, 'empty.dat'), size: 0 }]
    ])
    const port = await startServer(new Map([['t1', outgoing]]))

    const plans: IncomingFilePlan[] = [
      { fileId: 'f1', relPath: '工程/big.bin', size: big.length },
      { fileId: 'f2', relPath: '工程/docs/说明.txt', size: Buffer.byteLength('你好，茶话间') },
      { fileId: 'f3', relPath: '工程/empty.dat', size: 0 }
    ]
    let bytes = 0
    await pullTransfer({
      host: '127.0.0.1',
      port,
      selfId: 'node-receiver',
      transferId: 't1',
      files: plans,
      saveDir: dst,
      cancelRef: { canceled: false, socket: null },
      onProgress: (d) => {
        bytes += d
      }
    })

    expect(readFileSync(join(dst, '工程', 'big.bin')).equals(big)).toBe(true)
    expect(readFileSync(join(dst, '工程', 'docs', '说明.txt'), 'utf8')).toBe('你好，茶话间')
    expect(readFileSync(join(dst, '工程', 'empty.dat')).length).toBe(0)
    expect(bytes).toBe(big.length + Buffer.byteLength('你好，茶话间'))
  })

  it('首次拉取时同一读流边发送边计算哈希，避免大文件接受后长时间 0B', async () => {
    const dst = makeTmp()
    const body = Buffer.alloc(4096, 0x5a)
    const readCalls: Array<{ start?: number }> = []
    const openReadStream: ReadStreamFactory = (_path, options) => {
      readCalls.push({ start: options?.start })
      return Readable.from([body]) as ReturnType<ReadStreamFactory>
    }
    const outgoing = new Map<string, OutgoingFile>([
      ['f1', { fileId: 'f1', absPath: 'virtual.bin', size: body.length }]
    ])
    const port = await startServer(new Map([['t-streaming', outgoing]]), openReadStream)

    await pullTransfer({
      host: '127.0.0.1',
      port,
      selfId: 'node-receiver',
      transferId: 't-streaming',
      files: [{ fileId: 'f1', relPath: 'virtual.bin', size: body.length }],
      saveDir: dst,
      cancelRef: { canceled: false, socket: null },
      onProgress: () => undefined
    })

    expect(readFileSync(join(dst, 'virtual.bin')).equals(body)).toBe(true)
    expect(readCalls).toEqual([{ start: undefined }])
  })

  it('接收方中断连接时销毁发送端正在读取的文件流', async () => {
    const opened: SlowReadable[] = []
    const openReadStream: ReadStreamFactory = () => {
      const stream = new SlowReadable(Buffer.alloc(64 * 1024, 0x61), 1_000)
      opened.push(stream)
      return stream as unknown as ReturnType<ReadStreamFactory>
    }
    const outgoing = new Map<string, OutgoingFile>([
      ['f1', { fileId: 'f1', absPath: 'virtual-large.bin', size: 64 * 1024 * 1_000 }]
    ])
    const port = await startServer(new Map([['t-close', outgoing]]), openReadStream)
    const socket = createConnection({ host: '127.0.0.1', port })
    const reader = new FrameReader(
      () => undefined,
      () => undefined,
      () => undefined
    )

    try {
      await new Promise<void>((resolve, reject) => {
        socket.once('connect', resolve)
        socket.once('error', reject)
      })
      socket.on('data', (chunk) => reader.feed(chunk))
      socket.write(
        encodeFrame({
          type: 'pull',
          from: 'node-receiver',
          transferId: 't-close',
          fileId: 'f1',
          offset: 0
        })
      )
      await waitFor(() => opened.length > 0)
      socket.destroy()
      await delay(50)

      expect(opened.every((stream) => stream.destroyed)).toBe(true)
    } finally {
      socket.destroy()
      for (const stream of opened) stream.destroy()
    }
  })

  it('未被授权的传输拒绝供流（accepted 才可拉取的最小闸门）', async () => {
    const dst = makeTmp()
    const port = await startServer(new Map()) // 服务器不认识任何传输

    await expect(
      pullTransfer({
        host: '127.0.0.1',
        port,
        selfId: 'node-x',
        transferId: 'unknown',
        files: [{ fileId: 'f', relPath: 'x.bin', size: 10 }],
        saveDir: dst,
        cancelRef: { canceled: false, socket: null },
        onProgress: () => undefined
      })
    ).rejects.toThrow(/peer:not-found/)
  })

  it('保存路径中间段被文件占用时返回 write-error 且进程存活', async () => {
    const src = makeTmp()
    const dst = makeTmp()
    writeFileSync(join(src, 'payload.bin'), 'payload')
    writeFileSync(join(dst, 'x'), 'not-a-dir')
    const outgoing = new Map<string, OutgoingFile>([
      ['f1', { fileId: 'f1', absPath: join(src, 'payload.bin'), size: Buffer.byteLength('payload') }]
    ])
    const port = await startServer(new Map([['t-write-error', outgoing]]))

    await expect(
      Promise.race([
        pullTransfer({
          host: '127.0.0.1',
          port,
          selfId: 'node-receiver',
          transferId: 't-write-error',
          files: [{ fileId: 'f1', relPath: 'x/y.bin', size: Buffer.byteLength('payload') }],
          saveDir: dst,
          cancelRef: { canceled: false, socket: null },
          onProgress: () => undefined
        }),
        new Promise((_resolve, reject) => setTimeout(() => reject(new Error('timeout')), 500))
      ])
    ).rejects.toThrow(/write-error/)
  })

  it('已有 .part 时从断点续传并校验整文件哈希', async () => {
    const src = makeTmp()
    const dst = makeTmp()
    const body = randomBytes(256 * 1024)
    const half = Math.floor(body.length / 2)
    writeFileSync(join(src, 'resume.bin'), body)
    writeFileSync(join(dst, 'resume.bin.part'), body.subarray(0, half))
    const outgoing = new Map<string, OutgoingFile>([
      ['f1', { fileId: 'f1', absPath: join(src, 'resume.bin'), size: body.length }]
    ])
    const port = await startServer(new Map([['t-resume', outgoing]]))
    let bytes = 0
    await pullTransfer({
      host: '127.0.0.1',
      port,
      selfId: 'node-receiver',
      transferId: 't-resume',
      files: [{ fileId: 'f1', relPath: 'resume.bin', size: body.length }],
      saveDir: dst,
      cancelRef: { canceled: false, socket: null },
      onProgress: (d) => {
        bytes += d
      }
    })

    expect(readFileSync(join(dst, 'resume.bin')).equals(body)).toBe(true)
    expect(bytes).toBe(body.length)
  })

  it('重名避让：name.ext → name(1).ext', () => {
    const dir = makeTmp()
    writeFileSync(join(dir, 'a.txt'), '1')
    expect(dedupeTargetPath(join(dir, 'a.txt'))).toBe(join(dir, 'a(1).txt'))
    expect(dedupeTargetPath(join(dir, 'b.txt'))).toBe(join(dir, 'b.txt'))
  })
})
