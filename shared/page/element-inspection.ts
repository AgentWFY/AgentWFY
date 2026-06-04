export function buildInspectElementCode(selector: string): string {
  if (typeof selector !== 'string' || !selector.trim()) {
    throw new Error('inspectElement requires a non-empty CSS selector')
  }

  const selectorLiteral = JSON.stringify(selector)
  return `
  const el = document.querySelector(${selectorLiteral});
  if (!el) return { found: false };

  const cs = getComputedStyle(el);
  const rect = el.getBoundingClientRect();

  return {
    found: true,
    tagName: el.tagName.toLowerCase(),
    textContent: (el.textContent || '').trim().slice(0, 500),
    attributes: Object.fromEntries(Array.from(el.attributes).map(a => [a.name, a.value])),
    classes: Array.from(el.classList),
    box: {
      x: rect.x,
      y: rect.y,
      width: rect.width,
      height: rect.height,
      top: rect.top,
      right: rect.right,
      bottom: rect.bottom,
      left: rect.left,
    },
    styles: {
      display: cs.display,
      visibility: cs.visibility,
      opacity: cs.opacity,
      position: cs.position,
      overflow: cs.overflow,
      zIndex: cs.zIndex,
      boxSizing: cs.boxSizing,
      color: cs.color,
      backgroundColor: cs.backgroundColor,
      fontSize: cs.fontSize,
      fontWeight: cs.fontWeight,
      lineHeight: cs.lineHeight,
      textAlign: cs.textAlign,
      border: cs.border,
      borderCollapse: cs.borderCollapse,
      padding: cs.padding,
      margin: cs.margin,
      width: cs.width,
      height: cs.height,
      minWidth: cs.minWidth,
      maxWidth: cs.maxWidth,
      minHeight: cs.minHeight,
      maxHeight: cs.maxHeight,
      cursor: cs.cursor,
      pointerEvents: cs.pointerEvents,
      userSelect: cs.userSelect,
      whiteSpace: cs.whiteSpace,
      textOverflow: cs.textOverflow,
      flexGrow: cs.flexGrow,
      flexShrink: cs.flexShrink,
      gridTemplateColumns: cs.gridTemplateColumns,
    },
    isVisible: cs.display !== 'none'
      && cs.visibility !== 'hidden'
      && parseFloat(cs.opacity) > 0
      && rect.width > 0
      && rect.height > 0,
    isInViewport: rect.top < window.innerHeight
      && rect.bottom > 0
      && rect.left < window.innerWidth
      && rect.right > 0,
    childCount: el.children.length,
    parentTag: el.parentElement ? el.parentElement.tagName.toLowerCase() : null,
  };`
}
