import path from 'path';
import { createReadStream } from 'fs';
import { stat } from 'fs/promises';

export function getMimeType(filename: string): string {
  const ext = path.extname(filename).toLowerCase();
  const mimeMap: Record<string, string> = {
    '.mp4': 'video/mp4',
    '.webm': 'video/webm',
    '.ogg': 'video/ogg',
    '.ogv': 'video/ogg',
    '.mp3': 'audio/mpeg',
    '.wav': 'audio/wav',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.gif': 'image/gif',
    '.svg': 'image/svg+xml',
    '.webp': 'image/webp',
  };
  return mimeMap[ext] || 'application/octet-stream';
}

export const nodeStreamToWeb = (nodeStream: import('fs').ReadStream) => {
  nodeStream.pause();
  let closed = false;

  return new ReadableStream({
    start(controller) {
      nodeStream.on('data', (chunk: Buffer) => {
        if (closed) return;
        controller.enqueue(new Uint8Array(chunk));
        if (controller.desiredSize !== null && controller.desiredSize <= 0) {
          nodeStream.pause();
        }
      });
      nodeStream.on('error', (err: unknown) => controller.error(err));
      nodeStream.on('end', () => {
        if (!closed) {
          closed = true;
          controller.close();
        }
      });
    },
    pull() {
      if (!closed) nodeStream.resume();
    },
    cancel() {
      if (!closed) {
        closed = true;
        nodeStream.destroy();
      }
    }
  });
};

export const serveFile = async (request: Request, absolutePath: string) => {
  try {
    const fileStat = await stat(absolutePath);
    const rangeHeader = request.headers.get('Range');

    const headers = new Headers([
      ['Content-Type', getMimeType(absolutePath)],
      ['Accept-Ranges', 'bytes'],
      ['X-Content-Type-Options', 'nosniff'],
    ]);

    if (rangeHeader && rangeHeader.startsWith('bytes=')) {
      const matches = rangeHeader.match(/bytes=(\d*)-(\d*)/);

      if (matches) {
        const startByte = matches[1] ? parseInt(matches[1], 10) : 0;
        const endByte = matches[2] ? parseInt(matches[2], 10) : fileStat.size - 1;

        if (startByte >= fileStat.size || endByte >= fileStat.size) {
          return new Response('Range Not Satisfiable', {
            status: 416,
            headers: { 'Content-Range': `bytes */${fileStat.size}` }
          });
        }

        const chunksize = (endByte - startByte) + 1;
        const stream = createReadStream(absolutePath, { start: startByte, end: endByte });

        headers.set('Content-Range', `bytes ${startByte}-${endByte}/${fileStat.size}`);
        headers.set('Content-Length', chunksize.toString());

        return new Response(nodeStreamToWeb(stream), {
          status: 206,
          headers: headers,
        });
      }
    }

    headers.set('Content-Length', fileStat.size.toString());

    const stream = createReadStream(absolutePath);
    return new Response(nodeStreamToWeb(stream), {
      status: 200,
      headers: headers,
    });

  } catch (error) {
    console.error('File serving error:', error);
    return new Response('Not Found', { status: 404 });
  }
};
