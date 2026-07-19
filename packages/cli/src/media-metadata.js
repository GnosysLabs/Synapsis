const JPEG_MIME = 'image/jpeg';
const PNG_MIME = 'image/png';
const GIF_MIME = 'image/gif';
const WEBP_MIME = 'image/webp';
const MP4_MIMES = new Set(['video/mp4', 'video/quicktime']);

const textDecoder = new TextDecoder('latin1');
const textEncoder = new TextEncoder();

export class MediaMetadataError extends Error {
  constructor(message) {
    super(message);
    this.name = 'MediaMetadataError';
    this.code = 'METADATA_STRIP_FAILED';
  }
}

function fail(format) {
  throw new MediaMetadataError(`Unable to safely remove metadata from this ${format} file.`);
}

function ascii(bytes, start, length) {
  return textDecoder.decode(bytes.subarray(start, start + length));
}

function concat(parts) {
  const length = parts.reduce((total, part) => total + part.length, 0);
  const output = new Uint8Array(length);
  let offset = 0;
  for (const part of parts) {
    output.set(part, offset);
    offset += part.length;
  }
  return output;
}

function readUint32BE(bytes, offset) {
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(offset, false);
}

function readUint32LE(bytes, offset) {
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(offset, true);
}

function writeUint32LE(bytes, offset, value) {
  new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).setUint32(offset, value, true);
}

function jpegSegments(bytes) {
  if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) fail('JPEG');
  const segments = [];
  let offset = 2;

  while (offset < bytes.length) {
    const start = offset;
    if (bytes[offset] !== 0xff) fail('JPEG');
    while (offset < bytes.length && bytes[offset] === 0xff) offset += 1;
    if (offset >= bytes.length) fail('JPEG');
    const marker = bytes[offset];
    offset += 1;

    if (marker === 0xd9) {
      segments.push({ marker, start, end: offset, payloadStart: offset });
      if (offset !== bytes.length) segments.push({ marker: -1, start: offset, end: bytes.length, payloadStart: offset });
      return segments;
    }
    if (marker === 0xda) {
      if (offset + 2 > bytes.length) fail('JPEG');
      const length = (bytes[offset] << 8) | bytes[offset + 1];
      if (length < 2 || offset + length > bytes.length) fail('JPEG');
      segments.push({ marker, start, end: bytes.length, payloadStart: offset + 2 });
      return segments;
    }
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      segments.push({ marker, start, end: offset, payloadStart: offset });
      continue;
    }
    if (offset + 2 > bytes.length) fail('JPEG');
    const length = (bytes[offset] << 8) | bytes[offset + 1];
    if (length < 2 || offset + length > bytes.length) fail('JPEG');
    segments.push({ marker, start, end: offset + length, payloadStart: offset + 2 });
    offset += length;
  }
  fail('JPEG');
}

function tiffOrientation(bytes, start, end) {
  if (end - start >= 6 && ascii(bytes, start, 6) === 'Exif\0\0') start += 6;
  if (end - start < 8) return 1;
  const byteOrder = ascii(bytes, start, 2);
  const littleEndian = byteOrder === 'II';
  if (!littleEndian && byteOrder !== 'MM') return 1;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const uint16 = (offset) => view.getUint16(offset, littleEndian);
  const uint32 = (offset) => view.getUint32(offset, littleEndian);
  if (uint16(start + 2) !== 42) return 1;
  const ifdOffset = uint32(start + 4);
  const ifd = start + ifdOffset;
  if (ifd < start || ifd + 2 > end) return 1;
  const count = uint16(ifd);
  if (count > 4096 || ifd + 2 + count * 12 > end) return 1;
  for (let index = 0; index < count; index += 1) {
    const entry = ifd + 2 + index * 12;
    if (uint16(entry) !== 0x0112 || uint16(entry + 2) !== 3 || uint32(entry + 4) < 1) continue;
    const orientation = uint16(entry + 8);
    return orientation >= 1 && orientation <= 8 ? orientation : 1;
  }
  return 1;
}

function jpegOrientation(bytes) {
  for (const segment of jpegSegments(bytes)) {
    if (segment.marker === 0xe1 && ascii(bytes, segment.payloadStart, 6) === 'Exif\0\0') {
      return tiffOrientation(bytes, segment.payloadStart, segment.end);
    }
  }
  return 1;
}

function stripJpeg(bytes) {
  const parts = [bytes.subarray(0, 2)];
  for (const segment of jpegSegments(bytes)) {
    const applicationSegment = segment.marker >= 0xe0 && segment.marker <= 0xef;
    const safeApplicationSegment = (segment.marker === 0xe0
      && ['JFIF\0', 'JFXX\0'].includes(ascii(bytes, segment.payloadStart, 5)))
      || (segment.marker === 0xe2 && ascii(bytes, segment.payloadStart, 12) === 'ICC_PROFILE\0')
      || (segment.marker === 0xee && ascii(bytes, segment.payloadStart, 5) === 'Adobe');
    const privateApplicationSegment = applicationSegment && !safeApplicationSegment;
    if (!privateApplicationSegment && segment.marker !== 0xfe) {
      parts.push(bytes.subarray(segment.start, segment.end));
    }
  }
  return concat(parts);
}

const PNG_SIGNATURE = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);
const PNG_PRIVATE_CHUNKS = new Set(['eXIf', 'tEXt', 'zTXt', 'iTXt', 'tIME']);

function pngChunks(bytes) {
  if (bytes.length < 20 || !PNG_SIGNATURE.every((value, index) => bytes[index] === value)) fail('PNG');
  const chunks = [];
  let offset = 8;
  let ended = false;
  while (offset < bytes.length) {
    if (offset + 12 > bytes.length) fail('PNG');
    const length = readUint32BE(bytes, offset);
    const end = offset + 12 + length;
    if (end > bytes.length) fail('PNG');
    const type = ascii(bytes, offset + 4, 4);
    chunks.push({ type, start: offset, dataStart: offset + 8, dataEnd: offset + 8 + length, end });
    offset = end;
    if (type === 'IEND') {
      ended = true;
      break;
    }
  }
  if (!ended || offset !== bytes.length) fail('PNG');
  return chunks;
}

function stripPng(bytes) {
  const parts = [bytes.subarray(0, 8)];
  for (const chunk of pngChunks(bytes)) {
    if (!PNG_PRIVATE_CHUNKS.has(chunk.type)) parts.push(bytes.subarray(chunk.start, chunk.end));
  }
  return concat(parts);
}

function pngOrientation(bytes) {
  const exif = pngChunks(bytes).find((chunk) => chunk.type === 'eXIf');
  return exif ? tiffOrientation(bytes, exif.dataStart, exif.dataEnd) : 1;
}

function pngIsAnimated(bytes) {
  return pngChunks(bytes).some((chunk) => chunk.type === 'acTL');
}

function webpChunks(bytes) {
  if (bytes.length < 12 || ascii(bytes, 0, 4) !== 'RIFF' || ascii(bytes, 8, 4) !== 'WEBP') fail('WebP');
  const riffEnd = readUint32LE(bytes, 4) + 8;
  if (riffEnd !== bytes.length) fail('WebP');
  const chunks = [];
  let offset = 12;
  while (offset < bytes.length) {
    if (offset + 8 > bytes.length) fail('WebP');
    const length = readUint32LE(bytes, offset + 4);
    const end = offset + 8 + length + (length & 1);
    if (end > bytes.length) fail('WebP');
    chunks.push({
      type: ascii(bytes, offset, 4),
      start: offset,
      dataStart: offset + 8,
      dataEnd: offset + 8 + length,
      end,
    });
    offset = end;
  }
  if (offset !== bytes.length) fail('WebP');
  return chunks;
}

function stripWebp(bytes) {
  const header = bytes.slice(0, 12);
  const parts = [header];
  for (const chunk of webpChunks(bytes)) {
    if (chunk.type === 'EXIF' || chunk.type === 'XMP ') continue;
    const kept = bytes.slice(chunk.start, chunk.end);
    if (chunk.type === 'VP8X' && kept.length >= 9) kept[8] &= ~0x0c;
    parts.push(kept);
  }
  const output = concat(parts);
  writeUint32LE(output, 4, output.length - 8);
  return output;
}

function webpOrientation(bytes) {
  const exif = webpChunks(bytes).find((chunk) => chunk.type === 'EXIF');
  return exif ? tiffOrientation(bytes, exif.dataStart, exif.dataEnd) : 1;
}

function webpIsAnimated(bytes) {
  return webpChunks(bytes).some((chunk) => chunk.type === 'ANIM');
}

function gifSubBlocksEnd(bytes, start) {
  let offset = start;
  while (offset < bytes.length) {
    const length = bytes[offset];
    offset += 1;
    if (length === 0) return offset;
    if (offset + length > bytes.length) fail('GIF');
    offset += length;
  }
  fail('GIF');
}

function stripGif(bytes) {
  if (bytes.length < 14 || !['GIF87a', 'GIF89a'].includes(ascii(bytes, 0, 6))) fail('GIF');
  const packed = bytes[10];
  const globalColorTableLength = packed & 0x80 ? 3 * (1 << ((packed & 0x07) + 1)) : 0;
  let offset = 13 + globalColorTableLength;
  if (offset > bytes.length) fail('GIF');
  const parts = [bytes.subarray(0, offset)];

  while (offset < bytes.length) {
    const start = offset;
    const introducer = bytes[offset];
    offset += 1;
    if (introducer === 0x3b) {
      parts.push(bytes.subarray(start, offset));
      if (offset !== bytes.length) fail('GIF');
      return concat(parts);
    }
    if (introducer === 0x2c) {
      if (offset + 9 > bytes.length) fail('GIF');
      const imagePacked = bytes[offset + 8];
      offset += 9;
      if (imagePacked & 0x80) offset += 3 * (1 << ((imagePacked & 0x07) + 1));
      if (offset + 1 > bytes.length) fail('GIF');
      offset += 1;
      offset = gifSubBlocksEnd(bytes, offset);
      parts.push(bytes.subarray(start, offset));
      continue;
    }
    if (introducer !== 0x21 || offset >= bytes.length) fail('GIF');
    const label = bytes[offset];
    offset += 1;
    let remove = label === 0xfe;
    if (label === 0xf9) {
      if (offset >= bytes.length) fail('GIF');
      const length = bytes[offset];
      offset += 1 + length;
      if (offset >= bytes.length || bytes[offset] !== 0) fail('GIF');
      offset += 1;
    } else if (label === 0xff || label === 0x01) {
      if (offset >= bytes.length) fail('GIF');
      const headerLength = bytes[offset];
      const headerStart = offset + 1;
      offset = headerStart + headerLength;
      if (offset > bytes.length) fail('GIF');
      if (label === 0xff) {
        const identifier = ascii(bytes, headerStart, headerLength);
        remove = !identifier.startsWith('NETSCAPE2.0') && !identifier.startsWith('ANIMEXTS1.0');
      }
      offset = gifSubBlocksEnd(bytes, offset);
    } else {
      offset = gifSubBlocksEnd(bytes, offset);
    }
    if (!remove) parts.push(bytes.subarray(start, offset));
  }
  fail('GIF');
}

function boxType(bytes, offset) {
  return ascii(bytes, offset + 4, 4);
}

function readBoxes(bytes, start, end) {
  const boxes = [];
  let offset = start;
  while (offset < end) {
    if (offset + 8 > end) fail('MP4/QuickTime');
    const size32 = readUint32BE(bytes, offset);
    let size = size32;
    let headerSize = 8;
    if (size32 === 1) {
      if (offset + 16 > end) fail('MP4/QuickTime');
      const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
      const large = view.getBigUint64(offset + 8, false);
      if (large > BigInt(Number.MAX_SAFE_INTEGER)) fail('MP4/QuickTime');
      size = Number(large);
      headerSize = 16;
    } else if (size32 === 0) {
      size = end - offset;
    }
    if (size < headerSize || offset + size > end) fail('MP4/QuickTime');
    boxes.push({ type: boxType(bytes, offset), start: offset, end: offset + size, headerSize });
    offset += size;
  }
  if (offset !== end) fail('MP4/QuickTime');
  return boxes;
}

function childBox(bytes, box, type) {
  return readBoxes(bytes, box.start + box.headerSize, box.end).find((child) => child.type === type);
}

function metadataTrack(bytes, track) {
  const media = childBox(bytes, track, 'mdia');
  if (!media) return false;
  const handler = childBox(bytes, media, 'hdlr');
  if (!handler || handler.start + handler.headerSize + 12 > handler.end) return false;
  return ascii(bytes, handler.start + handler.headerSize + 8, 4) === 'meta';
}

function sampleSizes(bytes, sampleTable) {
  const stsz = childBox(bytes, sampleTable, 'stsz');
  if (stsz) {
    const payload = stsz.start + stsz.headerSize;
    if (payload + 12 > stsz.end) fail('MP4/QuickTime');
    const constantSize = readUint32BE(bytes, payload + 4);
    const count = readUint32BE(bytes, payload + 8);
    if (count > 1_000_000) fail('MP4/QuickTime');
    if (constantSize) return new Array(count).fill(constantSize);
    if (payload + 12 + count * 4 > stsz.end) fail('MP4/QuickTime');
    return Array.from({ length: count }, (_, index) => readUint32BE(bytes, payload + 12 + index * 4));
  }

  const stz2 = childBox(bytes, sampleTable, 'stz2');
  if (!stz2) fail('MP4/QuickTime');
  const payload = stz2.start + stz2.headerSize;
  if (payload + 12 > stz2.end) fail('MP4/QuickTime');
  const fieldSize = bytes[payload + 7];
  const count = readUint32BE(bytes, payload + 8);
  const sizes = [];
  if (fieldSize === 4) {
    if (payload + 12 + Math.ceil(count / 2) > stz2.end) fail('MP4/QuickTime');
    for (let index = 0; index < count; index += 1) {
      const packed = bytes[payload + 12 + Math.floor(index / 2)];
      sizes.push(index % 2 === 0 ? packed >>> 4 : packed & 0x0f);
    }
  } else if (fieldSize === 8) {
    if (payload + 12 + count > stz2.end) fail('MP4/QuickTime');
    for (let index = 0; index < count; index += 1) sizes.push(bytes[payload + 12 + index]);
  } else if (fieldSize === 16) {
    if (payload + 12 + count * 2 > stz2.end) fail('MP4/QuickTime');
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    for (let index = 0; index < count; index += 1) sizes.push(view.getUint16(payload + 12 + index * 2, false));
  } else {
    fail('MP4/QuickTime');
  }
  return sizes;
}

function chunkOffsets(bytes, sampleTable) {
  const stco = childBox(bytes, sampleTable, 'stco');
  const co64 = childBox(bytes, sampleTable, 'co64');
  const table = stco || co64;
  if (!table) fail('MP4/QuickTime');
  const payload = table.start + table.headerSize;
  if (payload + 8 > table.end) fail('MP4/QuickTime');
  const count = readUint32BE(bytes, payload + 4);
  const width = stco ? 4 : 8;
  if (payload + 8 + count * width > table.end) fail('MP4/QuickTime');
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return Array.from({ length: count }, (_, index) => {
    const at = payload + 8 + index * width;
    if (width === 4) return view.getUint32(at, false);
    const value = view.getBigUint64(at, false);
    if (value > BigInt(Number.MAX_SAFE_INTEGER)) fail('MP4/QuickTime');
    return Number(value);
  });
}

function samplesPerChunk(bytes, sampleTable, chunkCount) {
  const stsc = childBox(bytes, sampleTable, 'stsc');
  if (!stsc) fail('MP4/QuickTime');
  const payload = stsc.start + stsc.headerSize;
  if (payload + 8 > stsc.end) fail('MP4/QuickTime');
  const count = readUint32BE(bytes, payload + 4);
  if (count === 0 || payload + 8 + count * 12 > stsc.end) fail('MP4/QuickTime');
  const entries = Array.from({ length: count }, (_, index) => ({
    firstChunk: readUint32BE(bytes, payload + 8 + index * 12),
    samples: readUint32BE(bytes, payload + 12 + index * 12),
  }));
  if (entries[0].firstChunk !== 1 || entries.some((entry, index) => (
    entry.samples === 0 || (index > 0 && entry.firstChunk <= entries[index - 1].firstChunk)
  ))) fail('MP4/QuickTime');
  const result = [];
  let entryIndex = 0;
  for (let chunk = 1; chunk <= chunkCount; chunk += 1) {
    if (entryIndex + 1 < entries.length && chunk >= entries[entryIndex + 1].firstChunk) entryIndex += 1;
    result.push(entries[entryIndex].samples);
  }
  return result;
}

function metadataSampleRanges(bytes, track, mediaRanges) {
  const media = childBox(bytes, track, 'mdia');
  const minf = media && childBox(bytes, media, 'minf');
  const stbl = minf && childBox(bytes, minf, 'stbl');
  if (!stbl) fail('MP4/QuickTime');
  const sizes = sampleSizes(bytes, stbl);
  const offsets = chunkOffsets(bytes, stbl);
  const counts = samplesPerChunk(bytes, stbl, offsets.length);
  const ranges = [];
  let sample = 0;
  for (let chunk = 0; chunk < offsets.length; chunk += 1) {
    let offset = offsets[chunk];
    for (let index = 0; index < counts[chunk]; index += 1) {
      if (sample >= sizes.length || offset + sizes[sample] > bytes.length) fail('MP4/QuickTime');
      const end = offset + sizes[sample];
      if (!mediaRanges.some(([mediaStart, mediaEnd]) => offset >= mediaStart && end <= mediaEnd)) {
        fail('MP4/QuickTime');
      }
      ranges.push([offset, end]);
      offset = end;
      sample += 1;
    }
  }
  if (sample !== sizes.length) fail('MP4/QuickTime');
  return ranges;
}

function wipeBox(bytes, box) {
  bytes.set(textEncoder.encode('free'), box.start + 4);
  bytes.fill(0, box.start + box.headerSize, box.end);
}

function zeroBoxTimestamps(bytes, box) {
  const payload = box.start + box.headerSize;
  if (payload + 12 > box.end) fail('MP4/QuickTime');
  const version = bytes[payload];
  const length = version === 1 ? 16 : version === 0 ? 8 : 0;
  if (!length || payload + 4 + length > box.end) fail('MP4/QuickTime');
  bytes.fill(0, payload + 4, payload + 4 + length);
}

function sanitizeMp4Container(bytes, box, hasFragments, mediaRanges) {
  const children = readBoxes(bytes, box.start + box.headerSize, box.end);
  for (const child of children) {
    if (child.type === 'meta' || child.type === 'udta') {
      wipeBox(bytes, child);
      continue;
    }
    if ((box.type === 'moov' && child.type === 'mvhd')
      || (box.type === 'trak' && child.type === 'tkhd')
      || (box.type === 'mdia' && child.type === 'mdhd')) {
      zeroBoxTimestamps(bytes, child);
    }
    if (child.type === 'trak' && metadataTrack(bytes, child)) {
      if (hasFragments) fail('MP4/QuickTime');
      for (const [start, end] of metadataSampleRanges(bytes, child, mediaRanges)) bytes.fill(0, start, end);
      wipeBox(bytes, child);
      continue;
    }
    if (child.type === 'moov' || child.type === 'trak' || child.type === 'mdia') {
      sanitizeMp4Container(bytes, child, hasFragments, mediaRanges);
    }
  }
}

function stripMp4(input) {
  const bytes = input.slice();
  const topLevel = readBoxes(bytes, 0, bytes.length);
  const movie = topLevel.find((box) => box.type === 'moov');
  if (!movie) fail('MP4/QuickTime');
  const hasFragments = topLevel.some((box) => box.type === 'moof');
  const mediaRanges = topLevel
    .filter((box) => box.type === 'mdat')
    .map((box) => [box.start + box.headerSize, box.end]);
  for (const box of topLevel) {
    if (box.type === 'meta' || box.type === 'udta') wipeBox(bytes, box);
  }
  sanitizeMp4Container(bytes, movie, hasFragments, mediaRanges);
  return bytes;
}

function readEbmlVint(bytes, offset, keepMarker) {
  if (offset >= bytes.length || bytes[offset] === 0) fail('WebM');
  let width = 1;
  let marker = 0x80;
  while (width <= 8 && (bytes[offset] & marker) === 0) {
    width += 1;
    marker >>>= 1;
  }
  if (width > 8 || offset + width > bytes.length) fail('WebM');
  let value = keepMarker ? bytes[offset] : bytes[offset] & (marker - 1);
  for (let index = 1; index < width; index += 1) value = value * 256 + bytes[offset + index];
  const unknown = !keepMarker && value === (2 ** (7 * width)) - 1;
  return { width, value, unknown };
}

function readEbmlElements(bytes, start, end) {
  const elements = [];
  let offset = start;
  while (offset < end) {
    const id = readEbmlVint(bytes, offset, true);
    const size = readEbmlVint(bytes, offset + id.width, false);
    const dataStart = offset + id.width + size.width;
    const dataEnd = size.unknown ? end : dataStart + size.value;
    if (dataEnd > end || dataEnd < dataStart) fail('WebM');
    elements.push({ id: id.value, start: offset, dataStart, end: dataEnd });
    offset = dataEnd;
    if (size.unknown) break;
  }
  if (offset !== end) fail('WebM');
  return elements;
}

function writeEbmlSize(bytes, offset, width, value) {
  const max = (2 ** (7 * width)) - 2;
  if (value < 0 || value > max) return false;
  let remaining = value;
  for (let index = width - 1; index >= 0; index -= 1) {
    bytes[offset + index] = remaining & 0xff;
    remaining = Math.floor(remaining / 256);
  }
  bytes[offset] |= 1 << (8 - width);
  return true;
}

function wipeEbmlElement(bytes, element) {
  const total = element.end - element.start;
  for (let sizeWidth = 1; sizeWidth <= 8; sizeWidth += 1) {
    const payload = total - 1 - sizeWidth;
    if (writeEbmlSize(bytes, element.start + 1, sizeWidth, payload)) {
      bytes[element.start] = 0xec;
      bytes.fill(0, element.start + 1 + sizeWidth, element.end);
      return;
    }
  }
  fail('WebM');
}

function stripWebm(input) {
  const bytes = input.slice();
  const topLevel = readEbmlElements(bytes, 0, bytes.length);
  if (!topLevel.some((element) => element.id === 0x1a45dfa3)) fail('WebM');
  const segment = topLevel.find((element) => element.id === 0x18538067);
  if (!segment) fail('WebM');
  const privateInfoElements = new Set([0x7ba9, 0x4461, 0x4d80, 0x5741]);
  for (const element of readEbmlElements(bytes, segment.dataStart, segment.end)) {
    if (element.id === 0x1254c367 || element.id === 0x1941a469) {
      wipeEbmlElement(bytes, element);
      continue;
    }
    if (element.id === 0x1549a966) {
      for (const child of readEbmlElements(bytes, element.dataStart, element.end)) {
        if (privateInfoElements.has(child.id)) wipeEbmlElement(bytes, child);
      }
    }
  }
  return bytes;
}

export function imageExifOrientation(bytes, mimeType) {
  if (mimeType === JPEG_MIME) return jpegOrientation(bytes);
  if (mimeType === PNG_MIME) return pngOrientation(bytes);
  if (mimeType === WEBP_MIME) return webpOrientation(bytes);
  return 1;
}

export function imageMetadataNeedsRasterization(bytes, mimeType) {
  const orientation = imageExifOrientation(bytes, mimeType);
  if (orientation === 1) return false;
  if ((mimeType === PNG_MIME && pngIsAnimated(bytes)) || (mimeType === WEBP_MIME && webpIsAnimated(bytes))) {
    throw new MediaMetadataError('This animated image uses EXIF orientation that cannot be removed without changing its animation.');
  }
  return true;
}

export function stripMediaMetadataBytes(input, mimeType) {
  const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
  if (mimeType === JPEG_MIME) return stripJpeg(bytes);
  if (mimeType === PNG_MIME) return stripPng(bytes);
  if (mimeType === GIF_MIME) return stripGif(bytes);
  if (mimeType === WEBP_MIME) return stripWebp(bytes);
  if (MP4_MIMES.has(mimeType)) return stripMp4(bytes);
  if (mimeType === 'video/webm') return stripWebm(bytes);
  return bytes;
}
