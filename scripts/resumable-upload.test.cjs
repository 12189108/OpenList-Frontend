const { test } = require("node:test")
const assert = require("node:assert/strict")
const fs = require("node:fs")
const vm = require("node:vm")
const path = require("node:path")
const ts = require("typescript")

const source = fs.readFileSync(
  path.join(__dirname, "../src/pages/home/uploads/resumable.ts"),
  "utf8",
)
const compiled = ts.transpileModule(source, {
  compilerOptions: {
    module: ts.ModuleKind.CommonJS,
    target: ts.ScriptTarget.ES2022,
  },
}).outputText
const chunkSize = 25 * 1024 * 1024
const key = "openlist_chunk_upload_sessions"

function harness({
  initCode = 200,
  failChunk,
  statusCode,
  uploaded = [],
  noStorage = false,
  size = chunkSize * 4 + 3,
} = {}) {
  const storage = new Map()
  const have = new Set(uploaded)
  const calls = []
  const hints = []
  let active = 0
  let fallback = 0
  let fail = failChunk
  const file = {
    size,
    lastModified: 123,
    type: "text/plain",
    slice: (start, end) => ({ size: end - start }),
  }
  const session = () => ({
    upload_id: "persistent-id",
    path: "/user-base/file.bin",
    size,
    hashes: { sha256: "hash" },
    chunk_size: chunkSize,
    total_chunks: Math.ceil(size / chunkSize),
    uploaded_chunks: [...have],
  })
  const r = {
    post: async (url) => {
      calls.push(url)
      if (url.endsWith("/init"))
        return { code: initCode, message: "init rejected", data: session() }
      assert.equal(active, 0, "completion raced an outstanding chunk")
      return { code: 200, data: session() }
    },
    get: async (url) => {
      calls.push(url)
      return {
        code: statusCode ?? 200,
        message: "status rejected",
        data: session(),
      }
    },
    put: async (url, blob, options) => {
      const index = options.params.chunk_index
      calls.push(`chunk:${index}`)
      active++
      await new Promise((resolve) => setTimeout(resolve, index === 1 ? 2 : 10))
      active--
      if (index === fail)
        return { code: undefined, message: "network interrupted" }
      have.add(index)
      options.onUploadProgress({ loaded: blob.size })
      return { code: 200, data: session() }
    },
  }
  const exports = {}
  vm.runInNewContext(compiled, {
    exports,
    setTimeout,
    console,
    localStorage: {
      getItem: (k) => storage.get(k),
      setItem: (k, value) => {
        if (noStorage) throw new Error("storage unavailable")
        storage.set(k, value)
      },
    },
    require: (name) => {
      if (name === "~/store") return { password: () => "" }
      if (name === "~/utils") return { r, api: "https://example.invalid" }
      if (name === "./stream")
        return {
          StreamUpload: async () => {
            fallback++
          },
        }
      if (name === "./util")
        return { calculateHash: async () => ({ sha256: "hash" }) }
      throw new Error(`unexpected import ${name}`)
    },
  })
  const upload = () =>
    exports.ResumableUpload(
      "/file.bin",
      file,
      (name, value) => {
        if (name === "hint") hints.push(value)
      },
      false,
      false,
      false,
    )
  return {
    upload,
    calls,
    hints,
    storage,
    have,
    active: () => active,
    fallback: () => fallback,
    retry: () => {
      fail = undefined
    },
  }
}

test("network failure preserves the session and a retry skips persisted chunks", async () => {
  const h = harness({ failChunk: 1 })
  await assert.rejects(h.upload(), /network interrupted/)
  assert.equal(h.active(), 0)
  assert.equal(h.fallback(), 0)
  assert.equal(h.calls.includes("/fs/chunk/complete"), false)
  assert.equal(Object.keys(JSON.parse(h.storage.get(key))).length, 1)
  const alreadyUploaded = [...h.have]
  h.calls.length = 0
  h.retry()
  await h.upload()
  assert.ok(h.calls.includes("/fs/chunk/status"))
  assert.equal(
    h.calls.includes("/fs/chunk/init"),
    false,
    "absolute base path must not invalidate the session",
  )
  for (const index of alreadyUploaded)
    assert.equal(h.calls.includes(`chunk:${index}`), false)
  assert.deepEqual(JSON.parse(h.storage.get(key)), {})
})

test("only an unsupported init endpoint falls back to plain stream", async () => {
  for (const code of [404, 405, 501]) {
    const h = harness({ initCode: code })
    await h.upload()
    assert.equal(h.fallback(), 1)
  }
  for (const code of [403, 500]) {
    const h = harness({ initCode: code })
    await assert.rejects(h.upload(), /init rejected/)
    assert.equal(h.fallback(), 0)
  }
})

test("server-discovered sessions resume without browser storage", async () => {
  const h = harness({ uploaded: [0, 1], noStorage: true })
  await h.upload()
  assert.equal(h.calls.includes("chunk:0"), false)
  assert.equal(h.calls.includes("chunk:1"), false)
  assert.ok(h.hints.some((hint) => hint?.includes("已恢复续传")))
})

test("status permission errors keep the browser session and do not reinitialize", async () => {
  const h = harness({ failChunk: 1, statusCode: 403 })
  await assert.rejects(h.upload())
  const saved = h.storage.get(key)
  h.calls.length = 0
  await assert.rejects(h.upload(), /status rejected/)
  assert.equal(h.storage.get(key), saved)
  assert.equal(h.calls.includes("/fs/chunk/init"), false)
  assert.equal(h.fallback(), 0)
})

test("empty files use ordinary stream upload", async () => {
  const h = harness({ size: 0 })
  await h.upload()
  assert.equal(h.fallback(), 1)
  assert.deepEqual(h.calls, [])
})
