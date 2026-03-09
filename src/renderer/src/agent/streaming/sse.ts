/**
 * Generic SSE (Server-Sent Events) line parser.
 * Parses a fetch Response body into an async iterable of SSE events.
 */

export interface SSEEvent {
  event?: string
  data: string
}

export async function* parseSSE(response: Response): AsyncGenerator<SSEEvent> {
  if (!response.body) {
    throw new Error('Response body is null')
  }

  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  let currentEvent: string | undefined
  let dataLines: string[] = []

  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break

      buffer += decoder.decode(value, { stream: true })

      const lines = buffer.split('\n')
      // Keep the last incomplete line in the buffer
      buffer = lines.pop() ?? ''

      for (let line of lines) {
        // Strip trailing \r to handle CRLF line endings
        if (line.endsWith('\r')) {
          line = line.slice(0, -1)
        }
        if (line === '') {
          // Empty line = end of event
          if (dataLines.length > 0) {
            yield { event: currentEvent, data: dataLines.join('\n') }
            dataLines = []
            currentEvent = undefined
          }
          continue
        }

        if (line.startsWith(':')) {
          // Comment, skip
          continue
        }

        const colonIndex = line.indexOf(':')
        if (colonIndex === -1) {
          // Field with no value
          continue
        }

        const field = line.slice(0, colonIndex)
        // Strip leading space after colon per SSE spec
        let value_str = line.slice(colonIndex + 1)
        if (value_str.startsWith(' ')) {
          value_str = value_str.slice(1)
        }

        switch (field) {
          case 'event':
            currentEvent = value_str
            break
          case 'data':
            dataLines.push(value_str)
            break
          // Ignore 'id', 'retry', etc.
        }
      }
    }

    // Finalize decoder and process any remaining buffer content
    buffer += decoder.decode(new Uint8Array(), { stream: false })
    if (buffer) {
      // Process the final incomplete line
      const line = buffer
      if (line !== '' && !line.startsWith(':')) {
        const colonIndex = line.indexOf(':')
        if (colonIndex !== -1) {
          const field = line.slice(0, colonIndex)
          let value_str = line.slice(colonIndex + 1)
          if (value_str.startsWith(' ')) {
            value_str = value_str.slice(1)
          }
          if (field === 'event') {
            currentEvent = value_str
          } else if (field === 'data') {
            dataLines.push(value_str)
          }
        }
      }
    }

    // Flush remaining data
    if (dataLines.length > 0) {
      yield { event: currentEvent, data: dataLines.join('\n') }
    }
  } finally {
    reader.releaseLock()
  }
}
