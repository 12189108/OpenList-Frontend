import { password } from "~/store"
import { EmptyResp } from "~/types"
import { r } from "~/utils"
import { asyncPool } from "~/utils/async_pool"
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
  code: number
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
  localStorage.setItem(SESSION_STORAGE_KEY, JSON.stringify(store))
}

const getSessionKey = (uploadPath: string, file: File) =>
  `${uploadPath}::${file.size}::${file.lastModified}`

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

const ensureSuccess = <T>(resp: ApiResp<T>): T => {
  if (resp.code !== 200) {
    throw new Error(resp.message)
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
  if (resp.code !== 200) return undefined
  return resp.data
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

const legacyStreamUpload = async (
  uploadPath: string,
  file: File,
  setUpload: SetUpload,
  asTask = false,
  overwrite = false,
  rapid = false,
  precomputedHashes?: FileHashes,
): Promise<undefined> => {
  let oldTimestamp = Date.now()
  let oldLoaded = 0
  const headers: Record<string, any> = {
    "File-Path": encodeURIComponent(uploadPath),
    "As-Task": asTask,
    "Content-Type": file.type || "application/octet-stream",
    "Last-Modified": file.lastModified,
    Password: password(),
    Overwrite: overwrite.toString(),
  }
  if (rapid) {
    const { sha256 } =
      precomputedHashes ??
      (await calculateHash(file, (p) => {
        setUpload("progress", p | 0)
      }))
    headers["X-File-Sha256"] = sha256
  }
  setUpload("status", "uploading")
  const resp: EmptyResp = await r.put("/fs/put", file, {
    headers,
    onUploadProgress: (progressEvent) => {
      if (!progressEvent.total) return
      const complete = ((progressEvent.loaded / progressEvent.total) * 100) | 0
      setUpload("progress", complete)

      const timestamp = Date.now()
      const duration = (timestamp - oldTimestamp) / 1000
      if (duration > 1) {
        const loaded = progressEvent.loaded - oldLoaded
        const speed = loaded / duration
        setUpload("speed", speed)
        oldTimestamp = timestamp
        oldLoaded = progressEvent.loaded
      }

      if (complete === 100) {
        setUpload("status", "backending")
      }
    },
  })
  if (resp.code === 200) return
  throw new Error(resp.message)
}

export const StreamUpload: Upload = async (
  uploadPath: string,
  file: File,
  setUpload: SetUpload,
  asTask = false,
  overwrite = false,
  rapid = false,
): Promise<undefined> => {
  if (file.size <= 0) {
    return legacyStreamUpload(
      uploadPath,
      file,
      setUpload,
      asTask,
      overwrite,
      rapid,
    )
  }

  let hashes: FileHashes | undefined
  try {
    setUpload("status", "hashing")
    setUpload("hint", undefined)
    const hashResult = await calculateHash(file, (p) => {
      setUpload("progress", p | 0)
    })
    hashes = { sha256: hashResult.sha256 }

    const storedSession = getStoredSession(uploadPath, file)
    let session = storedSession
      ? await getChunkSession(storedSession.uploadId)
      : undefined

    const sessionMatches =
      !!session &&
      session.path === uploadPath &&
      session.size === file.size &&
      session.hashes.sha256 === hashes.sha256

    const resumed = sessionMatches && (session.uploaded_chunks?.length ?? 0) > 0

    if (!sessionMatches) {
      session = await initChunkSession(uploadPath, file, hashes, overwrite)
      setStoredSession(uploadPath, file, session.upload_id)
    }

    const uploaded = new Set(session.uploaded_chunks || [])
    const chunkLoadedMap = new Map<number, number>()
    for (let i = 0; i < session.total_chunks; i++) {
      if (!uploaded.has(i)) continue
      const start = i * session.chunk_size
      const end = Math.min(start + session.chunk_size, file.size)
      chunkLoadedMap.set(i, end - start)
    }

    const speedState = {
      oldTimestamp: Date.now(),
      oldLoaded: 0,
    }

    const updateOverallProgress = () => {
      let loaded = 0
      for (const value of chunkLoadedMap.values()) {
        loaded += value
      }
      setUpload("progress", Math.floor((loaded / file.size) * 100))
      setSpeed(loaded, file.size, setUpload, speedState)
      return loaded
    }

    speedState.oldLoaded = updateOverallProgress()
    setUpload("status", "uploading")
    if (resumed) {
      setUpload(
        "hint",
        `已恢复续传，已上传 ${session.uploaded_chunks.length}/${session.total_chunks} 个分片`,
      )
    } else {
      setUpload("hint", `分片上传 0/${session.total_chunks}`)
    }

    const pendingChunkIndexes = Array.from(
      { length: session.total_chunks },
      (_, index) => index,
    ).filter((index) => !uploaded.has(index))

    let uploadedChunkCount = session.uploaded_chunks.length
    for await (const _ of asyncPool(
      CHUNK_CONCURRENCY,
      pendingChunkIndexes,
      async (chunkIndex) => {
        const start = chunkIndex * session!.chunk_size
        const end = Math.min(start + session!.chunk_size, file.size)
        const chunk = file.slice(start, end)
        chunkLoadedMap.set(chunkIndex, 0)
        await uploadChunk(
          session!.upload_id,
          chunkIndex,
          chunk,
          file,
          (index, loaded) => {
            chunkLoadedMap.set(index, loaded)
            updateOverallProgress()
          },
        )
        uploadedChunkCount += 1
        setUpload("hint", `分片上传 ${uploadedChunkCount}/${session!.total_chunks}`)
      },
    )) {
      // consume async pool results
    }

    setUpload("status", "backending")
    setUpload("hint", undefined)
    await completeChunkSession(session.upload_id, asTask)
    clearStoredSession(uploadPath, file)
    setUpload("progress", 100)
    setUpload("speed", 0)
    return
  } catch (error) {
    console.error("chunk upload failed, fallback to legacy upload", error)
    clearStoredSession(uploadPath, file)
    setUpload("hint", undefined)
    return legacyStreamUpload(
      uploadPath,
      file,
      setUpload,
      asTask,
      overwrite,
      true,
      hashes,
    )
  }
}
