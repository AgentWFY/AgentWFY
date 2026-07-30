// Encoding and decoding for {@link StreamingDelta} — the incremental form of
// the streaming assistant message.
//
// The message grows for the length of a turn while the sender pushes it at
// ~60fps, so re-sending it whole costs O(n²) serialization per turn. The sender
// keeps a mirror of what the receiver holds and ships only the difference.
//
// Both halves live here because they are one format: a change to the ops must
// land in the differ and the applier together.

import type { Block, DisplayMessage } from './provider_types.js'
import type { StreamingBlockOp } from './types.js'

/** Text length of a block, or -1 for blocks that hold no growing text. Only
 *  `text`/`thinking` blocks are mutated in place; every other block is built
 *  complete and never touched again, so identity settles those. */
export function blockTextLen(block: Block): number {
  return block.type === 'text' || block.type === 'thinking' ? block.text.length : -1
}

/** What the receiver holds for the current streaming message. */
export interface StreamMirror {
  /** The message object the mirror was taken from; a different object means a
   *  different turn, and the whole message has to be sent. */
  ref: DisplayMessage
  blocks: Block[]
  lens: number[]
}

export function mirrorOf(msg: DisplayMessage): StreamMirror {
  return { ref: msg, blocks: msg.blocks.slice(), lens: msg.blocks.map(blockTextLen) }
}

/** Ops that turn `sent` into `blocks`. `prepare` gets a chance to rewrite any
 *  block being sent whole (the desktop uses it to lift binaries out of band).
 *  Empty when nothing moved. */
export function diffStreamBlocks(
  sent: StreamMirror,
  blocks: Block[],
  prepare: (block: Block) => Block = (b) => b,
): StreamingBlockOp[] {
  const ops: StreamingBlockOp[] = []
  for (let i = 0; i < blocks.length; i++) {
    const block = blocks[i]
    if (i >= sent.blocks.length || sent.blocks[i] !== block) {
      ops.push({ op: 'set', index: i, block: prepare(block) })
      continue
    }
    const len = blockTextLen(block)
    if (len === sent.lens[i]) continue
    if (len > sent.lens[i] && (block.type === 'text' || block.type === 'thinking')) {
      ops.push({ op: 'append', index: i, text: block.text.slice(sent.lens[i]) })
    } else {
      ops.push({ op: 'set', index: i, block: prepare(block) })
    }
  }
  if (blocks.length < sent.blocks.length) ops.push({ op: 'trim', length: blocks.length })
  return ops
}

/** Rebuilds the streaming message from a delta's ops. Returns null when an op
 *  doesn't fit what the receiver holds — the caller then keeps its current
 *  message and waits for the next whole one. */
export function applyStreamOps(
  msg: DisplayMessage | null,
  ops: StreamingBlockOp[],
): DisplayMessage | null {
  if (!msg) return null
  const blocks = msg.blocks.slice()
  for (const op of ops) {
    if (op.op === 'trim') {
      if (op.length > blocks.length) return null
      blocks.length = op.length
      continue
    }
    if (op.op === 'set') {
      if (op.index > blocks.length) return null
      blocks[op.index] = op.block
      continue
    }
    const block = blocks[op.index]
    if (!block || (block.type !== 'text' && block.type !== 'thinking')) return null
    // New block object so the render-block cache sees the changed length.
    blocks[op.index] = { ...block, text: block.text + op.text }
  }
  return { ...msg, blocks }
}
