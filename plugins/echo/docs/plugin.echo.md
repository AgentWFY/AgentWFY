# plugin.echo

Echo test plugin. Provides two functions for verifying plugin connectivity.

## echoTest(params)

Returns the input back with a timestamp.

```js
const result = await echoTest({ message: 'hello' })
// → { echoed: { message: 'hello' }, timestamp: 1710000000000 }
```

## echoRepeat(params)

Repeats a text string.

- `params.text` — string to repeat
- `params.count` — number of repetitions (default 3)

```js
const result = await echoRepeat({ text: 'hi', count: 2 })
// → { repeated: 'hi hi' }
```
