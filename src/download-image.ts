import fs from "node:fs";
import path from "node:path";
import os from "node:os";

const MEDIA_DIR = path.join(os.homedir(), ".openclaw", "media", "inbound");

/**
 * Download a remote image to a local file and return the local path.
 * The SDK's resolveAcpAttachments only reads local files (MediaPaths),
 * so we must download remote URLs first.
 */
export async function downloadImageToLocal(
  url: string,
  filename?: string,
): Promise<string> {
  // Ensure media directory exists
  fs.mkdirSync(MEDIA_DIR, { recursive: true });

  // Generate a unique filename
  const ext = guessExtension(url, filename);
  const baseName = filename
    ? filename.replace(/[^a-zA-Z0-9._-]/g, "_")
    : `img_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const finalName = baseName.endsWith(ext) ? baseName : `${baseName}${ext}`;
  const localPath = path.join(MEDIA_DIR, finalName);

  // Fetch the image
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`HTTP ${res.status} fetching ${url.slice(0, 100)}`);
  }

  const buffer = Buffer.from(await res.arrayBuffer());
  fs.writeFileSync(localPath, buffer);

  return localPath;
}

function guessExtension(url: string, filename?: string): string {
  if (filename) {
    const ext = path.extname(filename);
    if (ext) return ext;
  }
  // Try to extract from URL path (before query params)
  try {
    const pathname = new URL(url).pathname;
    const ext = path.extname(pathname);
    if (ext && ext.length <= 5) return ext;
  } catch {}
  return ".jpg";
}
