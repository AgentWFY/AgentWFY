module.exports = {
  activate(api) {
    api.registerFunction('echoTest', async (params) => {
      return { echoed: params, timestamp: Date.now() }
    })

    api.registerFunction('echoRepeat', async (params) => {
      const text = params?.text ?? ''
      const count = params?.count ?? 3
      return { repeated: Array(count).fill(text).join(' ') }
    })
  }
}
