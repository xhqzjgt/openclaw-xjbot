import fs from "node:fs";
import path from "node:path";

interface AttachmentResult {
  file_id: string;
  file_name: string;
  file_type: "image" | "video" | "audio" | "file";
  mime_type: string;
  size_bytes: number;
  url: string;
}

const mimeTypes: Record<string, string> = {
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".png": "image/png",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".svg": "image/svg+xml",
  ".mp4": "video/mp4",
  ".webm": "video/webm",
  ".mp3": "audio/mpeg",
  ".wav": "audio/wav",
  ".ogg": "audio/ogg",
  ".pdf": "application/pdf",
  ".txt": "text/plain",
};

function guessMimeType(fileName: string): string {
  const ext = path.extname(fileName).toLowerCase();
  return mimeTypes[ext] || "application/octet-stream";
}

/**
 * Upload a local file to the Super Agent server and return attachment metadata.
 * Supports both local file paths and remote URLs (downloads first then uploads).
 */
export async function uploadLocalFile(
  serverUrl: string,
  token: string,
  filePathOrUrl: string,
): Promise<AttachmentResult | null> {
  let buffer: Buffer;
  let fileName: string;

  if (filePathOrUrl.startsWith("http://") || filePathOrUrl.startsWith("https://")) {
    // Remote URL — download to memory first
    const res = await fetch(filePathOrUrl);
    if (!res.ok) throw new Error(`HTTP ${res.status} fetching ${filePathOrUrl.slice(0, 100)}`);
    buffer = Buffer.from(await res.arrayBuffer());
    try {
      const pathname = new URL(filePathOrUrl).pathname;
      fileName = path.basename(pathname) || "image.jpg";
    } catch {
      fileName = "image.jpg";
    }
  } else {
    // Local file path
    buffer = await fs.promises.readFile(filePathOrUrl);
    fileName = path.basename(filePathOrUrl);
  }

  const mimeType = guessMimeType(fileName);
  const baseUrl = serverUrl.replace(/\/$/, "");

  // Try presign (OSS direct upload) first, fallback to multipart upload
  try {
    return await uploadDirect(baseUrl, token, buffer, fileName, mimeType);
  } catch (err) {
    const msg = err instanceof Error ? err.message : "";
    if (msg === "presign_not_supported" || msg === "presign_failed") {
      return await uploadViaServer(baseUrl, token, buffer, fileName, mimeType);
    }
    throw err;
  }
}

async function uploadDirect(
  baseUrl: string,
  token: string,
  buffer: Buffer,
  fileName: string,
  mimeType: string,
): Promise<AttachmentResult | null> {
  // Step 1: presign
  const presignResp = await fetch(`${baseUrl}/api/v1/files/presign`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: JSON.stringify({ file_name: fileName, size: buffer.length, mime_type: mimeType }),
  });
  if (!presignResp.ok) throw new Error("presign_failed");

  const presignData = (await presignResp.json()) as Record<string, string>;
  if (presignData.storage_mode === "local") throw new Error("presign_not_supported");

  // Step 2: PUT to OSS
  const putResp = await fetch(presignData.upload_url, {
    method: "PUT",
    headers: { "Content-Type": mimeType },
    body: new Uint8Array(buffer),
  });
  if (!putResp.ok) throw new Error(`OSS upload failed (${putResp.status})`);

  // Step 3: register
  const registerResp = await fetch(`${baseUrl}/api/v1/files/register`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: JSON.stringify({
      object_key: presignData.object_key,
      file_name: fileName,
      mime_type: mimeType,
      size: buffer.length,
    }),
  });
  if (!registerResp.ok) throw new Error(`register failed (${registerResp.status})`);

  return extractAttachment(await registerResp.json());
}

async function uploadViaServer(
  baseUrl: string,
  token: string,
  buffer: Buffer,
  fileName: string,
  mimeType: string,
): Promise<AttachmentResult | null> {
  const formData = new FormData();
  const blob = new Blob([new Uint8Array(buffer)], { type: mimeType });
  formData.append("files", blob, fileName);

  const resp = await fetch(`${baseUrl}/api/v1/files/upload`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}` },
    body: formData,
  });

  if (!resp.ok) {
    const err = await resp.text().catch(() => "upload failed");
    throw new Error(`upload failed (${resp.status}): ${err}`);
  }

  return extractAttachment(await resp.json());
}

function extractAttachment(data: unknown): AttachmentResult | null {
  const d = data as { attachments?: Array<Record<string, unknown>> };
  const atts = d.attachments;
  if (!atts || atts.length === 0) return null;

  const att = atts[0];
  return {
    file_id: att.file_id as string,
    file_name: att.file_name as string,
    file_type: att.file_type as AttachmentResult["file_type"],
    mime_type: att.mime_type as string,
    size_bytes: att.size_bytes as number,
    url: att.url as string,
  };
}
