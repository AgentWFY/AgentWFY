export type PageInputEventType =
  | 'mouseDown'
  | 'mouseUp'
  | 'mouseMove'
  | 'click'
  | 'mouseWheel'
  | 'keyDown'
  | 'keyUp'
  | 'char'

export type PageInputModifier = 'shift' | 'control' | 'alt' | 'meta'
export type PageInputMouseButton = 'left' | 'middle' | 'right'

export interface PageInputLike {
  type: string
  x?: number
  y?: number
  button?: string
  clickCount?: number
  deltaX?: number
  deltaY?: number
  keyCode?: string
  modifiers?: string[]
}

export interface NormalizedPageInput {
  type: PageInputEventType
  x: number
  y: number
  button?: PageInputMouseButton
  clickCount: number
  deltaX: number
  deltaY: number
  keyCode?: string
  modifiers: PageInputModifier[]
}

export const PAGE_MOUSE_EVENT_TYPES = new Set<PageInputEventType>(['mouseDown', 'mouseUp', 'mouseMove'])
export const PAGE_KEY_EVENT_TYPES = new Set<PageInputEventType>(['keyDown', 'keyUp', 'char'])
export const SUPPORTED_PAGE_INPUT_TYPES: PageInputEventType[] = [
  'click',
  'mouseDown',
  'mouseUp',
  'mouseMove',
  'mouseWheel',
  'keyDown',
  'keyUp',
  'char',
]

const INPUT_TYPE_ALIASES: Record<string, PageInputEventType> = {
  mousedown: 'mouseDown',
  mouseup: 'mouseUp',
  mousemove: 'mouseMove',
  mousewheel: 'mouseWheel',
  keydown: 'keyDown',
  keyup: 'keyUp',
}

const VALID_MODIFIERS = new Set<string>(['shift', 'control', 'alt', 'meta'])
const VALID_BUTTONS = new Set<string>(['left', 'middle', 'right'])

export function normalizePageInput(request: PageInputLike): NormalizedPageInput {
  const type = normalizePageInputType(request.type)
  const x = Math.round(request.x ?? 0)
  const y = Math.round(request.y ?? 0)
  const button = VALID_BUTTONS.has(request.button ?? '')
    ? request.button as PageInputMouseButton
    : undefined
  const clickCount = Math.max(1, Math.floor(request.clickCount ?? 1))
  const modifiers = (request.modifiers || []).filter((modifier): modifier is PageInputModifier => {
    return VALID_MODIFIERS.has(modifier)
  })

  if (PAGE_KEY_EVENT_TYPES.has(type) && (typeof request.keyCode !== 'string' || !request.keyCode)) {
    throw new Error('keyCode is required for keyboard input events')
  }

  return {
    type,
    x,
    y,
    button,
    clickCount,
    deltaX: request.deltaX ?? 0,
    deltaY: request.deltaY ?? 0,
    ...(request.keyCode ? { keyCode: request.keyCode } : {}),
    modifiers,
  }
}

export function normalizePageInputType(type: string): PageInputEventType {
  const normalized = INPUT_TYPE_ALIASES[type] ?? type
  if (SUPPORTED_PAGE_INPUT_TYPES.includes(normalized as PageInputEventType)) {
    return normalized as PageInputEventType
  }
  throw new Error(`Unknown input event type: ${type}. Supported types: ${SUPPORTED_PAGE_INPUT_TYPES.join(', ')}`)
}
