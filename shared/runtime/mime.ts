import path from 'path'

// Binary content types only — file_ops.read uses absence of an entry here
// (octet-stream fallback) to mean "read as text". Don't add text/* entries
// without also reviewing file_ops.read's binary-detection branch.
const MIME_BY_EXT: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.bmp': 'image/bmp',
  '.ico': 'image/x-icon',
  '.pdf': 'application/pdf',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.ogg': 'audio/ogg',
  '.ogv': 'video/ogg',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
}

export function mimeFromPath(filePath: string): string {
  const ext = path.extname(filePath).toLowerCase()
  return MIME_BY_EXT[ext] ?? 'application/octet-stream'
}
