/**
 * Issue-asset upload client. Posts an image (pasted/dragged into the issue
 * intake panel or detail drawer) to the bridge's multipart route, which
 * content-addresses it and returns a stable `/api/issue-assets/<hash>/<file>`
 * url. That url is the ONLY shape markdown.ts will render as an `<img>` (see
 * `safeImageSrc`), so the upload + render paths stay XSS-safe by construction.
 */

import { api } from "./api-client.ts"

/** Server-shaped response from POST /api/issue-assets. */
interface UploadResponse {
  url: string
}

/**
 * Upload one file as an issue asset for `repoRoot`, returning its served url.
 *
 * We send `multipart/form-data` and DELIBERATELY do not set `Content-Type` —
 * the browser must set it itself so the multipart boundary is correct (a
 * hand-set header omits the boundary and the server can't parse the body).
 * Throws with the server's error message on a non-ok response.
 */
export async function uploadIssueAsset(
  repoRoot: string,
  file: File,
): Promise<{ url: string }> {
  const form = new FormData()
  form.append("repoRoot", repoRoot)
  form.append("file", file)

  const json = await api.form<Partial<UploadResponse>>(
    "/api/issue-assets",
    form,
    {
      label: "Issue asset upload",
    },
  )
  if (typeof json?.url !== "string" || json.url.length === 0) {
    throw new Error("Issue asset upload returned no url")
  }
  return { url: json.url }
}
