import { describe, expect, it } from 'vitest';
import {
  imageExifOrientation,
  imageMetadataNeedsRasterization,
  stripMediaMetadataBytes,
} from './strip-metadata';

const encoder = new TextEncoder();
const ascii = (value: string) => encoder.encode(value);

function join(...parts: Uint8Array[]): Uint8Array {
  const output = new Uint8Array(parts.reduce((length, part) => length + part.length, 0));
  let offset = 0;
  for (const part of parts) {
    output.set(part, offset);
    offset += part.length;
  }
  return output;
}

function uint32(value: number, littleEndian = false): Uint8Array {
  const bytes = new Uint8Array(4);
  new DataView(bytes.buffer).setUint32(0, value, littleEndian);
  return bytes;
}

function jpegSegment(marker: number, payload: Uint8Array): Uint8Array {
  const length = payload.length + 2;
  return join(new Uint8Array([0xff, marker, length >>> 8, length & 0xff]), payload);
}

function exifWithOrientation(orientation: number): Uint8Array {
  return join(
    ascii('Exif\0\0II'),
    new Uint8Array([42, 0, 8, 0, 0, 0, 1, 0, 0x12, 0x01, 3, 0, 1, 0, 0, 0, orientation, 0, 0, 0]),
    ascii('GPS:37.7749,-122.4194'),
  );
}

function pngChunk(type: string, payload: Uint8Array): Uint8Array {
  return join(uint32(payload.length), ascii(type), payload, new Uint8Array(4));
}

function webpChunk(type: string, payload: Uint8Array): Uint8Array {
  return join(ascii(type), uint32(payload.length, true), payload, payload.length % 2 ? new Uint8Array(1) : new Uint8Array());
}

function box(type: string, ...payload: Uint8Array[]): Uint8Array {
  const data = join(...payload);
  return join(uint32(data.length + 8), ascii(type), data);
}

function fullBox(...payload: Uint8Array[]): Uint8Array {
  return join(new Uint8Array(4), ...payload);
}

function ebmlSize(value: number): Uint8Array {
  if (value >= 127) throw new Error('Test EBML element is too large');
  return new Uint8Array([0x80 | value]);
}

function ebml(id: Uint8Array, payload: Uint8Array): Uint8Array {
  return join(id, ebmlSize(payload.length), payload);
}

function decoded(bytes: Uint8Array): string {
  return new TextDecoder('latin1').decode(bytes);
}

describe('photo and video metadata stripping', () => {
  it('removes JPEG EXIF, IPTC, comments, and detects orientation before removal', () => {
    const input = join(
      new Uint8Array([0xff, 0xd8]),
      jpegSegment(0xe1, exifWithOrientation(6)),
      jpegSegment(0xe2, ascii('FlashPix private data')),
      jpegSegment(0xe2, ascii('ICC_PROFILE\0safe color profile')),
      jpegSegment(0xed, ascii('IPTC author and location')),
      jpegSegment(0xfe, ascii('camera comment')),
      new Uint8Array([0xff, 0xda, 0, 2, 1, 2, 3, 0xff, 0xd9]),
    );

    expect(imageExifOrientation(input, 'image/jpeg')).toBe(6);
    expect(imageMetadataNeedsRasterization(input, 'image/jpeg')).toBe(true);
    const output = stripMediaMetadataBytes(input, 'image/jpeg');
    expect(decoded(output)).not.toMatch(/GPS|IPTC|camera comment|Exif|FlashPix/);
    expect(decoded(output)).toContain('ICC_PROFILE');
    expect(Array.from(output.slice(-5))).toEqual([1, 2, 3, 0xff, 0xd9]);
  });

  it('removes PNG EXIF and text without touching image data', () => {
    const signature = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);
    const imageData = new Uint8Array([9, 8, 7, 6]);
    const input = join(
      signature,
      pngChunk('IHDR', new Uint8Array(13)),
      pngChunk('eXIf', exifWithOrientation(1).slice(6)),
      pngChunk('iTXt', ascii('GPS and camera model')),
      pngChunk('IDAT', imageData),
      pngChunk('IEND', new Uint8Array()),
    );

    const output = stripMediaMetadataBytes(input, 'image/png');
    expect(decoded(output)).not.toMatch(/eXIf|iTXt|GPS|camera model/);
    expect(decoded(output)).toContain('IDAT');
    expect(output).toEqual(join(
      signature,
      pngChunk('IHDR', new Uint8Array(13)),
      pngChunk('IDAT', imageData),
      pngChunk('IEND', new Uint8Array()),
    ));
  });

  it('removes WebP EXIF and XMP while preserving animation-capable container flags', () => {
    const extendedHeader = new Uint8Array(10);
    extendedHeader[0] = 0x0e;
    const body = join(
      webpChunk('VP8X', extendedHeader),
      webpChunk('EXIF', exifWithOrientation(1)),
      webpChunk('XMP ', ascii('private location')),
      webpChunk('VP8 ', new Uint8Array([4, 5, 6])),
    );
    const input = join(ascii('RIFF'), uint32(body.length + 4, true), ascii('WEBP'), body);

    const output = stripMediaMetadataBytes(input, 'image/webp');
    expect(decoded(output)).not.toMatch(/EXIF|XMP |private location/);
    expect(decoded(output)).toContain('VP8 ');
    expect(output[20] & 0x0c).toBe(0);
    expect(new DataView(output.buffer).getUint32(4, true)).toBe(output.length - 8);
  });

  it('removes GIF comments and metadata application extensions without flattening it', () => {
    const input = join(
      ascii('GIF89a'),
      new Uint8Array([1, 0, 1, 0, 0, 0, 0]),
      new Uint8Array([0x21, 0xfe, 6]), ascii('secret'), new Uint8Array([0]),
      new Uint8Array([0x21, 0xff, 11]), ascii('XMP DataXMP'), new Uint8Array([3]), ascii('gps'), new Uint8Array([0]),
      new Uint8Array([0x3b]),
    );

    const output = stripMediaMetadataBytes(input, 'image/gif');
    expect(decoded(output)).not.toMatch(/secret|XMP|gps/);
    expect(decoded(output).startsWith('GIF89a')).toBe(true);
    expect(output.at(-1)).toBe(0x3b);
  });

  it('zeros QuickTime metadata, user data, and creation dates without moving media bytes', () => {
    const timestamps = fullBox(uint32(123), uint32(456), new Uint8Array(12));
    const mediaPayload = ascii('encoded-video-frames');
    const movie = box(
      'moov',
      box('mvhd', timestamps),
      box('udta', ascii('GPS private location')),
      box('meta', ascii('camera and author')),
      box('trak', box('tkhd', timestamps), box('mdia', box('mdhd', timestamps), box('hdlr', fullBox(uint32(0), ascii('vide'))))),
    );
    const input = join(box('ftyp', ascii('isom0000')), movie, box('mdat', mediaPayload));

    const output = stripMediaMetadataBytes(input, 'video/mp4');
    expect(output.length).toBe(input.length);
    expect(decoded(output)).not.toMatch(/GPS private|camera and author/);
    expect(decoded(output)).toContain('encoded-video-frames');
    expect(decoded(output).match(/free/g)?.length).toBe(2);
    expect(output).not.toEqual(input);
  });

  it('zeros timed QuickTime metadata samples as well as their metadata track', () => {
    const fileType = box('ftyp', ascii('isom0000'));
    const sample = ascii('GPS timed sample');
    const mediaData = box('mdat', sample);
    const sampleOffset = fileType.length + 8;
    const table = box(
      'stbl',
      box('stsz', fullBox(uint32(0), uint32(1), uint32(sample.length))),
      box('stco', fullBox(uint32(1), uint32(sampleOffset))),
      box('stsc', fullBox(uint32(1), uint32(1), uint32(1), uint32(1))),
    );
    const track = box(
      'trak',
      box('mdia', box('hdlr', fullBox(uint32(0), ascii('meta'))), box('minf', table)),
    );
    const input = join(fileType, mediaData, box('moov', track));

    const output = stripMediaMetadataBytes(input, 'video/quicktime');
    expect(decoded(output)).not.toContain('GPS timed sample');
    expect(output.slice(sampleOffset, sampleOffset + sample.length)).toEqual(new Uint8Array(sample.length));
    expect(decoded(output)).toContain('free');
  });

  it('voids WebM tags, attachments, dates, and writing applications in place', () => {
    const title = ebml(new Uint8Array([0x7b, 0xa9]), ascii('private title'));
    const date = ebml(new Uint8Array([0x44, 0x61]), new Uint8Array(8).fill(7));
    const writer = ebml(new Uint8Array([0x57, 0x41]), ascii('camera app'));
    const info = ebml(new Uint8Array([0x15, 0x49, 0xa9, 0x66]), join(title, date, writer));
    const tags = ebml(new Uint8Array([0x12, 0x54, 0xc3, 0x67]), ascii('GPS and device tags'));
    const attachments = ebml(new Uint8Array([0x19, 0x41, 0xa4, 0x69]), ascii('embedded EXIF thumbnail'));
    const cluster = ebml(new Uint8Array([0x1f, 0x43, 0xb6, 0x75]), ascii('encoded webm frames'));
    const header = ebml(new Uint8Array([0x1a, 0x45, 0xdf, 0xa3]), new Uint8Array());
    const segment = ebml(new Uint8Array([0x18, 0x53, 0x80, 0x67]), join(info, tags, attachments, cluster));
    const input = join(header, segment);

    const output = stripMediaMetadataBytes(input, 'video/webm');
    expect(output.length).toBe(input.length);
    expect(decoded(output)).not.toMatch(/private title|camera app|GPS|EXIF thumbnail/);
    expect(decoded(output)).toContain('encoded webm frames');
  });
});
