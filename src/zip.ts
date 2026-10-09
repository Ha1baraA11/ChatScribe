/**
 * zip.ts — ChatScribe
 *
 * Minimal ZIP archive builder (no dependencies, browser-native only).
 *
 * Creates a ZIP containing one text file and an optional images/ folder.
 * The ZIP structure follows the ZIP specification (local file headers +
 * central directory). Uses STORE compression (no deflate) for simplicity
 * and broad compatibility.
 */

import type { ExportImageFile } from "./types.ts";

// -----------------------------------------------------------------------
// LOW-LEVEL ZIP HELPERS
// -----------------------------------------------------------------------

/** Write a 16-bit little-endian integer into a DataView at offset. */
function u16(view: DataView, offset: number, value: number): void {
  view.setUint16(offset, value, true);
}

/** Write a 32-bit little-endian integer into a DataView at offset. */
function u32(view: DataView, offset: number, value: number): void {
  view.setUint32(offset, value, true);
}

function encodeUtf8(str: string): Uint8Array {
  return new TextEncoder().encode(str);
}

/**
 * Compute a CRC-32 checksum for an array of bytes.
 * Uses the standard polynomial 0xEDB88320.
 */
function crc32(data: Uint8Array): number {
  let crc = 0xffffffff;

  for (const byte of data) {
    let c = (crc ^ byte) & 0xff;
    for (let i = 0; i < 8; i++) {
      c = c & 1 ? (c >>> 1) ^ 0xedb88320 : c >>> 1;
    }
    crc = (crc >>> 8) ^ c;
  }

  return (crc ^ 0xffffffff) >>> 0;
}

function base64ToUint8Array(b64: string): Uint8Array {
  const binStr = atob(b64);
  const bytes = new Uint8Array(binStr.length);
  for (let i = 0; i < binStr.length; i++) {
    bytes[i] = binStr.charCodeAt(i);
  }
  return bytes;
}

// -----------------------------------------------------------------------
// ZIP FILE ENTRY
// -----------------------------------------------------------------------

interface ZipEntry {
  name: string; // UTF-8 path within the archive
  data: Uint8Array;
}

function buildLocalHeader(
  nameBytes: Uint8Array,
  crc: number,
  size: number,
): Uint8Array {
  const header = new Uint8Array(30 + nameBytes.length);
  const view = new DataView(header.buffer);

  u32(view, 0, 0x04034b50); // Local file header signature
  u16(view, 4, 20); // Version needed (2.0)
  u16(view, 6, 0x0800); // General purpose bit flag (UTF-8 filenames)
  u16(view, 8, 0); // Compression: STORE
  u16(view, 10, 0); // Last mod time
  u16(view, 12, 0); // Last mod date
  u32(view, 14, crc); // CRC-32
  u32(view, 18, size); // Compressed size
  u32(view, 22, size); // Uncompressed size
  u16(view, 26, nameBytes.length); // File name length
  u16(view, 28, 0); // Extra field length
  header.set(nameBytes, 30);

  return header;
}

function buildCentralEntry(
  nameBytes: Uint8Array,
  crc: number,
  size: number,
  localHeaderOffset: number,
): Uint8Array {
  const entry = new Uint8Array(46 + nameBytes.length);
  const view = new DataView(entry.buffer);

  u32(view, 0, 0x02014b50); // Central directory file header signature
  u16(view, 4, 20); // Version made by
  u16(view, 6, 20); // Version needed
  u16(view, 8, 0x0800); // General purpose bit flag (UTF-8)
  u16(view, 10, 0); // Compression: STORE
  u16(view, 12, 0); // Last mod time
  u16(view, 14, 0); // Last mod date
  u32(view, 16, crc); // CRC-32
  u32(view, 20, size); // Compressed size
  u32(view, 24, size); // Uncompressed size
  u16(view, 28, nameBytes.length); // File name length
  u16(view, 30, 0); // Extra field length
  u16(view, 32, 0); // File comment length
  u16(view, 34, 0); // Disk number start
  u16(view, 36, 0); // Internal file attributes
  u32(view, 38, 0); // External file attributes
  u32(view, 42, localHeaderOffset); // Relative offset of local header
  entry.set(nameBytes, 46);

  return entry;
}

function buildEndOfCentralDirectory(
  entryCount: number,
  centralDirectorySize: number,
  centralDirectoryOffset: number,
): Uint8Array {
  const eocd = new Uint8Array(22);
  const view = new DataView(eocd.buffer);

  u32(view, 0, 0x06054b50); // End of central directory signature
  u16(view, 4, 0); // Disk number
  u16(view, 6, 0); // Disk with start of central directory
  u16(view, 8, entryCount); // Number of entries on this disk
  u16(view, 10, entryCount); // Total number of entries
  u32(view, 12, centralDirectorySize); // Size of central directory
  u32(view, 16, centralDirectoryOffset); // Offset of central directory
  u16(view, 20, 0); // ZIP file comment length

  return eocd;
}

// -----------------------------------------------------------------------
// PUBLIC API
// -----------------------------------------------------------------------

/**
 * Build a ZIP Blob containing:
 *   - `conversationFilename` at the root (the text/Markdown file)
 *   - each image in images/ (from `imageFiles`)
 *
 * Everything uses STORE compression (no deflate) so we don't need pako.
 */
export function buildZipBlob(
  conversationText: string,
  conversationFilename: string,
  imageFiles: ExportImageFile[],
): Blob {
  const encoder = encodeUtf8;

  // Build entries array
  const entries: ZipEntry[] = [
    { name: conversationFilename, data: encoder(conversationText) },
    ...imageFiles.map((img) => ({
      name: img.path,
      data: base64ToUint8Array(img.base64),
    })),
  ];

  // Local file records
  const localChunks: Uint8Array[] = [];
  const offsets: number[] = [];
  let localSize = 0;

  for (const entry of entries) {
    const nameBytes = encoder(entry.name);
    const crc = crc32(entry.data);
    const header = buildLocalHeader(nameBytes, crc, entry.data.length);

    offsets.push(localSize);
    localChunks.push(header, entry.data);
    localSize += header.length + entry.data.length;
  }

  // Central directory records
  const centralChunks: Uint8Array[] = [];
  let centralSize = 0;

  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i];
    const nameBytes = encoder(entry.name);
    const crc = crc32(entry.data);
    const rec = buildCentralEntry(
      nameBytes,
      crc,
      entry.data.length,
      offsets[i],
    );
    centralChunks.push(rec);
    centralSize += rec.length;
  }

  const eocd = buildEndOfCentralDirectory(
    entries.length,
    centralSize,
    localSize,
  );

  return new Blob(
    [...localChunks, ...centralChunks, eocd] as unknown as BlobPart[],
    { type: "application/zip" },
  );
}

/**
 * Encode a Blob to a base64 string (for sending to background.js for
 * GitHub binary uploads).
 */
export async function blobToBase64(blob: Blob): Promise<string> {
  const buffer = await blob.arrayBuffer();
  const bytes = new Uint8Array(buffer);
  const CHUNK = 8192;
  let binary = "";
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}
