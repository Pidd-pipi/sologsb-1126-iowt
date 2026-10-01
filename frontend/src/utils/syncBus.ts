/**
 * syncBus —— 同浏览器多标签页（规划员 / 领队可能各开一个页签）之间的数据变更通知。
 *
 * 写库动作完成后调用 notifyDataChange()：
 *   - 其它标签页通过 window 'storage' 事件收到，重新拉取四张表，保证版本核对基于最新数据；
 *   - 当前标签页通过 BroadcastChannel 之外的直接监听也会收到（用于统一收口）。
 * 不支持 BroadcastChannel 的环境只靠 storage 事件，功能不受影响。
 */

export type SyncEntity = 'sites' | 'factors' | 'profiles' | 'vetos' | 'conflicts' | 'all'

export interface SyncMessage {
  at: string
  entity: SyncEntity
  reason?: string
}

const STORAGE_KEY = 'gbcampsite:sync-tick'
let channel: BroadcastChannel | null = null
const listeners = new Set<(msg: SyncMessage) => void>()

function getChannel(): BroadcastChannel | null {
  if (channel === null && typeof BroadcastChannel !== 'undefined') {
    channel = new BroadcastChannel('gbcampsite-sync')
    channel.onmessage = (ev: MessageEvent<SyncMessage>) => dispatch(ev.data, false)
  }
  return channel
}

function dispatch(msg: SyncMessage, replay: boolean): void {
  listeners.forEach((fn) => {
    try {
      fn(msg)
    } catch {
      /* 监听方异常不影响其它方 */
    }
  })
  if (replay) return
  // storage 事件只在其它页签触发；本页签由 BroadcastChannel 分发，无需回放
}

/** 订阅数据变更（含本页签与其它页签）。返回取消订阅函数。 */
export function onDataChange(fn: (msg: SyncMessage) => void): () => void {
  listeners.add(fn)
  getChannel()

  function onStorage(ev: StorageEvent): void {
    if (ev.key !== STORAGE_KEY || !ev.newValue) return
    try {
      fn(JSON.parse(ev.newValue) as SyncMessage)
    } catch {
      /* ignore */
    }
  }
  window.addEventListener('storage', onStorage)
  return () => {
    listeners.delete(fn)
    window.removeEventListener('storage', onStorage)
  }
}

/** 写库完成后通知所有页签（含本页签）。 */
export function notifyDataChange(entity: SyncEntity = 'all', reason?: string): void {
  const msg: SyncMessage = { at: new Date().toISOString(), entity, reason }
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(msg))
  } catch {
    /* localStorage 不可用时仍有 BroadcastChannel */
  }
  try {
    getChannel()?.postMessage(msg)
  } catch {
    /* ignore */
  }
  // 本页签直接派发（BroadcastChannel 不回放给发送方）
  listeners.forEach((fn) => {
    try {
      fn(msg)
    } catch {
      /* ignore */
    }
  })
}
