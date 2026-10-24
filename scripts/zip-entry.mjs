/** @file Read a bounded named ZIP member without extracting archive-controlled filesystem paths. */
import fs from 'node:fs';
import { inflateRawSync } from 'node:zlib';

/** APK/AAB fingerprints are small stored/deflated entries; unsupported archives fail closed. */
export function readZipEntry(file, name, maximumBytes = 256) {
  const bytes = fs.readFileSync(file);
  let end = -1;
  for (let offset = bytes.length - 22; offset >= Math.max(0, bytes.length - 65557); offset -= 1) {
    if (bytes.readUInt32LE(offset) === 0x06054b50 && offset + 22 + bytes.readUInt16LE(offset + 20) === bytes.length) { end = offset; break; }
  }
  if (end < 0) throw new Error('ZIP directory is missing.');
  let offset = bytes.readUInt32LE(end + 16);
  const matches = [];
  for (let count = 0; count < bytes.readUInt16LE(end + 10); count += 1) {
    if (offset + 46 > end || bytes.readUInt32LE(offset) !== 0x02014b50) throw new Error('Invalid ZIP directory.');
    const size = bytes.readUInt16LE(offset + 28);
    if (bytes.subarray(offset + 46, offset + 46 + size).toString('utf8') === name) {
      const length = bytes.readUInt32LE(offset + 24);
      const packed = bytes.readUInt32LE(offset + 20);
      const method = bytes.readUInt16LE(offset + 10);
      const local = bytes.readUInt32LE(offset + 42);
      if (length > maximumBytes || packed > maximumBytes * 2 || bytes.readUInt16LE(offset + 8) & 1 ||
        local + 30 > offset || bytes.readUInt32LE(local) !== 0x04034b50) throw new Error('Unsupported ZIP member.');
      const start = local + 30 + bytes.readUInt16LE(local + 26) + bytes.readUInt16LE(local + 28);
      if (start + packed > offset) throw new Error('Invalid ZIP member bounds.');
      const input = bytes.subarray(start, start + packed);
      const value = method === 0 ? input : method === 8 ? inflateRawSync(input, { maxOutputLength: maximumBytes }) : null;
      if (!value || value.length !== length) throw new Error('Invalid ZIP member encoding.');
      matches.push(value);
    }
    offset += 46 + size + bytes.readUInt16LE(offset + 30) + bytes.readUInt16LE(offset + 32);
  }
  if (matches.length !== 1) throw new Error(`Expected one ZIP member: ${name}.`);
  return matches[0];
}
