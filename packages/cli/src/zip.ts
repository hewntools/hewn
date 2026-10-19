// SPDX-License-Identifier: AGPL-3.0-or-later
// Minimal zip writer/reader (deflate, no zip64): Hewn's backups, without depending on a system
// `zip`/`unzip` (many Linux installs don't have them). Reads only what it writes, plus plain
// deflate/stored zips.
import { crc32, deflateRawSync, inflateRawSync } from "node:zlib";

export interface ZipEntry {
  path: string;
  data: Uint8Array;
}

const u16 = (n: number) => {
  const b = Buffer.alloc(2);
  b.writeUInt16LE(n);
  return b;
};
const u32 = (n: number) => {
  const b = Buffer.alloc(4);
  b.writeUInt32LE(n >>> 0);
  return b;
};

/** DOS time/date for a JS Date (zip's timestamp format). */
function dos(d: Date) {
  const time = (d.getHours() << 11) | (d.getMinutes() << 5) | Math.floor(d.getSeconds() / 2);
  const date = ((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate();
  return { time, date };
}

export function createZip(entries: ZipEntry[], now = new Date()): Buffer {
  const { time, date } = dos(now);
  const local: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  for (const e of entries) {
    const name = Buffer.from(e.path.replace(/\\/g, "/"), "utf8");
    const raw = Buffer.from(e.data);
    const deflated = deflateRawSync(raw);
    const useDeflate = deflated.length < raw.length;
    const body = useDeflate ? deflated : raw;
    const method = useDeflate ? 8 : 0;
    const crc = crc32(raw);
    const header = Buffer.concat([
      u32(0x04034b50), u16(20), u16(0x0800), u16(method), u16(time), u16(date),
      u32(crc), u32(body.length), u32(raw.length), u16(name.length), u16(0), name,
    ]);
    local.push(header, body);
    central.push(Buffer.concat([
      u32(0x02014b50), u16(20), u16(20), u16(0x0800), u16(method), u16(time), u16(date),
      u32(crc), u32(body.length), u32(raw.length), u16(name.length), u16(0), u16(0), u16(0), u16(0), u32(0o100644 << 16), u32(offset), name,
    ]));
    offset += header.length + body.length;
  }
  const cd = Buffer.concat(central);
  const end = Buffer.concat([u32(0x06054b50), u16(0), u16(0), u16(entries.length), u16(entries.length), u32(cd.length), u32(offset), u16(0)]);
  return Buffer.concat([...local, cd, end]);
}

export function readZip(zip: Uint8Array): ZipEntry[] {
  const b = Buffer.from(zip);
  let eocd = -1;
  for (let i = b.length - 22; i >= Math.max(0, b.length - 65_557); i--) {
    if (b.readUInt32LE(i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error("not a zip file");
  const count = b.readUInt16LE(eocd + 10);
  let p = b.readUInt32LE(eocd + 16);
  const out: ZipEntry[] = [];
  for (let n = 0; n < count; n++) {
    if (b.readUInt32LE(p) !== 0x02014b50) throw new Error("corrupt zip (central directory)");
    const method = b.readUInt16LE(p + 10);
    const crc = b.readUInt32LE(p + 16);
    const size = b.readUInt32LE(p + 20);
    const nameLen = b.readUInt16LE(p + 28);
    const extraLen = b.readUInt16LE(p + 30);
    const commentLen = b.readUInt16LE(p + 32);
    const localOffset = b.readUInt32LE(p + 42);
    const path = b.subarray(p + 46, p + 46 + nameLen).toString("utf8");
    p += 46 + nameLen + extraLen + commentLen;
    if (path.endsWith("/")) continue;
    const lNameLen = b.readUInt16LE(localOffset + 26);
    const lExtraLen = b.readUInt16LE(localOffset + 28);
    const start = localOffset + 30 + lNameLen + lExtraLen;
    const body = b.subarray(start, start + size);
    const data = method === 8 ? inflateRawSync(body) : method === 0 ? Buffer.from(body) : (() => { throw new Error(`unsupported zip method ${method} (${path})`); })();
    if (crc32(data) >>> 0 !== crc >>> 0) throw new Error(`corrupt zip entry ${path}`);
    if (path.split("/").includes("..") || path.startsWith("/")) throw new Error(`unsafe zip path ${path}`);
    out.push({ path, data });
  }
  return out;
}
