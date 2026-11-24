import { createReadStream, readdirSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { createGzip } from "node:zlib";

function archiveFiles(root) {
  const files = [];
  const visit = (directory) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const absolute = join(directory, entry.name);
      if (entry.isDirectory()) visit(absolute);
      else if (entry.isFile()) files.push(absolute);
    }
  };
  visit(root);
  return files;
}

function writeText(header, value, offset, length) {
  header.write(String(value), offset, length, "utf8");
}

function writeOctal(header, value, offset, length) {
  const text = Math.max(0, Number(value)).toString(8).padStart(length - 1, "0");
  header.write(`${text.slice(-(length - 1))}\0`, offset, length, "ascii");
}

function tarHeader(filePath, root, fileSize) {
  const header = Buffer.alloc(512, 0);
  const archivePath = relative(root, filePath).split(sep).join("/");
  const parts = archivePath.split("/");
  let name = archivePath;
  let prefix = "";
  if (Buffer.byteLength(name) > 100) {
    const splitAt = archivePath.lastIndexOf("/");
    prefix = archivePath.slice(0, splitAt);
    name = archivePath.slice(splitAt + 1);
  }
  if (Buffer.byteLength(name) > 100 || Buffer.byteLength(prefix) > 155) {
    throw new Error(`Backup contains a file path too long to archive: ${archivePath}`);
  }
  writeText(header, name, 0, 100);
  writeOctal(header, 0o600, 100, 8);
  writeOctal(header, 0, 108, 8);
  writeOctal(header, 0, 116, 8);
  writeOctal(header, fileSize, 124, 12);
  writeOctal(header, Math.floor(Date.now() / 1000), 136, 12);
  header.fill(0x20, 148, 156);
  header[156] = 0x30;
  writeText(header, "ustar\0", 257, 6);
  writeText(header, "00", 263, 2);
  writeText(header, prefix, 345, 155);
  const checksum = header.reduce((sum, byte) => sum + byte, 0);
  header.write(`${checksum.toString(8).padStart(6, "0")}\0 `, 148, 8, "ascii");
  return header;
}

async function* tarEntries(root) {
  for (const file of archiveFiles(root)) {
    const size = statSync(file).size;
    yield tarHeader(file, root, size);
    let written = 0;
    for await (const chunk of createReadStream(file)) {
      written += chunk.length;
      yield chunk;
    }
    const padding = (512 - (written % 512)) % 512;
    if (padding) yield Buffer.alloc(padding);
  }
  yield Buffer.alloc(1024);
}

export async function streamBackupArchive(snapshotPath, response) {
  await pipeline(Readable.from(tarEntries(snapshotPath)), createGzip(), response);
}
