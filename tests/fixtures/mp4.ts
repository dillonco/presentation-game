/** Builds MP4 files box by box, enough to check how uploads are cleaned without a real camera. */

export function box(type: string, ...contents: Buffer[]): Buffer {
  const body = Buffer.concat(contents);
  const header = Buffer.alloc(8);
  header.writeUInt32BE(body.length + 8, 0);
  header.write(type, 4, 'latin1');
  return Buffer.concat([header, body]);
}

/** A box with a version and flags before its contents, as most headers have. */
export function fullBox(type: string, version: number, ...contents: Buffer[]): Buffer {
  return box(type, Buffer.from([version, 0, 0, 0]), ...contents);
}

/** Made 2024-05-01 and changed a second later, counted from 1904 as MP4 does. */
export const MADE_AT = 3_797_452_800;

function dated(type: string, rest: Buffer): Buffer {
  const dates = Buffer.alloc(8);
  dates.writeUInt32BE(MADE_AT, 0);
  dates.writeUInt32BE(MADE_AT + 1, 4);
  return fullBox(type, 0, dates, rest);
}

function handler(kind: string): Buffer {
  const fields = Buffer.alloc(20);
  fields.write(kind, 4, 'latin1');
  return fullBox('hdlr', 0, fields, Buffer.from('Handler\0'));
}

function track(kind: string, ...extra: Buffer[]): Buffer {
  return box(
    'trak',
    dated('tkhd', Buffer.alloc(72)),
    box('mdia', dated('mdhd', Buffer.alloc(8)), handler(kind), box('minf', box('stbl'))),
    ...extra,
  );
}

export const PICTURE = Buffer.from('PICTURE-AND-SOUND-DATA');

/**
 * A video as a phone saves it: the location and camera in the movie's metadata, more in a track's
 * user data, an XMP packet at the top level, and a track of timed metadata.
 */
export function phoneVideo(): Buffer {
  const keys = box('keys', Buffer.from('com.apple.quicktime.location.ISO6709'));
  const list = box('ilst', Buffer.from('+35.6586+139.7454/SecretPhoneModel'));
  return Buffer.concat([
    box('ftyp', Buffer.from('qt  \0\0\0\0qt  ')),
    box('wide'),
    box('mdat', PICTURE),
    box(
      'moov',
      dated('mvhd', Buffer.alloc(88)),
      track('vide', box('udta', box('\xA9xyz', Buffer.from('+35.6586+139.7454/')))),
      track('soun'),
      track('meta'),
      fullBox('meta', 0, handler('mdta'), keys, list),
      box('udta', box('\xA9mak', Buffer.from('SecretCameraMake'))),
    ),
    box('uuid', Buffer.from('BE7ACFCB97A942E89C71999491E3AFAC<x:xmpmeta>SecretSoftware</x:xmpmeta>')),
  ]);
}
