# system.ffmpeg

Run ffmpeg processes from tasks, agent execJs, or views.

## APIs

- `ffmpeg(args)` → `{ id }` — spawn an ffmpeg process with the given arguments array. Returns immediately with a unique process ID. The process runs with `cwd` set to the agent root directory, so relative file paths in args resolve from there.
- `ffmpegKill(id)` → void — send SIGTERM to a running ffmpeg process.

## Streaming Output

Output is streamed via the event bus using two topics per process:

- `ffmpeg:{id}:output` — stdout/stderr chunks: `{ stream: 'stdout' | 'stderr', data: string }`
- `ffmpeg:{id}:done` — process exit: `{ code, signal }` or `{ code: null, signal: null, error: string }` on spawn failure

## Examples

**Run a command and wait for completion:**
```js
const { id } = await ffmpeg(['-i', 'input.mp4', '-vf', 'scale=1280:720', 'output.mp4'])
const result = await waitFor(`ffmpeg:${id}:done`, 300000)
console.log('Exit code:', result.code)
```

**Stream progress output:**
```js
const { id } = await ffmpeg(['-i', 'input.mp4', '-progress', 'pipe:1', 'output.mp4'])
// read output chunks until done
while (true) {
  const msg = await waitFor(`ffmpeg:${id}:output`, 60000)
  console.log(msg.stream, msg.data)
}
```

**Check version:**
```js
const { id } = await ffmpeg(['-version'])
const result = await waitFor(`ffmpeg:${id}:done`, 5000)
```

**Kill a long-running process:**
```js
const { id } = await ffmpeg(['-i', 'input.mp4', '-c:v', 'libx264', 'output.mp4'])
// ... later
await ffmpegKill(id)
```
