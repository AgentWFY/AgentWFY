/**
 * Lightweight markdown-to-HTML renderer for LLM chat output.
 * Zero dependencies. Covers all standard + GFM markdown features.
 */

function esc(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

function inline(text: string): string {
  // 1. Protect escaped characters
  const escapes: string[] = []
  text = text.replace(/\\([\\`*_{}[\]()#+\-.!~|>])/g, (_, ch) => {
    escapes.push(ch)
    return `\x00E${escapes.length - 1}\x00`
  })

  // 2. Protect code spans (double-backtick first, then single)
  const codes: string[] = []
  text = text.replace(/``(.+?)``/g, (_, c) => {
    codes.push(`<code>${esc(c.trim())}</code>`)
    return `\x00C${codes.length - 1}\x00`
  })
  text = text.replace(/`([^`\n]+)`/g, (_, c) => {
    codes.push(`<code>${esc(c)}</code>`)
    return `\x00C${codes.length - 1}\x00`
  })

  // 3. Protect images and links (before HTML escaping to handle quotes/URLs cleanly)
  const anchors: string[] = []
  // Images: ![alt](url "title")
  text = text.replace(
    /!\[([^\]]*)\]\(([^)\s]+)(?:\s+"([^"]*)")?\)/g,
    (_, alt, url, title) => {
      anchors.push(
        `<img src="${esc(url)}" alt="${esc(alt)}"${title ? ` title="${esc(title)}"` : ''}>`
      )
      return `\x00A${anchors.length - 1}\x00`
    }
  )
  // Links: [text](url "title")
  text = text.replace(
    /\[([^\]]+)\]\(([^)\s]+)(?:\s+"([^"]*)")?\)/g,
    (_, label, url, title) => {
      anchors.push(
        `<a href="${esc(url)}"${title ? ` title="${esc(title)}"` : ''}>${esc(label)}</a>`
      )
      return `\x00A${anchors.length - 1}\x00`
    }
  )

  // 4. Escape HTML
  text = esc(text)

  // 5. Autolinks: <https://...> and <email@domain>
  text = text.replace(/&lt;(https?:\/\/[^\s&]+)&gt;/g, '<a href="$1">$1</a>')
  text = text.replace(
    /&lt;([a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,})&gt;/g,
    '<a href="mailto:$1">$1</a>'
  )

  // 6. Bold + Italic
  text = text.replace(/\*{3}(.+?)\*{3}/gs, '<strong><em>$1</em></strong>')
  text = text.replace(/_{3}(.+?)_{3}/gs, '<strong><em>$1</em></strong>')

  // 7. Bold
  text = text.replace(/\*{2}(.+?)\*{2}/gs, '<strong>$1</strong>')
  text = text.replace(/_{2}(.+?)_{2}/gs, '<strong>$1</strong>')

  // 8. Italic
  text = text.replace(/\*(.+?)\*/gs, '<em>$1</em>')
  text = text.replace(/(?<![a-zA-Z0-9])_(.+?)_(?![a-zA-Z0-9])/gs, '<em>$1</em>')

  // 9. Strikethrough
  text = text.replace(/~~(.+?)~~/gs, '<del>$1</del>')

  // 10. Line breaks
  text = text.replace(/ {2,}\n/g, '<br>')
  text = text.replace(/\\\n/g, '<br>')
  text = text.replace(/\n/g, ' ')

  // 11. Restore code spans
  text = text.replace(/\x00C(\d+)\x00/g, (_, i) => codes[parseInt(i)])

  // 12. Restore images/links
  text = text.replace(/\x00A(\d+)\x00/g, (_, i) => anchors[parseInt(i)])

  // 13. Restore escaped characters
  text = text.replace(/\x00E(\d+)\x00/g, (_, i) => esc(escapes[parseInt(i)]))

  return text
}

// --- Table helpers ---

function tableRow(line: string): string[] {
  return line.replace(/^\||\|$/g, '').split('|').map(c => c.trim())
}

function tableAligns(line: string): (string | null)[] {
  return line
    .replace(/^\||\|$/g, '')
    .split('|')
    .map(c => {
      const t = c.trim()
      const left = t.startsWith(':')
      const right = t.endsWith(':')
      if (left && right) return 'center'
      if (right) return 'right'
      if (left) return 'left'
      return null
    })
}

// --- List parser ---

interface ListResult {
  html: string
  end: number
}

function parseList(lines: string[], start: number): ListResult {
  const baseIndent = (lines[start].match(/^(\s*)/) ?? ['', ''])[1].length
  const isOl = /^\s*\d+[.)]\s/.test(lines[start])
  const tag = isOl ? 'ol' : 'ul'
  const markerRe = isOl ? /^\s*\d+[.)]\s+(.*)/ : /^\s*[-*+]\s+(.*)/

  let html = `<${tag}>`
  let hasOpenLi = false
  let i = start

  while (i < lines.length) {
    const line = lines[i]

    if (line.trim() === '') {
      i++
      continue
    }

    const indent = (line.match(/^(\s*)/) ?? ['', ''])[1].length

    if (indent < baseIndent) break

    if (indent > baseIndent) {
      if (/^\s*(?:[-*+]|\d+[.)])\s+/.test(line)) {
        // Nested list
        if (!hasOpenLi) {
          html += '<li>'
          hasOpenLi = true
        }
        const nested = parseList(lines, i)
        html += nested.html
        i = nested.end
      } else {
        // Continuation text
        if (hasOpenLi) {
          html += ' ' + inline(line.trim())
        }
        i++
      }
      continue
    }

    // Same indent — list item
    const match = line.match(markerRe)
    if (!match) break

    if (hasOpenLi) html += '</li>'

    // Task list checkbox
    let content = match[1]
    let checkbox = ''
    const taskMatch = content.match(/^\[([ xX])\]\s+(.*)/)
    if (taskMatch) {
      const checked = taskMatch[1] !== ' ' ? ' checked disabled' : ' disabled'
      checkbox = `<input type="checkbox"${checked}> `
      content = taskMatch[2]
    }

    html += `<li>${checkbox}${inline(content)}`
    hasOpenLi = true
    i++
  }

  if (hasOpenLi) html += '</li>'
  html += `</${tag}>`
  return { html, end: i }
}

// --- Block-level detection ---

function isBlockStart(lines: string[], i: number): boolean {
  const line = lines[i]
  if (/^(`{3,}|~{3,})/.test(line)) return true
  if (/^#{1,6}\s/.test(line)) return true
  if (/^[ ]{0,3}([-*_])[ ]*(\1[ ]*){2,}$/.test(line)) return true
  if (/^\s*(?:[-*+]|\d+[.)])\s+/.test(line)) return true
  if (/^>/.test(line)) return true
  if (
    line.includes('|') &&
    i + 1 < lines.length &&
    /^\|?[\s:]*-+[\s:|-]*$/.test(lines[i + 1])
  )
    return true
  return false
}

// --- Main renderer ---

export function renderMarkdown(src: string): string {
  const lines = src.replace(/\r\n/g, '\n').split('\n')
  const out: string[] = []
  let i = 0

  while (i < lines.length) {
    const line = lines[i]

    // Fenced code block
    const fenceMatch = line.match(/^(`{3,}|~{3,})(\S*)/)
    if (fenceMatch) {
      const fence = fenceMatch[1]
      const lang = fenceMatch[2]
      const codeLines: string[] = []
      i++
      while (i < lines.length && !lines[i].startsWith(fence)) {
        codeLines.push(lines[i])
        i++
      }
      if (i < lines.length) i++
      const cls = lang ? ` class="language-${esc(lang)}"` : ''
      out.push(`<pre><code${cls}>${esc(codeLines.join('\n'))}</code></pre>`)
      continue
    }

    // Heading
    const hMatch = line.match(/^(#{1,6})\s+(.+?)(?:\s+#+\s*)?$/)
    if (hMatch) {
      const lvl = hMatch[1].length
      out.push(`<h${lvl}>${inline(hMatch[2])}</h${lvl}>`)
      i++
      continue
    }

    // Horizontal rule (before list — `---` is HR, `- item` is list)
    if (/^[ ]{0,3}([-*_])[ ]*(\1[ ]*){2,}$/.test(line)) {
      out.push('<hr>')
      i++
      continue
    }

    // Table
    if (
      line.includes('|') &&
      i + 1 < lines.length &&
      /^\|?[\s:]*-+[\s:|-]*$/.test(lines[i + 1])
    ) {
      const headers = tableRow(line)
      const aligns = tableAligns(lines[i + 1])
      let tbl = '<table><thead><tr>'
      headers.forEach((h, j) => {
        const a = aligns[j] ? ` style="text-align:${aligns[j]}"` : ''
        tbl += `<th${a}>${inline(h)}</th>`
      })
      tbl += '</tr></thead><tbody>'
      i += 2
      while (i < lines.length && lines[i].includes('|') && lines[i].trim() !== '') {
        const cells = tableRow(lines[i])
        tbl += '<tr>'
        headers.forEach((_, j) => {
          const a = aligns[j] ? ` style="text-align:${aligns[j]}"` : ''
          tbl += `<td${a}>${inline(cells[j] ?? '')}</td>`
        })
        tbl += '</tr>'
        i++
      }
      tbl += '</tbody></table>'
      out.push(tbl)
      continue
    }

    // Blockquote
    if (/^>/.test(line)) {
      const qLines: string[] = []
      while (i < lines.length && /^>/.test(lines[i])) {
        qLines.push(lines[i].replace(/^>\s?/, ''))
        i++
      }
      out.push(`<blockquote>${renderMarkdown(qLines.join('\n'))}</blockquote>`)
      continue
    }

    // List
    if (/^\s*(?:[-*+]|\d+[.)])\s+/.test(line)) {
      const result = parseList(lines, i)
      out.push(result.html)
      i = result.end
      continue
    }

    // Blank line
    if (line.trim() === '') {
      i++
      continue
    }

    // Paragraph
    const pLines: string[] = []
    while (i < lines.length && lines[i].trim() !== '' && !isBlockStart(lines, i)) {
      pLines.push(lines[i])
      i++
    }
    if (pLines.length > 0) {
      out.push(`<p>${inline(pLines.join('\n'))}</p>`)
    } else {
      i++
    }
  }

  return out.join('\n')
}
