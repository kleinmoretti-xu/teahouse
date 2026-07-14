import { EventEmitter } from 'node:events'
import { mkdtempSync, rmSync, truncateSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  CAPS,
  MSG_TYPES,
  type Envelope,
  type FileCtlPayload,
  type GroupMeta
} from '../../shared/protocol'
import type { ConversationView } from '../../shared/ipc'
import type { Messenger } from '../net/messenger'
import type { PeerRegistry } from '../net/peer-registry'
import type { ConvRepo } from '../store/conv-repo'
import type { GroupRepo } from '../store/group-repo'
import type { MsgRepo, MsgRow, NewMessage } from '../store/msg-repo'
import type { TransferRepo, TransferRow } from '../store/transfer-repo'
import { FilesService } from './files'
import { makeEnvelope } from '../net/codec'

const tmpDirs: string[] = []

afterEach(() => {
  for (const dir of tmpDirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

class FakeMessenger extends EventEmitter {
  sent: Array<{ peerId: string; env: Envelope<FileCtlPayload> }> = []

  async sendReliable(peerId: string, env: Envelope<FileCtlPayload>): Promise<boolean> {
    this.sent.push({ peerId, env })
    return true
  }
}

class FakeRegistry {
  constructor(
    private readonly onlineIds: string[],
    private readonly caps: string[] | Record<string, string[]> = [],
    private readonly tcpPort = 17879
  ) {}

  get(nodeId: string): unknown {
    if (!this.onlineIds.includes(nodeId)) return undefined
    const caps = Array.isArray(this.caps) ? this.caps : (this.caps[nodeId] ?? [])
    return {
      online: true,
      ip: '127.0.0.1',
      udpPort: 17878,
      profile: { tcpPort: this.tcpPort, caps, nick: nodeId }
    }
  }
}

class FakeConvRepo {
  bumped: Array<{ convId: string; ts: number }> = []

  ensureSingle(peerId: string): string {
    return `single:${peerId}`
  }

  ensureGroup(groupId: string): string {
    return `group:${groupId}`
  }

  bump(convId: string, ts: number): void {
    this.bumped.push({ convId, ts })
  }

  incUnread(): void {
    // no-op
  }

  list(): ConversationView[] {
    return []
  }
}

class FakeMsgRepo {
  rows = new Map<string, MsgRow>()

  insert(msg: NewMessage): boolean {
    this.rows.set(msg.id, {
      id: msg.id,
      conv_id: msg.convId,
      sender_id: msg.senderId,
      is_mine: msg.isMine ? 1 : 0,
      kind: msg.kind,
      content: msg.content,
      file_ref: msg.fileRef ?? null,
      ts: msg.ts,
      seq: this.rows.size + 1,
      status: msg.status
    })
    return true
  }

  get(msgId: string): MsgRow | undefined {
    return this.rows.get(msgId)
  }

  updateStatus(msgId: string, status: string): void {
    const row = this.rows.get(msgId)
    if (row) row.status = status
  }
}

class FakeTransferRepo {
  rows = new Map<string, TransferRow>()

  resetActive(): number {
    return 0
  }

  insert(row: {
    transferId: string
    msgId: string
    peerId: string
    direction: 'in' | 'out'
    files: string
    status: string
    total: number
    ts: number
  }): void {
    this.rows.set(row.transferId, {
      transfer_id: row.transferId,
      msg_id: row.msgId,
      peer_id: row.peerId,
      direction: row.direction,
      files: row.files,
      status: row.status,
      bytes_done: 0,
      total: row.total,
      ts: row.ts
    })
  }

  updateStatus(transferId: string, status: string): void {
    const row = this.rows.get(transferId)
    if (row) row.status = status
  }

  updateProgress(): void {
    // no-op
  }

  updateFiles(transferId: string, filesJson: string): void {
    const row = this.rows.get(transferId)
    if (row) row.files = filesJson
  }

  get(transferId: string): TransferRow | undefined {
    return this.rows.get(transferId)
  }

  list(): TransferRow[] {
    return [...this.rows.values()]
  }
}

class FakeGroupRepo {
  constructor(private readonly meta: GroupMeta) {}

  get(groupId: string): GroupMeta | undefined {
    return groupId === this.meta.groupId ? this.meta : undefined
  }
}

function waitTick(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0))
}

describe('FilesService 群聊媒体', () => {
  it('同一同步批次内合并会话列表事件', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'pantry-convs-batch-'))
    tmpDirs.push(dir)
    const firstPath = join(dir, '第一份.txt')
    const secondPath = join(dir, '第二份.txt')
    writeFileSync(firstPath, 'one')
    writeFileSync(secondPath, 'two')

    const service = new FilesService({
      selfId: 'node-self',
      messenger: new FakeMessenger() as unknown as Messenger,
      registry: new FakeRegistry(['node-bob']) as unknown as PeerRegistry,
      convRepo: new FakeConvRepo() as unknown as ConvRepo,
      msgRepo: new FakeMsgRepo() as unknown as MsgRepo,
      transferRepo: new FakeTransferRepo() as unknown as TransferRepo,
      groupRepo: undefined,
      tcpPort: 0,
      getSaveDir: () => dir,
      getImagesDir: () => dir,
      bindAddress: '127.0.0.1'
    })
    const events: ConversationView[][] = []
    service.on('convs', (convs: ConversationView[]) => events.push(convs))

    const first = service.offerPaths('node-bob', [firstPath])
    const second = service.offerPaths('node-bob', [secondPath])

    expect(events).toHaveLength(0)
    await Promise.resolve()
    expect(events).toHaveLength(1)
    await Promise.all([first, second])
  })

  it('发送更新包 offer 不进入聊天与普通传输视图', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'pantry-update-send-'))
    tmpDirs.push(dir)
    const pkgPath = join(dir, 'Teahouse-0.28.0-linux-amd64.deb')
    writeFileSync(pkgPath, 'deb')

    const messenger = new FakeMessenger()
    const msgRepo = new FakeMsgRepo()
    const transferRepo = new FakeTransferRepo()
    const convRepo = new FakeConvRepo()
    const svc = new FilesService({
      selfId: 'node-self',
      messenger: messenger as unknown as Messenger,
      registry: new FakeRegistry(['node-bob']) as unknown as PeerRegistry,
      convRepo: convRepo as unknown as ConvRepo,
      msgRepo: msgRepo as unknown as MsgRepo,
      transferRepo: transferRepo as unknown as TransferRepo,
      groupRepo: undefined,
      tcpPort: 0,
      getSaveDir: () => dir,
      getImagesDir: () => dir,
      getUpdateDir: () => dir,
      bindAddress: '127.0.0.1'
    })

    await expect(svc.offerUpdatePackage('node-bob', pkgPath)).resolves.toBe(true)

    expect(msgRepo.rows.size).toBe(0)
    expect(convRepo.bumped).toHaveLength(0)
    expect(transferRepo.rows.size).toBe(1)
    const row = [...transferRepo.rows.values()][0]
    expect(row.direction).toBe('out')
    expect(row.msg_id).toMatch(/^update:/)
    expect(row.status).toBe('offering')
    expect(JSON.parse(row.files)).toMatchObject({
      name: 'Teahouse-0.28.0-linux-amd64.deb',
      savedPath: pkgPath,
      purpose: 'update'
    })
    expect(svc.transferView(row.transfer_id)).toBeNull()
    expect(messenger.sent[0]).toMatchObject({
      peerId: 'node-bob',
      env: {
        type: MSG_TYPES.fileCtl,
        payload: {
          op: 'offer',
          rootName: 'Teahouse-0.28.0-linux-amd64.deb',
          purpose: 'update'
        }
      }
    })
  })

  it('更新包 offer 不进入聊天与接收目录，并尝试自动 accept', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'pantry-files-service-'))
    const updateDir = mkdtempSync(join(tmpdir(), 'pantry-update-service-'))
    tmpDirs.push(dir, updateDir)

    const messenger = new FakeMessenger()
    const baseSend = messenger.sendReliable.bind(messenger)
    messenger.sendReliable = async (peerId: string, env: Envelope<FileCtlPayload>) => {
      await baseSend(peerId, env)
      return env.payload.op !== 'accept'
    }
    const msgRepo = new FakeMsgRepo()
    const transferRepo = new FakeTransferRepo()
    const convRepo = new FakeConvRepo()
    new FilesService({
      selfId: 'node-self',
      messenger: messenger as unknown as Messenger,
      registry: new FakeRegistry(['node-bob']) as unknown as PeerRegistry,
      convRepo: convRepo as unknown as ConvRepo,
      msgRepo: msgRepo as unknown as MsgRepo,
      transferRepo: transferRepo as unknown as TransferRepo,
      groupRepo: undefined,
      tcpPort: 0,
      getSaveDir: () => dir,
      getImagesDir: () => dir,
      getUpdateDir: () => updateDir,
      authorizeUpdateOffer: () => true,
      bindAddress: '127.0.0.1'
    })

    messenger.emit(
      'incoming',
      makeEnvelope<FileCtlPayload>(MSG_TYPES.fileCtl, 'node-bob', {
        op: 'offer',
        transferId: 't-update',
        seq: 1,
        total: 1,
        files: [{ fileId: 'f-1', path: 'Teahouse-0.28.0-linux-amd64.deb', size: 1024 }],
        totalSize: 1024,
        fileCount: 1,
        rootName: 'Teahouse-0.28.0-linux-amd64.deb',
        purpose: 'update'
      })
    )
    await waitTick()

    expect(msgRepo.rows.size).toBe(0)
    expect(convRepo.bumped).toHaveLength(0)
    expect(transferRepo.rows.size).toBe(1)
    const row = transferRepo.get('t-update')
    expect(row?.msg_id).toBe('update:t-update')
    expect(row?.status).toBe('failed')
    expect(JSON.parse(row!.files)).toMatchObject({
      name: 'Teahouse-0.28.0-linux-amd64.deb',
      purpose: 'update',
      savedPath: join(updateDir, 'Teahouse-0.28.0-linux-amd64.deb')
    })
    expect(messenger.sent[0]).toMatchObject({
      peerId: 'node-bob',
      env: { payload: { op: 'accept', transferId: 't-update' } }
    })
  })

  it('未经用户请求授权的更新包 offer 直接拒绝且不入库', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'pantry-files-service-'))
    const updateDir = mkdtempSync(join(tmpdir(), 'pantry-update-service-'))
    tmpDirs.push(dir, updateDir)

    const messenger = new FakeMessenger()
    const msgRepo = new FakeMsgRepo()
    const transferRepo = new FakeTransferRepo()
    new FilesService({
      selfId: 'node-self',
      messenger: messenger as unknown as Messenger,
      registry: new FakeRegistry(['node-bob']) as unknown as PeerRegistry,
      convRepo: new FakeConvRepo() as unknown as ConvRepo,
      msgRepo: msgRepo as unknown as MsgRepo,
      transferRepo: transferRepo as unknown as TransferRepo,
      groupRepo: undefined,
      tcpPort: 0,
      getSaveDir: () => dir,
      getImagesDir: () => dir,
      getUpdateDir: () => updateDir,
      authorizeUpdateOffer: () => false,
      bindAddress: '127.0.0.1'
    })

    messenger.emit(
      'incoming',
      makeEnvelope<FileCtlPayload>(MSG_TYPES.fileCtl, 'node-bob', {
        op: 'offer',
        transferId: 't-update-unauthorized',
        seq: 1,
        total: 1,
        files: [{ fileId: 'f-1', path: 'Teahouse-0.28.0-linux-amd64.deb', size: 1024 }],
        totalSize: 1024,
        fileCount: 1,
        rootName: 'Teahouse-0.28.0-linux-amd64.deb',
        purpose: 'update'
      })
    )
    await waitTick()

    expect(msgRepo.rows.size).toBe(0)
    expect(transferRepo.rows.size).toBe(0)
    expect(messenger.sent[0]).toMatchObject({
      peerId: 'node-bob',
      env: { payload: { op: 'decline', transferId: 't-update-unauthorized' } }
    })
  })

  it('拒绝声明总大小与文件清单不一致的图片 offer', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'pantry-files-service-'))
    tmpDirs.push(dir)

    const messenger = new FakeMessenger()
    const msgRepo = new FakeMsgRepo()
    const transferRepo = new FakeTransferRepo()
    new FilesService({
      selfId: 'node-self',
      messenger: messenger as unknown as Messenger,
      registry: new FakeRegistry(['node-bob'], [CAPS.mediaRecall]) as unknown as PeerRegistry,
      convRepo: new FakeConvRepo() as unknown as ConvRepo,
      msgRepo: msgRepo as unknown as MsgRepo,
      transferRepo: transferRepo as unknown as TransferRepo,
      groupRepo: undefined,
      tcpPort: 0,
      getSaveDir: () => dir,
      getImagesDir: () => dir,
      bindAddress: '127.0.0.1'
    })

    messenger.emit(
      'incoming',
      makeEnvelope<FileCtlPayload>(MSG_TYPES.fileCtl, 'node-bob', {
        op: 'offer',
        transferId: 't-bad-size',
        seq: 1,
        total: 1,
        files: [{ fileId: 'f-1', path: 'a.png', size: 30 }],
        totalSize: 1,
        fileCount: 1,
        rootName: 'a.png',
        purpose: 'image'
      })
    )
    await waitTick()

    expect(msgRepo.rows.size).toBe(0)
    expect(transferRepo.rows.size).toBe(0)
    expect(messenger.sent[0].peerId).toBe('node-bob')
    expect(messenger.sent[0].env.payload).toMatchObject({
      op: 'decline',
      transferId: 't-bad-size'
    })
  })

  it('群文件发送只投递在线成员，并在本端只插入一条群消息', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'pantry-files-service-'))
    tmpDirs.push(dir)
    const filePath = join(dir, '群文件.txt')
    writeFileSync(filePath, 'hello group')

    const messenger = new FakeMessenger()
    const msgRepo = new FakeMsgRepo()
    const transferRepo = new FakeTransferRepo()
    const group: GroupMeta = {
      groupId: 'group-1',
      name: '项目组',
      members: ['node-self', 'node-bob', 'node-carol', 'node-dan'],
      rev: 3,
      updatedBy: 'node-self',
      updatedTs: 1000,
      creatorIp: '127.0.0.1',
      creatorId: 'node-self',
      adminSecretHash: '',
      adminHint: ''
    }
    const service = new FilesService({
      selfId: 'node-self',
      messenger: messenger as unknown as Messenger,
      registry: new FakeRegistry(['node-bob', 'node-dan']) as unknown as PeerRegistry,
      convRepo: new FakeConvRepo() as unknown as ConvRepo,
      msgRepo: msgRepo as unknown as MsgRepo,
      transferRepo: transferRepo as unknown as TransferRepo,
      groupRepo: new FakeGroupRepo(group) as unknown as GroupRepo,
      tcpPort: 0,
      getSaveDir: () => dir,
      getImagesDir: () => dir,
      bindAddress: '127.0.0.1'
    })

    const view = await service.offerGroupPaths('group-1', [filePath])
    expect(view?.convId).toBe('group:group-1')
    expect(view?.fileRef?.transferIds).toHaveLength(2)
    expect(msgRepo.rows.size).toBe(1)
    expect(transferRepo.rows.size).toBe(2)

    await waitTick()
    expect(messenger.sent.map((item) => item.peerId).sort()).toEqual(['node-bob', 'node-dan'])
    for (const item of messenger.sent) {
      expect(item.env.type).toBe(MSG_TYPES.fileCtl)
      expect(item.env.payload).toMatchObject({
        op: 'offer',
        groupId: 'group-1',
        groupRev: 3,
        rootName: '群文件.txt'
      })
    }
    expect(msgRepo.get(view!.id)?.status).toBe('sent')
  })

  it('群聊图片不超过 10MB 时按图片 offer 投递', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'pantry-files-service-'))
    tmpDirs.push(dir)
    const filePath = join(dir, '群图片.png')
    writeFileSync(filePath, 'small image')

    const messenger = new FakeMessenger()
    const msgRepo = new FakeMsgRepo()
    const transferRepo = new FakeTransferRepo()
    const group: GroupMeta = {
      groupId: 'group-1',
      name: '项目组',
      members: ['node-self', 'node-bob'],
      rev: 3,
      updatedBy: 'node-self',
      updatedTs: 1000,
      creatorIp: '127.0.0.1',
      creatorId: 'node-self',
      adminSecretHash: '',
      adminHint: ''
    }
    const service = new FilesService({
      selfId: 'node-self',
      messenger: messenger as unknown as Messenger,
      registry: new FakeRegistry(['node-bob'], [CAPS.mediaRecall]) as unknown as PeerRegistry,
      convRepo: new FakeConvRepo() as unknown as ConvRepo,
      msgRepo: msgRepo as unknown as MsgRepo,
      transferRepo: transferRepo as unknown as TransferRepo,
      groupRepo: new FakeGroupRepo(group) as unknown as GroupRepo,
      tcpPort: 0,
      getSaveDir: () => dir,
      getImagesDir: () => dir,
      bindAddress: '127.0.0.1'
    })

    const view = await service.offerGroupPaths('group-1', [filePath], 'image')
    expect(view?.kind).toBe('image')

    await waitTick()
    expect(messenger.sent[0].env.payload).toMatchObject({
      op: 'offer',
      purpose: 'image',
      groupId: 'group-1'
    })
  })

  it('群聊表格图片按成员 tbl1 能力分别携带文字视图', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'pantry-group-table-image-'))
    tmpDirs.push(dir)
    const filePath = join(dir, '群表格.png')
    writeFileSync(filePath, 'small image')

    const messenger = new FakeMessenger()
    const msgRepo = new FakeMsgRepo()
    const transferRepo = new FakeTransferRepo()
    const group: GroupMeta = {
      groupId: 'group-1',
      name: '项目组',
      members: ['node-self', 'node-bob', 'node-carol'],
      rev: 3,
      updatedBy: 'node-self',
      updatedTs: 1000,
      creatorIp: '127.0.0.1',
      creatorId: 'node-self',
      adminSecretHash: '',
      adminHint: ''
    }
    const service = new FilesService({
      selfId: 'node-self',
      messenger: messenger as unknown as Messenger,
      registry: new FakeRegistry(['node-bob', 'node-carol'], {
        'node-bob': [CAPS.tableText],
        'node-carol': []
      }) as unknown as PeerRegistry,
      convRepo: new FakeConvRepo() as unknown as ConvRepo,
      msgRepo: msgRepo as unknown as MsgRepo,
      transferRepo: transferRepo as unknown as TransferRepo,
      groupRepo: new FakeGroupRepo(group) as unknown as GroupRepo,
      tcpPort: 0,
      getSaveDir: () => dir,
      getImagesDir: () => dir,
      bindAddress: '127.0.0.1'
    })

    const view = await service.offerGroupPaths('group-1', [filePath], 'image', {
      tableText: 'A\tB\n1\t2'
    })
    await waitTick()

    expect(view?.fileRef?.tableText).toBe('A\tB\n1\t2')
    const byPeer = new Map(messenger.sent.map((item) => [item.peerId, item.env.payload]))
    expect(byPeer.get('node-bob')).toMatchObject({ tableText: 'A\tB\n1\t2' })
    expect('tableText' in byPeer.get('node-carol')!).toBe(false)
  })

  it('群聊图片超过 10MB 时退化为普通文件，等待成员手动接收', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'pantry-files-service-'))
    tmpDirs.push(dir)
    const filePath = join(dir, '超限群图片.png')
    writeFileSync(filePath, '')
    truncateSync(filePath, 10 * 1024 * 1024 + 1)

    const messenger = new FakeMessenger()
    const msgRepo = new FakeMsgRepo()
    const transferRepo = new FakeTransferRepo()
    const group: GroupMeta = {
      groupId: 'group-1',
      name: '项目组',
      members: ['node-self', 'node-bob'],
      rev: 3,
      updatedBy: 'node-self',
      updatedTs: 1000,
      creatorIp: '127.0.0.1',
      creatorId: 'node-self',
      adminSecretHash: '',
      adminHint: ''
    }
    const service = new FilesService({
      selfId: 'node-self',
      messenger: messenger as unknown as Messenger,
      registry: new FakeRegistry(['node-bob']) as unknown as PeerRegistry,
      convRepo: new FakeConvRepo() as unknown as ConvRepo,
      msgRepo: msgRepo as unknown as MsgRepo,
      transferRepo: transferRepo as unknown as TransferRepo,
      groupRepo: new FakeGroupRepo(group) as unknown as GroupRepo,
      tcpPort: 0,
      getSaveDir: () => dir,
      getImagesDir: () => dir,
      bindAddress: '127.0.0.1'
    })

    const view = await service.offerGroupPaths('group-1', [filePath], 'image')
    expect(view?.kind).toBe('file')
    expect(view?.text).toBe('[文件] 超限群图片.png')

    await waitTick()
    expect(messenger.sent[0].env.payload).toMatchObject({
      op: 'offer',
      groupId: 'group-1'
    })
    expect('purpose' in messenger.sent[0].env.payload).toBe(false)
    expect([...transferRepo.rows.values()][0].status).toBe('offering')
  })
})

describe('FilesService 默认接收目录', () => {
  it('手动接收默认保存到联系人目录，另存为直接使用用户选择目录', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'pantry-default-recv-'))
    tmpDirs.push(dir)
    const saveAsDir = join(dir, '用户选择目录')

    const messenger = new FakeMessenger()
    const baseSend = messenger.sendReliable.bind(messenger)
    messenger.sendReliable = async (peerId: string, env: Envelope<FileCtlPayload>) => {
      await baseSend(peerId, env)
      return env.payload.op !== 'accept'
    }
    const msgRepo = new FakeMsgRepo()
    const transferRepo = new FakeTransferRepo()
    const service = new FilesService({
      selfId: 'node-self',
      messenger: messenger as unknown as Messenger,
      registry: new FakeRegistry(['node-bob']) as unknown as PeerRegistry,
      convRepo: new FakeConvRepo() as unknown as ConvRepo,
      msgRepo: msgRepo as unknown as MsgRepo,
      transferRepo: transferRepo as unknown as TransferRepo,
      groupRepo: undefined,
      tcpPort: 0,
      getSaveDir: () => dir,
      getImagesDir: () => dir,
      peerDisplayName: () => '李四/研发',
      bindAddress: '127.0.0.1'
    })
    const offer = (transferId: string, name: string): void => {
      messenger.emit(
        'incoming',
        makeEnvelope<FileCtlPayload>(MSG_TYPES.fileCtl, 'node-bob', {
          op: 'offer',
          transferId,
          seq: 1,
          total: 1,
          files: [{ fileId: `${transferId}-f`, path: name, size: 5 }],
          totalSize: 5,
          fileCount: 1,
          rootName: name
        })
      )
    }

    offer('t-manual', '资料.txt')
    await waitTick()
    await expect(service.accept('t-manual')).resolves.toBe(false)
    expect(JSON.parse(transferRepo.get('t-manual')!.files)).toMatchObject({
      name: '资料.txt',
      savedPath: join(dir, '李四 研发', '资料.txt')
    })
    expect(JSON.parse(transferRepo.get('t-manual')!.files)).not.toHaveProperty('direct')

    offer('t-save-as', '方案.txt')
    await waitTick()
    await expect(service.accept('t-save-as', saveAsDir)).resolves.toBe(false)
    expect(JSON.parse(transferRepo.get('t-save-as')!.files)).toMatchObject({
      name: '方案.txt',
      savedPath: join(saveAsDir, '方案.txt')
    })
    expect(messenger.sent.filter((item) => item.env.payload.op === 'accept')).toHaveLength(2)
  })
})

describe('FilesService 私聊直接发送', () => {
  it('发送聊天媒体 offer 时携带本端消息 ID，供对端复用撤回锚点', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'pantry-media-msgid-send-'))
    tmpDirs.push(dir)
    const filePath = join(dir, '图片.png')
    writeFileSync(filePath, 'image')

    const messenger = new FakeMessenger()
    const msgRepo = new FakeMsgRepo()
    const transferRepo = new FakeTransferRepo()
    const service = new FilesService({
      selfId: 'node-self',
      messenger: messenger as unknown as Messenger,
      registry: new FakeRegistry(['node-bob']) as unknown as PeerRegistry,
      convRepo: new FakeConvRepo() as unknown as ConvRepo,
      msgRepo: msgRepo as unknown as MsgRepo,
      transferRepo: transferRepo as unknown as TransferRepo,
      tcpPort: 0,
      getSaveDir: () => dir,
      getImagesDir: () => dir,
      bindAddress: '127.0.0.1'
    })

    const view = await service.offerPaths('node-bob', [filePath], 'image')
    await waitTick()

    expect(view?.kind).toBe('image')
    expect(messenger.sent[0].env.payload).toMatchObject({
      op: 'offer',
      msgId: view!.id,
      purpose: 'image'
    })
  })

  it('表格图片只向支持 tbl1 的单聊对端携带文字视图元数据', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'pantry-table-image-send-'))
    tmpDirs.push(dir)
    const filePath = join(dir, '表格.png')
    writeFileSync(filePath, 'image')

    const messenger = new FakeMessenger()
    const msgRepo = new FakeMsgRepo()
    const transferRepo = new FakeTransferRepo()
    const service = new FilesService({
      selfId: 'node-self',
      messenger: messenger as unknown as Messenger,
      registry: new FakeRegistry(['node-bob'], [CAPS.tableText]) as unknown as PeerRegistry,
      convRepo: new FakeConvRepo() as unknown as ConvRepo,
      msgRepo: msgRepo as unknown as MsgRepo,
      transferRepo: transferRepo as unknown as TransferRepo,
      tcpPort: 0,
      getSaveDir: () => dir,
      getImagesDir: () => dir,
      bindAddress: '127.0.0.1'
    })

    const view = await service.offerPaths('node-bob', [filePath], 'image', {
      tableText: '姓名\t分数\n张三\t100',
      tableTextTruncated: true
    })
    await waitTick()

    expect(view?.fileRef).toMatchObject({
      tableText: '姓名\t分数\n张三\t100',
      tableTextTruncated: true
    })
    expect(messenger.sent[0].env.payload).toMatchObject({
      purpose: 'image',
      tableText: '姓名\t分数\n张三\t100',
      tableTextTruncated: true
    })
  })

  it('表格图片发给未声明 tbl1 的单聊对端时只保留本端文字视图', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'pantry-table-image-legacy-'))
    tmpDirs.push(dir)
    const filePath = join(dir, '表格.png')
    writeFileSync(filePath, 'image')

    const messenger = new FakeMessenger()
    const service = new FilesService({
      selfId: 'node-self',
      messenger: messenger as unknown as Messenger,
      registry: new FakeRegistry(['node-bob']) as unknown as PeerRegistry,
      convRepo: new FakeConvRepo() as unknown as ConvRepo,
      msgRepo: new FakeMsgRepo() as unknown as MsgRepo,
      transferRepo: new FakeTransferRepo() as unknown as TransferRepo,
      tcpPort: 0,
      getSaveDir: () => dir,
      getImagesDir: () => dir,
      bindAddress: '127.0.0.1'
    })

    const view = await service.offerPaths('node-bob', [filePath], 'image', {
      tableText: '姓名\t分数\n张三\t100'
    })
    await waitTick()

    expect(view?.fileRef?.tableText).toBe('姓名\t分数\n张三\t100')
    expect('tableText' in messenger.sent[0].env.payload).toBe(false)
    expect('tableTextTruncated' in messenger.sent[0].env.payload).toBe(false)
  })

  it('接收表格图片 offer 时把文字视图元数据写入图片 fileRef', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'pantry-table-image-recv-'))
    tmpDirs.push(dir)

    const messenger = new FakeMessenger()
    const msgRepo = new FakeMsgRepo()
    new FilesService({
      selfId: 'node-self',
      messenger: messenger as unknown as Messenger,
      registry: new FakeRegistry(['node-bob']) as unknown as PeerRegistry,
      convRepo: new FakeConvRepo() as unknown as ConvRepo,
      msgRepo: msgRepo as unknown as MsgRepo,
      transferRepo: new FakeTransferRepo() as unknown as TransferRepo,
      tcpPort: 0,
      getSaveDir: () => dir,
      getImagesDir: () => dir,
      bindAddress: '127.0.0.1'
    })

    messenger.emit(
      'incoming',
      makeEnvelope<FileCtlPayload>(MSG_TYPES.fileCtl, 'node-bob', {
        op: 'offer',
        transferId: 't-table-img',
        msgId: 'msg-table-img',
        seq: 1,
        total: 1,
        files: [{ fileId: 'f-1', path: 'table.png', size: 5 }],
        totalSize: 5,
        fileCount: 1,
        rootName: 'table.png',
        purpose: 'image',
        tableText: '姓名\t分数\n李四\t98',
        tableTextTruncated: true
      } as FileCtlPayload)
    )
    await waitTick()

    const ref = JSON.parse(msgRepo.get('msg-table-img')!.file_ref ?? '{}')
    expect(ref).toMatchObject({
      transferId: 't-table-img',
      tableText: '姓名\t分数\n李四\t98',
      tableTextTruncated: true
    })
  })

  it('接收带 msgId 的文件 offer 时用该 ID 入库并关联 transfer', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'pantry-media-msgid-recv-'))
    tmpDirs.push(dir)

    const messenger = new FakeMessenger()
    const msgRepo = new FakeMsgRepo()
    const transferRepo = new FakeTransferRepo()
    new FilesService({
      selfId: 'node-self',
      messenger: messenger as unknown as Messenger,
      registry: new FakeRegistry(['node-bob']) as unknown as PeerRegistry,
      convRepo: new FakeConvRepo() as unknown as ConvRepo,
      msgRepo: msgRepo as unknown as MsgRepo,
      transferRepo: transferRepo as unknown as TransferRepo,
      tcpPort: 0,
      getSaveDir: () => dir,
      getImagesDir: () => dir,
      bindAddress: '127.0.0.1'
    })

    messenger.emit(
      'incoming',
      makeEnvelope<FileCtlPayload>(MSG_TYPES.fileCtl, 'node-bob', {
        op: 'offer',
        transferId: 't-shared-msg',
        msgId: 'msg-shared-media',
        seq: 1,
        total: 1,
        files: [{ fileId: 'f-1', path: '资料.txt', size: 5 }],
        totalSize: 5,
        fileCount: 1,
        rootName: '资料.txt'
      } as FileCtlPayload)
    )
    await waitTick()

    expect(msgRepo.get('msg-shared-media')).toMatchObject({
      id: 'msg-shared-media',
      kind: 'file',
      conv_id: 'single:node-bob'
    })
    expect(transferRepo.get('t-shared-msg')?.msg_id).toBe('msg-shared-media')
  })

  it('文件只在关联 transfer 未完成时允许撤回', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'pantry-media-recall-state-'))
    tmpDirs.push(dir)
    const filePath = join(dir, '资料.txt')
    writeFileSync(filePath, 'hello')

    const messenger = new FakeMessenger()
    const msgRepo = new FakeMsgRepo()
    const transferRepo = new FakeTransferRepo()
    const service = new FilesService({
      selfId: 'node-self',
      messenger: messenger as unknown as Messenger,
      registry: new FakeRegistry(['node-bob'], [CAPS.mediaRecall]) as unknown as PeerRegistry,
      convRepo: new FakeConvRepo() as unknown as ConvRepo,
      msgRepo: msgRepo as unknown as MsgRepo,
      transferRepo: transferRepo as unknown as TransferRepo,
      tcpPort: 0,
      getSaveDir: () => dir,
      getImagesDir: () => dir,
      bindAddress: '127.0.0.1'
    })

    const view = await service.offerPaths('node-bob', [filePath])
    const transferId = view!.fileRef!.transferId
    const mediaRecall = service as unknown as { canRecallMessage(msgId: string): boolean }

    expect(mediaRecall.canRecallMessage(view!.id)).toBe(true)
    transferRepo.updateStatus(transferId, 'done')
    expect(mediaRecall.canRecallMessage(view!.id)).toBe(false)
  })

  it('旧端未声明媒体撤回能力时不允许撤回聊天媒体', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'pantry-media-recall-cap-'))
    tmpDirs.push(dir)
    const filePath = join(dir, '资料.txt')
    writeFileSync(filePath, 'hello')

    const service = new FilesService({
      selfId: 'node-self',
      messenger: new FakeMessenger() as unknown as Messenger,
      registry: new FakeRegistry(['node-bob']) as unknown as PeerRegistry,
      convRepo: new FakeConvRepo() as unknown as ConvRepo,
      msgRepo: new FakeMsgRepo() as unknown as MsgRepo,
      transferRepo: new FakeTransferRepo() as unknown as TransferRepo,
      tcpPort: 0,
      getSaveDir: () => dir,
      getImagesDir: () => dir,
      bindAddress: '127.0.0.1'
    })

    const view = await service.offerPaths('node-bob', [filePath])
    const mediaRecall = service as unknown as { canRecallMessage(msgId: string): boolean }

    expect(mediaRecall.canRecallMessage(view!.id)).toBe(false)
  })

  it('发送侧在已有文件卡片上请求直接发送', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'pantry-direct-send-'))
    tmpDirs.push(dir)
    const filePath = join(dir, '资料.txt')
    writeFileSync(filePath, 'hello')

    const messenger = new FakeMessenger()
    const msgRepo = new FakeMsgRepo()
    const transferRepo = new FakeTransferRepo()
    const service = new FilesService({
      selfId: 'node-self',
      messenger: messenger as unknown as Messenger,
      registry: new FakeRegistry(['node-bob'], [CAPS.fileDirect]) as unknown as PeerRegistry,
      convRepo: new FakeConvRepo() as unknown as ConvRepo,
      msgRepo: msgRepo as unknown as MsgRepo,
      transferRepo: transferRepo as unknown as TransferRepo,
      groupRepo: undefined,
      tcpPort: 0,
      getSaveDir: () => dir,
      getImagesDir: () => dir,
      bindAddress: '127.0.0.1'
    })

    const view = await service.offerPaths('node-bob', [filePath])
    expect(view?.fileRef?.direct).toBeUndefined()
    await waitTick()
    const row = [...transferRepo.rows.values()][0]
    expect(messenger.sent[0]).toMatchObject({
      peerId: 'node-bob',
      env: {
        type: MSG_TYPES.fileCtl,
        payload: {
          op: 'offer',
          rootName: '资料.txt'
        }
      }
    })
    expect('receiveMode' in messenger.sent[0].env.payload).toBe(false)

    await expect(service.requestDirect(row.transfer_id)).resolves.toBe(true)
    expect(messenger.sent[1]).toMatchObject({
      peerId: 'node-bob',
      env: { payload: { op: 'direct', transferId: row.transfer_id } }
    })
    expect(JSON.parse(transferRepo.get(row.transfer_id)!.files)).toMatchObject({
      name: '资料.txt',
      direct: true
    })
    expect(service.transferView(row.transfer_id)?.direct).toBe(true)
  })

  it('接收侧收到 direct 控制帧后自动保存到发送人目录', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'pantry-direct-recv-'))
    tmpDirs.push(dir)

    const messenger = new FakeMessenger()
    const baseSend = messenger.sendReliable.bind(messenger)
    messenger.sendReliable = async (peerId: string, env: Envelope<FileCtlPayload>) => {
      await baseSend(peerId, env)
      return env.payload.op !== 'accept'
    }
    const msgRepo = new FakeMsgRepo()
    const transferRepo = new FakeTransferRepo()
    new FilesService({
      selfId: 'node-self',
      messenger: messenger as unknown as Messenger,
      registry: new FakeRegistry(['node-bob']) as unknown as PeerRegistry,
      convRepo: new FakeConvRepo() as unknown as ConvRepo,
      msgRepo: msgRepo as unknown as MsgRepo,
      transferRepo: transferRepo as unknown as TransferRepo,
      groupRepo: undefined,
      tcpPort: 0,
      getSaveDir: () => dir,
      getImagesDir: () => dir,
      allowDirectFileSend: () => true,
      peerDisplayName: () => '张三/设计',
      bindAddress: '127.0.0.1'
    })

    messenger.emit(
      'incoming',
      makeEnvelope<FileCtlPayload>(MSG_TYPES.fileCtl, 'node-bob', {
        op: 'offer',
        transferId: 't-direct',
        seq: 1,
        total: 1,
        files: [{ fileId: 'f-1', path: '资料.txt', size: 5 }],
        totalSize: 5,
        fileCount: 1,
        rootName: '资料.txt'
      })
    )
    await waitTick()

    const msg = [...msgRepo.rows.values()][0]
    expect(JSON.parse(msg.file_ref!)).not.toHaveProperty('direct')
    expect(transferRepo.get('t-direct')?.status).toBe('offering')

    messenger.emit(
      'incoming',
      makeEnvelope<FileCtlPayload>(MSG_TYPES.fileCtl, 'node-bob', {
        op: 'direct',
        transferId: 't-direct'
      })
    )
    await waitTick()

    const row = transferRepo.get('t-direct')
    expect(row?.status).toBe('failed')
    expect(JSON.parse(row!.files)).toMatchObject({
      name: '资料.txt',
      direct: true,
      directPeerName: '张三 设计',
      savedPath: join(dir, '张三 设计', '资料.txt')
    })
    expect(messenger.sent[0]).toMatchObject({
      peerId: 'node-bob',
      env: { payload: { op: 'accept', transferId: 't-direct' } }
    })
  })

  it('接收侧关闭直接接收时忽略 direct 控制帧，保留普通文件卡片', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'pantry-direct-disabled-'))
    tmpDirs.push(dir)

    const messenger = new FakeMessenger()
    const msgRepo = new FakeMsgRepo()
    const transferRepo = new FakeTransferRepo()
    new FilesService({
      selfId: 'node-self',
      messenger: messenger as unknown as Messenger,
      registry: new FakeRegistry(['node-bob']) as unknown as PeerRegistry,
      convRepo: new FakeConvRepo() as unknown as ConvRepo,
      msgRepo: msgRepo as unknown as MsgRepo,
      transferRepo: transferRepo as unknown as TransferRepo,
      groupRepo: undefined,
      tcpPort: 0,
      getSaveDir: () => dir,
      getImagesDir: () => dir,
      allowDirectFileSend: () => false,
      peerDisplayName: () => '张三',
      bindAddress: '127.0.0.1'
    })

    messenger.emit(
      'incoming',
      makeEnvelope<FileCtlPayload>(MSG_TYPES.fileCtl, 'node-bob', {
        op: 'offer',
        transferId: 't-direct-disabled',
        seq: 1,
        total: 1,
        files: [{ fileId: 'f-1', path: '资料.txt', size: 5 }],
        totalSize: 5,
        fileCount: 1,
        rootName: '资料.txt'
      })
    )
    await waitTick()

    messenger.emit(
      'incoming',
      makeEnvelope<FileCtlPayload>(MSG_TYPES.fileCtl, 'node-bob', {
        op: 'direct',
        transferId: 't-direct-disabled'
      })
    )
    await waitTick()

    const msg = [...msgRepo.rows.values()][0]
    expect(JSON.parse(msg.file_ref!)).not.toHaveProperty('direct')
    const row = transferRepo.get('t-direct-disabled')
    expect(row?.status).toBe('offering')
    expect(JSON.parse(row!.files)).not.toHaveProperty('direct')
    expect(messenger.sent).toHaveLength(0)
  })

  it('群聊文件即使收到 direct 控制帧也不自动接收', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'pantry-direct-group-'))
    tmpDirs.push(dir)

    const messenger = new FakeMessenger()
    const msgRepo = new FakeMsgRepo()
    const transferRepo = new FakeTransferRepo()
    new FilesService({
      selfId: 'node-self',
      messenger: messenger as unknown as Messenger,
      registry: new FakeRegistry(['node-bob']) as unknown as PeerRegistry,
      convRepo: new FakeConvRepo() as unknown as ConvRepo,
      msgRepo: msgRepo as unknown as MsgRepo,
      transferRepo: transferRepo as unknown as TransferRepo,
      groupRepo: undefined,
      tcpPort: 0,
      getSaveDir: () => dir,
      getImagesDir: () => dir,
      allowDirectFileSend: () => true,
      peerDisplayName: () => '张三',
      bindAddress: '127.0.0.1'
    })

    messenger.emit(
      'incoming',
      makeEnvelope<FileCtlPayload>(MSG_TYPES.fileCtl, 'node-bob', {
        op: 'offer',
        transferId: 't-group-direct',
        seq: 1,
        total: 1,
        files: [{ fileId: 'f-1', path: '群资料.txt', size: 5 }],
        totalSize: 5,
        fileCount: 1,
        rootName: '群资料.txt',
        groupId: 'group-1',
        groupRev: 1
      })
    )
    await waitTick()

    messenger.emit(
      'incoming',
      makeEnvelope<FileCtlPayload>(MSG_TYPES.fileCtl, 'node-bob', {
        op: 'direct',
        transferId: 't-group-direct'
      })
    )
    await waitTick()

    const msg = [...msgRepo.rows.values()][0]
    expect(msg.conv_id).toBe('group:group-1')
    const row = transferRepo.get('t-group-direct')
    expect(row?.status).toBe('offering')
    expect(JSON.parse(row!.files)).not.toHaveProperty('direct')
    expect(messenger.sent.some((item) => item.env.payload.op === 'accept')).toBe(false)
  })
})

describe('FilesService 发送状态以数据面为准（issue #3）', () => {
  // 让 offer 控制报文的回程 ACK 结果可控（模拟 UDP 丢包后判负）；accept 等其它报文照常成功。
  function makeService(offerAck: boolean | Promise<boolean>) {
    const dir = mkdtempSync(join(tmpdir(), 'pantry-files-issue3-'))
    tmpDirs.push(dir)
    const imgPath = join(dir, 'shot.png')
    writeFileSync(imgPath, 'small image bytes')

    const messenger = new FakeMessenger()
    const baseSend = messenger.sendReliable.bind(messenger)
    messenger.sendReliable = async (peerId: string, env: Envelope<FileCtlPayload>) => {
      await baseSend(peerId, env)
      return env.payload.op === 'offer' ? offerAck : true
    }

    const msgRepo = new FakeMsgRepo()
    const transferRepo = new FakeTransferRepo()
    const service = new FilesService({
      selfId: 'node-self',
      messenger: messenger as unknown as Messenger,
      registry: new FakeRegistry(['node-bob']) as unknown as PeerRegistry,
      convRepo: new FakeConvRepo() as unknown as ConvRepo,
      msgRepo: msgRepo as unknown as MsgRepo,
      transferRepo: transferRepo as unknown as TransferRepo,
      groupRepo: undefined,
      tcpPort: 0,
      getSaveDir: () => dir,
      getImagesDir: () => dir,
      bindAddress: '127.0.0.1'
    })
    return { service, messenger, msgRepo, transferRepo, imgPath }
  }

  it('offer 回程 ACK 丢失、但数据已送达 → 判已发送，不被迟到的失败覆盖', async () => {
    let failOffer!: (v: boolean) => void
    const { service, msgRepo, transferRepo, imgPath } = makeService(
      new Promise<boolean>((resolve) => {
        failOffer = resolve
      })
    )
    const view = await service.offerPaths('node-bob', [imgPath], 'image')
    expect(view).not.toBeNull()
    const tid = [...transferRepo.rows.keys()][0]

    // 数据先于 offer 判负通过 TCP 拉走完成
    ;(service as unknown as { server: EventEmitter }).server.emit('served', tid)
    expect(msgRepo.get(view!.id)?.status).toBe('sent')
    expect(transferRepo.get(tid)?.status).toBe('done')

    // offer 回程 ACK 这才超时判负（迟到），不得翻回失败
    failOffer(false)
    await waitTick()
    expect(msgRepo.get(view!.id)?.status).toBe('sent')
    expect(transferRepo.get(tid)?.status).toBe('done')
  })

  it('offer 回程 ACK 丢失、但对方已接受 → 判已发送', async () => {
    let failOffer!: (v: boolean) => void
    const { service, messenger, msgRepo, transferRepo, imgPath } = makeService(
      new Promise<boolean>((resolve) => {
        failOffer = resolve
      })
    )
    const view = await service.offerPaths('node-bob', [imgPath], 'image')
    const tid = [...transferRepo.rows.keys()][0]

    messenger.emit(
      'incoming',
      makeEnvelope<FileCtlPayload>(MSG_TYPES.fileCtl, 'node-bob', {
        op: 'accept',
        transferId: tid
      })
    )
    expect(msgRepo.get(view!.id)?.status).toBe('sent')
    expect(transferRepo.get(tid)?.status).toBe('accepted')

    failOffer(false)
    await waitTick()
    expect(msgRepo.get(view!.id)?.status).toBe('sent')
  })

  it('发送方主动取消后，迟到的 offer 失败与数据面完成都不得覆盖取消终态（决议 #236）', async () => {
    let failOffer!: (v: boolean) => void
    const { service, msgRepo, transferRepo, imgPath } = makeService(
      new Promise<boolean>((resolve) => {
        failOffer = resolve
      })
    )
    const view = await service.offerPaths('node-bob', [imgPath])
    expect(view).not.toBeNull()
    const tid = [...transferRepo.rows.keys()][0]

    await service.cancel(tid)
    expect(msgRepo.get(view!.id)?.status).toBe('canceled')
    expect(transferRepo.get(tid)?.status).toBe('canceled')

    failOffer(false)
    await waitTick()
    expect(msgRepo.get(view!.id)?.status).toBe('canceled')
    expect(transferRepo.get(tid)?.status).toBe('canceled')

    ;(service as unknown as { server: EventEmitter }).server.emit('served', tid)
    expect(msgRepo.get(view!.id)?.status).toBe('canceled')
    expect(transferRepo.get(tid)?.status).toBe('canceled')
  })

  it('offer 失败且无任何送达迹象 → 仍判失败', async () => {
    const { service, msgRepo, transferRepo, imgPath } = makeService(false)
    const view = await service.offerPaths('node-bob', [imgPath], 'image')
    await waitTick()
    const tid = [...transferRepo.rows.keys()][0]
    expect(msgRepo.get(view!.id)?.status).toBe('failed')
    expect(transferRepo.get(tid)?.status).toBe('failed')
  })

  it('offer 判负先标失败、数据随后送达 → served 以数据面为准救回已发送/完成（#164 测试盲区）', async () => {
    // #164 三个用例都只测了「served / accept 先、判负后」；这里是逆序：判负抢先删 outgoing，
    // 迟到的 served 仍须把误标的 failed 救回 done/sent（决议 #165 改动②的纵深防御行为）。
    const { service, msgRepo, transferRepo, imgPath } = makeService(false)
    const view = await service.offerPaths('node-bob', [imgPath], 'image')
    await waitTick() // offer 判负回调先跑：finish('failed') 删 outgoing、消息标 failed
    const tid = [...transferRepo.rows.keys()][0]
    expect(transferRepo.get(tid)?.status).toBe('failed')
    expect(msgRepo.get(view!.id)?.status).toBe('failed')

    // 接收方其实已收图、TCP 拉走整图并回 finish 帧 → served 迟到送达
    ;(service as unknown as { server: EventEmitter }).server.emit('served', tid)
    expect(transferRepo.get(tid)?.status).toBe('done')
    expect(msgRepo.get(view!.id)?.status).toBe('sent')
  })
})

describe('FilesService 取消可恢复（决议 #211）', () => {
  function waitUntil(predicate: () => boolean, timeoutMs = 1_000): Promise<void> {
    return new Promise((resolve, reject) => {
      const start = Date.now()
      const timer = setInterval(() => {
        if (predicate()) {
          clearInterval(timer)
          resolve()
        } else if (Date.now() - start > timeoutMs) {
          clearInterval(timer)
          reject(new Error('timeout'))
        }
      }, 10)
    })
  }

  function makeIncomingService(peerCaps: string[]): {
    service: FilesService
    messenger: FakeMessenger
    transferRepo: FakeTransferRepo
  } {
    const dir = mkdtempSync(join(tmpdir(), 'pantry-files-retry-'))
    tmpDirs.push(dir)
    const messenger = new FakeMessenger()
    const transferRepo = new FakeTransferRepo()
    const service = new FilesService({
      selfId: 'node-self',
      messenger: messenger as unknown as Messenger,
      registry: new FakeRegistry(['node-bob'], peerCaps) as unknown as PeerRegistry,
      convRepo: new FakeConvRepo() as unknown as ConvRepo,
      msgRepo: new FakeMsgRepo() as unknown as MsgRepo,
      transferRepo: transferRepo as unknown as TransferRepo,
      groupRepo: undefined,
      tcpPort: 0,
      getSaveDir: () => dir,
      getImagesDir: () => dir,
      bindAddress: '127.0.0.1'
    })
    messenger.emit(
      'incoming',
      makeEnvelope<FileCtlPayload>(MSG_TYPES.fileCtl, 'node-bob', {
        op: 'offer',
        transferId: 't-retry',
        seq: 1,
        total: 1,
        files: [{ fileId: 'f-1', path: 'a.bin', size: 8 }],
        totalSize: 8,
        fileCount: 1,
        rootName: 'a.bin'
      })
    )
    return { service, messenger, transferRepo }
  }

  it('接收方取消后（对端支持 tw1）可重新下载：上下文保留、再次 accept 成功', async () => {
    const { service, messenger, transferRepo } = makeIncomingService([CAPS.transferWait])
    await waitTick()
    expect(transferRepo.get('t-retry')?.status).toBe('offering')

    await service.cancel('t-retry')
    expect(transferRepo.get('t-retry')?.status).toBe('canceled')
    expect(service.transferView('t-retry')?.retryable).toBe(true)
    // 仍会通知发送方（发送方据此把卡片置为已取消，但保留供流授权）
    expect(
      messenger.sent.some((item) => item.env.payload.op === 'cancel')
    ).toBe(true)

    const ok = await service.accept('t-retry')
    expect(ok).toBe(true)
    expect(
      messenger.sent.some((item) => item.env.payload.op === 'accept')
    ).toBe(true)
    // 无真实供流端口，重拉很快失败 → 回到 failed 且上下文仍在，可继续重试
    await waitUntil(() => transferRepo.get('t-retry')?.status === 'failed')
    expect(service.transferView('t-retry')?.retryable).toBe(true)
  })

  it('对端为旧版本（无 tw1）时取消即终态：不提供重新下载', async () => {
    const { service, transferRepo } = makeIncomingService([])
    await waitTick()

    await service.cancel('t-retry')
    expect(transferRepo.get('t-retry')?.status).toBe('canceled')
    expect(service.transferView('t-retry')?.retryable).toBe(false)
    await expect(service.accept('t-retry')).resolves.toBe(false)
    expect(transferRepo.get('t-retry')?.status).toBe('canceled')
  })

  it('发送方主动取消是终态：接收方作废上下文，不再展示重新下载', async () => {
    const { service, transferRepo, messenger } = makeIncomingService([CAPS.transferWait])
    await waitTick()

    messenger.emit(
      'incoming',
      makeEnvelope<FileCtlPayload>(MSG_TYPES.fileCtl, 'node-bob', {
        op: 'cancel',
        transferId: 't-retry'
      })
    )
    expect(transferRepo.get('t-retry')?.status).toBe('canceled')
    expect(service.transferView('t-retry')?.retryable).toBe(false)
    await expect(service.accept('t-retry')).resolves.toBe(false)
  })

  it('接收后传输中取消（用户反馈复现）：状态回 canceled 且重新下载仍可用', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'pantry-files-midpull-'))
    tmpDirs.push(dir)
    // 静默供流端：接受连接与 pull 帧但永不回应，把接收方钉在「传输中」
    const { createServer } = await import('node:net')
    const silent = createServer(() => undefined)
    await new Promise<void>((resolve) => silent.listen(0, '127.0.0.1', () => resolve()))
    const port = (silent.address() as { port: number }).port

    const messenger = new FakeMessenger()
    const transferRepo = new FakeTransferRepo()
    const service = new FilesService({
      selfId: 'node-self',
      messenger: messenger as unknown as Messenger,
      registry: new FakeRegistry(['node-bob'], [CAPS.transferWait], port) as unknown as PeerRegistry,
      convRepo: new FakeConvRepo() as unknown as ConvRepo,
      msgRepo: new FakeMsgRepo() as unknown as MsgRepo,
      transferRepo: transferRepo as unknown as TransferRepo,
      groupRepo: new FakeGroupRepo({
        groupId: 'g-1',
        name: '测试群',
        members: ['node-bob', 'node-self'],
        rev: 1,
        updatedBy: 'node-bob',
        updatedTs: 1,
        creatorIp: '127.0.0.1',
        creatorId: 'node-bob',
        adminSecretHash: '',
        adminHint: ''
      }) as unknown as GroupRepo,
      tcpPort: 0,
      getSaveDir: () => dir,
      getImagesDir: () => dir,
      bindAddress: '127.0.0.1'
    })
    // 完整对齐用户场景：群聊文件 offer（带 groupId/groupRev/msgId）
    messenger.emit(
      'incoming',
      makeEnvelope<FileCtlPayload>(MSG_TYPES.fileCtl, 'node-bob', {
        op: 'offer',
        transferId: 't-midpull',
        seq: 1,
        total: 1,
        files: [{ fileId: 'f-1', path: 'a.bin', size: 8 }],
        totalSize: 8,
        fileCount: 1,
        rootName: 'a.bin',
        msgId: 'm-group-file',
        groupId: 'g-1',
        groupRev: 1
      })
    )
    await waitTick()

    try {
      // 用户点「接收」：进入传输中，拉取悬挂在静默供流端
      await expect(service.accept('t-midpull')).resolves.toBe(true)
      expect(transferRepo.get('t-midpull')?.status).toBe('accepted')
      await waitUntil(
        () =>
          (service as unknown as { incoming: Map<string, { cancelRef: { socket: unknown } }> })
            .incoming.get('t-midpull')?.cancelRef.socket !== null
      )

      // 用户点「取消」
      await service.cancel('t-midpull')
      expect(transferRepo.get('t-midpull')?.status).toBe('canceled')
      expect(service.transferView('t-midpull')?.retryable).toBe(true)

      // 拉取 promise 的失败回调随后落地，不得把状态/可恢复性冲掉
      await new Promise((resolve) => setTimeout(resolve, 100))
      expect(transferRepo.get('t-midpull')?.status).toBe('canceled')
      expect(service.transferView('t-midpull')?.retryable).toBe(true)

      // 再点「重新下载」仍可发起
      await expect(service.accept('t-midpull')).resolves.toBe(true)
    } finally {
      silent.close()
    }
  })

  it('发送方收到对端 cancel 保留供流授权：对方重新 accept 后卡片恢复传输中', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'pantry-files-out-cancel-'))
    tmpDirs.push(dir)
    const filePath = join(dir, 'payload.bin')
    writeFileSync(filePath, 'payload-data')

    const messenger = new FakeMessenger()
    const transferRepo = new FakeTransferRepo()
    const service = new FilesService({
      selfId: 'node-self',
      messenger: messenger as unknown as Messenger,
      registry: new FakeRegistry(['node-bob'], [CAPS.transferWait]) as unknown as PeerRegistry,
      convRepo: new FakeConvRepo() as unknown as ConvRepo,
      msgRepo: new FakeMsgRepo() as unknown as MsgRepo,
      transferRepo: transferRepo as unknown as TransferRepo,
      groupRepo: undefined,
      tcpPort: 0,
      getSaveDir: () => dir,
      getImagesDir: () => dir,
      bindAddress: '127.0.0.1'
    })
    await service.offerPaths('node-bob', [filePath])
    await waitTick()
    const tid = [...transferRepo.rows.keys()][0]

    // 对端接受后又取消：状态置已取消，但供流授权保留
    messenger.emit(
      'incoming',
      makeEnvelope<FileCtlPayload>(MSG_TYPES.fileCtl, 'node-bob', { op: 'accept', transferId: tid })
    )
    expect(transferRepo.get(tid)?.status).toBe('accepted')
    messenger.emit(
      'incoming',
      makeEnvelope<FileCtlPayload>(MSG_TYPES.fileCtl, 'node-bob', { op: 'cancel', transferId: tid })
    )
    expect(transferRepo.get(tid)?.status).toBe('canceled')

    // 对端点「重新下载」再次 accept → 恢复传输中（证明 outgoing 未被作废）
    messenger.emit(
      'incoming',
      makeEnvelope<FileCtlPayload>(MSG_TYPES.fileCtl, 'node-bob', { op: 'accept', transferId: tid })
    )
    expect(transferRepo.get(tid)?.status).toBe('accepted')

    // 发送方自己取消才是终态：outgoing 作废，对端再 accept 不再恢复
    await service.cancel(tid)
    expect(transferRepo.get(tid)?.status).toBe('canceled')
    messenger.emit(
      'incoming',
      makeEnvelope<FileCtlPayload>(MSG_TYPES.fileCtl, 'node-bob', { op: 'accept', transferId: tid })
    )
    expect(transferRepo.get(tid)?.status).toBe('canceled')
  })
})
