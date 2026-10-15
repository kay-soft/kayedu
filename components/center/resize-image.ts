/**
 * Shrinks a picture in the browser before upload (SEC-64, D-27 (b)). A phone
 * photo is routinely 3–8 MB; the server accepts about 1 MB
 * (`MAX_PHOTO_BYTES`, lib/storage-paths.ts), so a larger image is redrawn at
 * most `maxDimension` pixels on its long side and re-encoded as JPEG, lowering
 * the quality until it fits. A file already small enough is sent untouched,
 * and anything the browser cannot decode is sent as-is for the server to
 * refuse with its own message. The server still checks every byte (SEC-54) —
 * this only spares people a failed upload.
 */
export async function shrinkImageForUpload(
  file: File,
  maxBytes: number,
  maxDimension = 1280,
): Promise<File> {
  if (file.size <= maxBytes || typeof createImageBitmap !== "function") return file;

  let bitmap: ImageBitmap;
  try {
    bitmap = await createImageBitmap(file);
  } catch {
    return file;
  }

  const scale = Math.min(1, maxDimension / Math.max(bitmap.width, bitmap.height));
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(bitmap.width * scale));
  canvas.height = Math.max(1, Math.round(bitmap.height * scale));
  const context = canvas.getContext("2d");
  if (!context) return file;
  context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  bitmap.close();

  for (const quality of [0.86, 0.76, 0.66, 0.56, 0.46]) {
    const blob = await new Promise<Blob | null>((resolve) =>
      canvas.toBlob(resolve, "image/jpeg", quality),
    );
    if (blob && blob.size <= maxBytes) {
      const name = file.name.replace(/\.[^.]+$/, "") || "photo";
      return new File([blob], `${name}.jpg`, { type: "image/jpeg" });
    }
  }
  return file;
}
