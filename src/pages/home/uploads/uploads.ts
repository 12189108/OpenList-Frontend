import { getSettingBool, objStore } from "~/store"
import { FormUpload } from "./form"
import { StreamUpload } from "./stream"
import { HttpDirectUpload } from "./direct"
import { MultipartUpload } from "./multipart"
import { ResumableUpload } from "./resumable"
import { isGo } from "~/utils/backend"
import { Upload } from "./types"

type Uploader = {
  upload: Upload
  name: string
  available: () => boolean
}

// The custom Go uploader persists sessions across server restarts. Official
// multipart and its plain stream fallback remain independent upload methods.
const AllUploads: Uploader[] = [
  {
    name: "Resumable",
    upload: ResumableUpload,
    available: isGo,
  },
  {
    name: "Multipart",
    upload: MultipartUpload,
    available: () => getSettingBool("multipart_enabled"),
  },
  {
    name: "HTTP Direct",
    upload: HttpDirectUpload,
    available: () => {
      return objStore.direct_upload_tools?.includes("HttpDirect") || false
    },
  },
  {
    name: "Stream",
    upload: StreamUpload,
    available: () => true,
  },
  {
    name: "Form",
    upload: FormUpload,
    available: () => true,
  },
]

export const getUploads = (): Pick<Uploader, "name" | "upload">[] => {
  return AllUploads.filter((u) => u.available())
}
