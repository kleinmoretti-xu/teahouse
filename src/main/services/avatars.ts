import { EventEmitter } from 'node:events'
import {
  CAPS,
  MSG_TYPES,
  isAvatarHash,
  type AvatarPayload,
  type Envelope,
  type GroupPayload,
  type Profile
} from '../../shared/protocol'
import { makeEnvelope } from '../net/codec'
import type { Messenger } from '../net/messenger'
import type { PeerRegistry } from '../net/peer-registry'
import type { GroupRepo } from '../store/group-repo'
import { AvatarStore } from './avatar-store'

const AVATAR_REQUEST_TIMEOUT = 10_000

export interface AvatarServiceDeps {
  selfId: string
  messenger: Messenger
  registry: PeerRegistry
  groupRepo: GroupRepo
  store: AvatarStore
  getSelfProfile: () => Profile
}

/** 自定义头像按需获取与授权服务；图片正文只记录哈希、字节数等元数据。 */
export class AvatarService extends EventEmitter {
  private readonly pending = new Map<string, ReturnType<typeof setTimeout>>()

  constructor(private readonly deps: AvatarServiceDeps) {
    super()
    deps.messenger.on('incoming', (env: Envelope) => {
      if (env.type === MSG_TYPES.avatar) void this.handle(env as Envelope<AvatarPayload>)
      if (env.type === MSG_TYPES.group) {
        const payload = env.payload as GroupPayload
        if (payload.op === 'info') {
          queueMicrotask(() => void this.ensureGroup(payload.group.groupId, env.from))
        }
      }
    })
    deps.registry.on('online', (nodeId: string) => {
      void this.ensurePeer(nodeId)
      for (const group of deps.groupRepo.list()) {
        if (group.members.includes(nodeId)) void this.ensureGroup(group.groupId, nodeId)
      }
    })
  }

  ensureAll(): void {
    for (const record of this.deps.registry.values()) void this.ensurePeer(record.profile.nodeId)
    for (const group of this.deps.groupRepo.list()) void this.ensureGroup(group.groupId)
  }

  async ensurePeer(nodeId: string): Promise<void> {
    const record = this.deps.registry.get(nodeId)
    const hash = record?.profile.avatarHash
    if (
      !record?.online ||
      !isAvatarHash(hash) ||
      !record.profile.caps.includes(CAPS.avatarImages) ||
      (await this.deps.store.has(hash)) ||
      !this.begin(hash)
    ) {
      return
    }
    const ok = await this.deps.messenger.sendReliable(
      nodeId,
      makeEnvelope<AvatarPayload>(MSG_TYPES.avatar, this.deps.selfId, { op: 'get', hash })
    )
    if (!ok) this.finish(hash)
  }

  async ensureGroup(groupId: string, preferredSource?: string): Promise<void> {
    const group = this.deps.groupRepo.get(groupId)
    const hash = group?.avatarHash
    if (
      !group ||
      !group.members.includes(this.deps.selfId) ||
      !isAvatarHash(hash) ||
      (await this.deps.store.has(hash)) ||
      !this.begin(hash)
    ) {
      return
    }

    const sources = group.members
      .filter((id) => id !== this.deps.selfId)
      .filter((id) => {
        const peer = this.deps.registry.get(id)
        return peer?.online && peer.profile.caps.includes(CAPS.avatarImages)
      })
      .sort((a, b) => Number(b === preferredSource) - Number(a === preferredSource))

    for (const source of sources) {
      const ok = await this.deps.messenger.sendReliable(
        source,
        makeEnvelope<AvatarPayload>(MSG_TYPES.avatar, this.deps.selfId, {
          op: 'get',
          hash,
          groupId
        })
      )
      if (ok) return
    }
    this.finish(hash)
  }

  private begin(hash: string): boolean {
    if (this.pending.has(hash)) return false
    const timer = setTimeout(() => this.finish(hash), AVATAR_REQUEST_TIMEOUT)
    timer.unref?.()
    this.pending.set(hash, timer)
    return true
  }

  private finish(hash: string): void {
    const timer = this.pending.get(hash)
    if (timer) clearTimeout(timer)
    this.pending.delete(hash)
  }

  private async handle(env: Envelope<AvatarPayload>): Promise<void> {
    const payload = env.payload
    if (payload.op === 'get') {
      await this.serve(env.from, payload)
      return
    }
    await this.accept(env.from, payload)
  }

  private async serve(peerId: string, payload: Extract<AvatarPayload, { op: 'get' }>): Promise<void> {
    const requester = this.deps.registry.get(peerId)
    if (!requester?.online || !requester.profile.caps.includes(CAPS.avatarImages)) return

    if (payload.groupId) {
      const group = this.deps.groupRepo.get(payload.groupId)
      if (
        !group ||
        !group.members.includes(this.deps.selfId) ||
        !group.members.includes(peerId) ||
        group.avatarHash !== payload.hash
      ) {
        return
      }
    } else if (this.deps.getSelfProfile().avatarHash !== payload.hash) {
      return
    }

    const bytes = await this.deps.store.read(payload.hash)
    if (!bytes) return
    await this.deps.messenger.sendReliable(
      peerId,
      makeEnvelope<AvatarPayload>(MSG_TYPES.avatar, this.deps.selfId, {
        op: 'data',
        hash: payload.hash,
        bytesBase64: bytes.toString('base64'),
        ...(payload.groupId ? { groupId: payload.groupId } : {})
      })
    )
  }

  private async accept(peerId: string, payload: Extract<AvatarPayload, { op: 'data' }>): Promise<void> {
    if (payload.groupId) {
      const group = this.deps.groupRepo.get(payload.groupId)
      if (
        !group ||
        !group.members.includes(this.deps.selfId) ||
        !group.members.includes(peerId) ||
        group.avatarHash !== payload.hash
      ) {
        return
      }
    } else {
      const source = this.deps.registry.get(peerId)
      if (source?.profile.avatarHash !== payload.hash) return
    }

    const bytes = Buffer.from(payload.bytesBase64, 'base64')
    if (!(await this.deps.store.import(payload.hash, bytes))) return
    this.finish(payload.hash)
    this.emit('ready', payload.hash)
  }
}
