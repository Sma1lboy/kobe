import { api } from "./api-client.ts"

interface UploadResponse {
  url: string
}

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
