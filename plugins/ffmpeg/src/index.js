module.exports = {
  activate(api) {
    const { spawn } = require('child_process')
    const crypto = require('crypto')
    const activeProcesses = new Map()

    api.registerFunction('ffmpeg', async (params) => {
      const args = params?.args
      if (!Array.isArray(args)) {
        throw new Error('ffmpeg requires an args array')
      }

      const id = crypto.randomUUID()
      const outputTopic = 'ffmpeg:' + id + ':output'
      const doneTopic = 'ffmpeg:' + id + ':done'
      const child = spawn('ffmpeg', args, { cwd: api.agentRoot })
      activeProcesses.set(id, child)

      for (const stream of ['stdout', 'stderr']) {
        child[stream].on('data', (chunk) => {
          api.publish(outputTopic, { stream, data: chunk.toString() })
        })
      }

      child.on('close', (code, signal) => {
        activeProcesses.delete(id)
        api.publish(doneTopic, { code, signal })
      })

      child.on('error', (err) => {
        activeProcesses.delete(id)
        api.publish(doneTopic, { code: null, signal: null, error: err.message })
      })

      return { id }
    })

    api.registerFunction('ffmpegKill', async (params) => {
      const id = params?.id
      if (typeof id !== 'string' || !id.trim()) {
        throw new Error('ffmpegKill requires a non-empty id string')
      }

      const child = activeProcesses.get(id)
      if (!child) {
        throw new Error('No active ffmpeg process with id: ' + id)
      }

      child.kill('SIGTERM')
    })

    return {
      deactivate() {
        for (const child of activeProcesses.values()) {
          child.kill('SIGTERM')
        }
        activeProcesses.clear()
      }
    }
  }
}
