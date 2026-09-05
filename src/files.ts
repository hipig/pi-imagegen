import { access, mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { basename, dirname, extname, isAbsolute, join, resolve } from "node:path";
import { withFileMutationQueue } from "@earendil-works/pi-coding-agent";
import type { GeneratedImage, ImageGenRequest, LoadedImage, SavedImage } from "./types.ts";

const IMAGE_MIME_EXTENSIONS: Record<string, string> = {
  "image/png": ".png",
  "image/jpeg": ".jpg",
  "image/webp": ".webp",
  "image/gif": ".gif",
};

function absolutePath(cwd: string, value: string): string {
  return isAbsolute(value) ? resolve(value) : resolve(cwd, value);
}

export function detectImageMime(data: Uint8Array): string | undefined {
  if (
    data.length >= 24 &&
    data[0] === 0x89 &&
    data[1] === 0x50 &&
    data[2] === 0x4e &&
    data[3] === 0x47 &&
    data[4] === 0x0d &&
    data[5] === 0x0a &&
    data[6] === 0x1a &&
    data[7] === 0x0a &&
    Buffer.from(data.subarray(12, 16)).toString("ascii") === "IHDR"
  ) {
    return "image/png";
  }
  if (data.length >= 4 && data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff) {
    return "image/jpeg";
  }
  if (
    data.length >= 16 &&
    Buffer.from(data.subarray(0, 4)).toString("ascii") === "RIFF" &&
    Buffer.from(data.subarray(8, 12)).toString("ascii") === "WEBP"
  ) {
    return "image/webp";
  }
  if (data.length >= 10) {
    const signature = Buffer.from(data.subarray(0, 6)).toString("ascii");
    if (signature === "GIF87a" || signature === "GIF89a") return "image/gif";
  }
  return undefined;
}

async function loadOneImage(pathValue: string, cwd: string, maxBytes: number): Promise<LoadedImage> {
  const path = absolutePath(cwd, pathValue);
  const info = await stat(path).catch(() => undefined);
  if (!info?.isFile()) throw new Error(`Image file not found: ${path}`);
  if (info.size > maxBytes) {
    throw new Error(`Image '${path}' is ${info.size} bytes, exceeding the ${maxBytes}-byte limit.`);
  }

  const data = await readFile(path);
  const mimeType = detectImageMime(data);
  if (!mimeType) throw new Error(`Unsupported or invalid raster image: ${path}`);
  return { path, fileName: basename(path), data, mimeType };
}

export async function loadInputImages(
  paths: readonly string[],
  cwd: string,
  maxBytes: number,
): Promise<LoadedImage[]> {
  return Promise.all(paths.map((path) => loadOneImage(path, cwd, maxBytes)));
}

export async function loadMask(path: string, cwd: string, maxBytes: number): Promise<LoadedImage> {
  const mask = await loadOneImage(path, cwd, maxBytes);
  if (mask.mimeType !== "image/png") throw new Error(`Mask must be a PNG image with an alpha channel: ${mask.path}`);
  return mask;
}

function normalizeBase64(value: string): string {
  const comma = value.indexOf(",");
  const payload = value.startsWith("data:") && comma >= 0 ? value.slice(comma + 1) : value;
  return payload.replace(/\s+/g, "");
}

export function decodeBase64Image(value: string, _advertisedMime: string | undefined, maxBytes: number): GeneratedImage {
  const normalized = normalizeBase64(value);
  if (!normalized || !/^[A-Za-z0-9+/]*={0,2}$/.test(normalized) || normalized.length % 4 === 1) {
    throw new Error("Image API returned invalid base64 data.");
  }
  const padding = normalized.endsWith("==") ? 2 : normalized.endsWith("=") ? 1 : 0;
  const estimatedBytes = Math.floor((normalized.length * 3) / 4) - padding;
  if (estimatedBytes > maxBytes) {
    throw new Error(`Generated image exceeds the ${maxBytes}-byte limit.`);
  }

  const data = Buffer.from(normalized, "base64");
  if (data.length > maxBytes) throw new Error(`Generated image exceeds the ${maxBytes}-byte limit.`);
  const detectedMime = detectImageMime(data);
  if (!detectedMime) throw new Error("Image API returned bytes that are not a supported raster image.");

  return { data, mimeType: detectedMime };
}

function imageExtension(mimeType: string): string {
  const extension = IMAGE_MIME_EXTENSIONS[mimeType];
  if (!extension) throw new Error(`Unsupported generated image MIME type: ${mimeType}`);
  return extension;
}

function withCorrectExtension(path: string, mimeType: string): string {
  const expected = imageExtension(mimeType);
  const current = extname(path).toLowerCase();
  if (!current) return `${path}${expected}`;
  const currentMime = Object.entries(IMAGE_MIME_EXTENSIONS).find(([, extension]) => extension === current)?.[0];
  if (currentMime === mimeType || (mimeType === "image/jpeg" && current === ".jpeg")) return path;
  return path.slice(0, -current.length) + expected;
}

function slugifyPrompt(prompt: string): string {
  const slug = prompt
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, "-")
    .replace(/-{2,}/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 60);
  return slug || "image";
}

function addIndex(path: string, index: number, count: number): string {
  if (count === 1) return path;
  const extension = extname(path);
  return join(dirname(path), `${basename(path, extension)}-${index + 1}${extension}`);
}

function addVersion(path: string, version: number): string {
  const extension = extname(path);
  return join(dirname(path), `${basename(path, extension)}-v${version}${extension}`);
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function writeGeneratedImage(candidate: string, image: GeneratedImage, overwrite: boolean): Promise<SavedImage> {
  return withFileMutationQueue(candidate, async () => {
    await mkdir(dirname(candidate), { recursive: true });
    let target = candidate;
    if (!overwrite) {
      let version = 2;
      while (await exists(target)) {
        target = addVersion(candidate, version);
        version += 1;
      }
    }

    try {
      await writeFile(target, image.data, { flag: overwrite ? "w" : "wx" });
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "EEXIST" || overwrite) throw error;
      let version = 2;
      while (true) {
        const versioned = addVersion(candidate, version);
        try {
          await writeFile(versioned, image.data, { flag: "wx" });
          target = versioned;
          break;
        } catch (versionError) {
          if ((versionError as NodeJS.ErrnoException).code !== "EEXIST") throw versionError;
          version += 1;
        }
      }
    }

    return { path: target, mimeType: image.mimeType, bytes: image.data.length };
  });
}

export async function saveGeneratedImages(
  images: readonly GeneratedImage[],
  request: ImageGenRequest,
  cwd: string,
  configuredOutputDir: string,
): Promise<SavedImage[]> {
  const outputOverride = request.outputPath?.trim();
  const outputDirectory = absolutePath(cwd, request.outputDir?.trim() || configuredOutputDir);
  const results: SavedImage[] = [];

  for (let index = 0; index < images.length; index += 1) {
    const image = images[index]!;
    const base = outputOverride
      ? absolutePath(cwd, outputOverride)
      : join(outputDirectory, `${slugifyPrompt(request.prompt)}${imageExtension(image.mimeType)}`);
    const candidate = addIndex(withCorrectExtension(base, image.mimeType), index, images.length);
    results.push(await writeGeneratedImage(candidate, image, request.overwrite === true));
  }

  return results;
}

export async function saveDerivedImage(
  image: GeneratedImage,
  originalPath: string,
  suffix: string,
  overwrite: boolean,
): Promise<SavedImage> {
  const normalizedSuffix = suffix.startsWith("-") || suffix.startsWith("_") ? suffix : `-${suffix}`;
  const extension = imageExtension(image.mimeType);
  const originalExtension = extname(originalPath);
  const candidate = join(
    dirname(originalPath),
    `${basename(originalPath, originalExtension)}${normalizedSuffix}${extension}`,
  );
  return writeGeneratedImage(candidate, image, overwrite);
}
