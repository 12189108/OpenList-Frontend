import { password } from "~/store"
import { r, api } from "~/utils"
import { StreamUpload } from "./stream"
import { SetUpload, Upload } from "./types"
import { calculateHash } from "./util"

const CHUNK_SIZE = 25 * 1024 * 1024
const CHUNK_CONCURRENCY = 3
const SESSION_STORAGE_KEY = "openlist_chunk_upload_sessions"

type FileHashes = {
  sha256: string
}

type ChunkSessionResp = {
  upload_id: string
  path: string
  name: string
  size: number
  chunk_size: number
  total_chunks: number
  uploaded_chunks: number[]
  remaining_chunks: number[]
  hashes: FileHashes
  expires_at: number
  completed: boolean
}

type ApiResp<T> = {
  code: number | undefined
  message: string
  data: T
}

type StoredSession = {
  uploadId: string
  uploadPath: string
  size: number
  lastModified: number
}

const getSessionStore = (): Record<string, StoredSession> => {
  try {
    const raw = localStorage.getItem(SESSION_STORAGE_KEY)
    return raw ? JSON.parse(raw) : {}
  } catch {
    return {}
  }
}

const saveSessionStore = (store: Record<string, StoredSession>) => {
  try {
    localStorage.setItem(SESSION_STORAGE_KEY, JSON.stringify(store))
  } catch {
    // The server can rediscover a session by path and hash without local storage.
  }
}

const getSessionKey = (uploadPath: string, file: File) =>
  `${api}::${uploadPath}::${file.size}::${file.lastModified}`

const getStoredSession = (
  uploadPath: string,
  file: File,
): StoredSession | undefined => {
  const store = getSessionStore()
  return store[getSessionKey(uploadPath, file)]
}

const setStoredSession = (uploadPath: string, file: File, uploadId: string) => {
  const store = getSessionStore()
  store[getSessionKey(uploadPath, file)] = {
    uploadId,
    uploadPath,
    size: file.size,
    lastModified: file.lastModified,
  }
  saveSessionStore(store)
}

const clearStoredSession = (uploadPath: string, file: File) => {
  const store = getSessionStore()
  delete store[getSessionKey(uploadPath, file)]
  saveSessionStore(store)
}

const setSpeed = (
  loaded: number,
  total: number,
  setUpload: SetUpload,
  state: { oldTimestamp: number; oldLoaded: number },
) => {
  const timestamp = Date.now()
  const duration = (timestamp - state.oldTimestamp) / 1000
  if (duration <= 1) return
  const currentLoaded = loaded - state.oldLoaded
  const speed = currentLoaded / duration
  if (Number.isFinite(speed)) {
    setUpload("speed", speed)
  }
  state.oldTimestamp = timestamp
  state.oldLoaded = loaded
  if (loaded >= total) {
    setUpload("speed", 0)
  }
}

class UploadApiError extends Error {
  constructor(
    message: string,
    readonly code: number | undefined,
  ) {
    super(message)
  }
}

const ensureSuccess = <T>(resp: ApiResp<T>): T => {
  if (resp.code !== 200) {
    throw new UploadApiError(resp.message, resp.code)
  }
  return resp.data
}

const initChunkSession = async (
  uploadPath: string,
  file: File,
  hashes: FileHashes,
  overwrite: boolean,
) => {
  const resp = await r.post<any, ApiResp<ChunkSessionResp>>(
    "/fs/chunk/init",
    {
      path: uploadPath,
      size: file.size,
      chunk_size: CHUNK_SIZE,
      total_chunks: Math.ceil(file.size / CHUNK_SIZE),
      last_modified: file.lastModified,
      mimetype: file.type || "application/octet-stream",
      sha256: hashes.sha256,
    },
    {
      headers: {
        Password: password(),
        Overwrite: overwrite.toString(),
      },
    },
  )
  return ensureSuccess(resp)
}

const getChunkSession = async (
  uploadId: string,
): Promise<ChunkSessionResp | undefined> => {
  const resp = await r.get<any, ApiResp<ChunkSessionResp>>("/fs/chunk/status", {
    params: { upload_id: uploadId },
  })
  if (resp.code === 404) return undefined
  return ensureSuccess(resp)
}

const uploadChunk = async (
  uploadId: string,
  chunkIndex: number,
  chunk: Blob,
  file: File,
  updateProgress: (chunkIndex: number, loaded: number) => void,
) => {
  const resp = await r.put<any, ApiResp<any>>("/fs/chunk/upload", chunk, {
    params: {
      upload_id: uploadId,
      chunk_index: chunkIndex,
    },
    headers: {
      "Content-Type": file.type || "application/octet-stream",
      Password: password(),
    },
    onUploadProgress: (progressEvent) => {
      updateProgress(chunkIndex, progressEvent.loaded ?? 0)
    },
  })
  ensureSuccess(resp)
  updateProgress(chunkIndex, chunk.size)
}

const completeChunkSession = async (uploadId: string, asTask: boolean) => {
  const resp = await r.post<any, ApiResp<any>>("/fs/chunk/complete", {
    upload_id: uploadId,
    as_task: asTask,
  })
  ensureSuccess(resp)
}

export const ResumableUpload: Upload = async (
  uploadPath,
  file,
  setUpload,
  asTask = false,
  overwrite = false,
  rapid = false,
) => {
  if (file.size <= 0) {
    return StreamUpload(uploadPath, file, setUpload, asTask, overwrite, rapid)
  }

  try {
    setUpload("status", "hashing")
    setUpload("hint", undefined)
    const { sha256 } = await calculateHash(file, (p) => {
      setUpload("progress", p | 0)
    })
    const hashes = { sha256 }
    const stored = getStoredSession(uploadPath, file)
    let session = stored ? await getChunkSession(stored.uploadId) : undefined
    // The server returns an absolute user-joined path. The local key already
    // identifies the requested relative path, so do not compare those strings.
    if (
      session &&
      (session.size !== file.size || session.hashes.sha256 !== sha256)
    ) {
      session = undefined
    }
    if (!session) {
      try {
        session = await initChunkSession(uploadPath, file, hashes, overwrite)
      } catch (error) {
        // Only a missing/unsupported endpoint warrants whole-file fallback.
        // Network, permission and storage errors leave the session resumable.
        if (
          error instanceof UploadApiError &&
          [404, 405, 501].includes(error.code ?? 0)
        ) {
          clearStoredSession(uploadPath, file)
          return StreamUpload(
            uploadPath,
            file,
            setUpload,
            asTask,
            overwrite,
            rapid,
          )
        }
        throw error
      }
    }
    setStoredSession(uploadPath, file, session.upload_id)
    const activeSession = session
    const uploaded = new Set(activeSession.uploaded_chunks ?? [])
    const chunkLoadedMap = new Map<number, number>()
    for (const index of uploaded) {
      const start = index * activeSession.chunk_size
      chunkLoadedMap.set(
        index,
        Math.min(activeSession.chunk_size, file.size - start),
      )
    }
    const speedState = { oldTimestamp: Date.now(), oldLoaded: 0 }
    const updateProgress = (index: number, loaded: number) => {
      chunkLoadedMap.set(index, loaded)
      const total = Array.from(chunkLoadedMap.values()).reduce(
        (a, b) => a + b,
        0,
      )
      setUpload("progress", Math.floor((total / file.size) * 100))
      setSpeed(total, file.size, setUpload, speedState)
    }
    speedState.oldLoaded = Array.from(chunkLoadedMap.values()).reduce(
      (a, b) => a + b,
      0,
    )
    setUpload("progress", Math.floor((speedState.oldLoaded / file.size) * 100))
    setUpload("status", "uploading")
    const pending = Array.from(
      { length: activeSession.total_chunks },
      (_, i) => i,
    ).filter((i) => !uploaded.has(i))
    let completed = uploaded.size
    const showProgress = () =>
      setUpload("hint", `分片上传 ${completed}/${activeSession.total_chunks}`)
    if (completed > 0) {
      setUpload(
        "hint",
        `已恢复续传，已上传 ${completed}/${activeSession.total_chunks} 个分片`,
      )
    } else {
      showProgress()
    }
    let next = 0
    let failure: Error | undefined
    const worker = async () => {
      while (!failure) {
        const position = next++
        if (position >= pending.length) return
        const index = pending[position]
        const start = index * activeSession.chunk_size
        const chunk = file.slice(
          start,
          Math.min(start + activeSession.chunk_size, file.size),
        )
        try {
          await uploadChunk(
            activeSession.upload_id,
            index,
            chunk,
            file,
            updateProgress,
          )
          completed++
          showProgress()
        } catch (error) {
          failure ??= error instanceof Error ? error : new Error(String(error))
        }
      }
    }
    // Wait for every in-flight request before exposing a retry. No abandoned
    // async-pool promises may keep writing while the next attempt starts.
    await Promise.all(
      Array.from(
        { length: Math.min(CHUNK_CONCURRENCY, pending.length) },
        worker,
      ),
    )
    if (failure) throw failure

    setUpload("status", "backending")
    setUpload("speed", 0)
    setUpload("hint", undefined)
    await completeChunkSession(activeSession.upload_id, asTask)
    clearStoredSession(uploadPath, file)
    setUpload("progress", 100)
  } catch (error) {
    setUpload("speed", 0)
    throw error
  }
}
