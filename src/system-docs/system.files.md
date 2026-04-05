All paths are relative to the data directory root.

- `read({ path, offset?, limit? })` → string with line-numbered content. Max 2000 lines / 50KB per call. Use `offset` (1-indexed line number) to paginate.
- `write({ path, content })` → success message. Creates parent dirs. Overwrites entire file. UTF-8 text only.
- `writeBinary({ path, base64 })` → success message. Creates parent dirs. Decodes base64 string and writes raw binary.
- `readBinary({ path })` → file is auto-attached to the tool result as an image output you can see directly. The raw base64 data is NOT available to code; returns `{ attached: true, mimeType, size }`. Max 20MB.
- `edit({ path, oldText, newText })` → success message. `oldText` must match exactly once (whitespace-sensitive).
- `ls({ path?, limit? })` → text listing. Dirs have `/` suffix. Default limit 500.
- `mkdir({ path, recursive? })` → void
- `remove({ path, recursive? })` → void
- `find({ pattern, path?, limit? })` → text list of matching paths. Glob patterns (`*`, `**`, `?`). Default limit 1000.
- `grep({ pattern, path?, options? })` → `file:line: content` format. Default limit 100. Options: `{ ignoreCase?, literal?, context?, limit? }`

Path traversal outside the data directory root is blocked. Use `.tmp/` directory for any temporary files.
