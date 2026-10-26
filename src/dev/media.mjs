import { closeSync, lstatSync, openSync, readSync } from 'node:fs';
import { lstat, readFile } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { bad } from './errors.mjs';
import { MEDIA_URL, noImage } from './schema.mjs';

// Images for a --set file live in a media/ folder next to it and are named in the set as /media/<name>.
export const MEDIA_NAME = /^[A-Za-z0-9_-][A-Za-z0-9._-]{0,127}$/;
/** The largest upload the engine takes; it shrinks what it stores, me dev serves the file as it is. */
export const MAX_MEDIA_BYTES = 10 * 1024 * 1024;
export const MEDIA_CSP = "default-src 'none'; sandbox";

export const mediaFolder = setFile => join(dirname(setFile), 'media');

/** The image type by its first bytes, like the engine: PNG, JPEG, WebP or GIF, anything else is null. */
export function sniffImage(head) {
  const ascii = (start, end) => head.subarray(start, end).toString('latin1');
  if (head.length >= 8 && head.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png';
  if (head.length >= 3 && head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff) return 'image/jpeg';
  if (['GIF87a', 'GIF89a'].includes(ascii(0, 6))) return 'image/gif';
  if (ascii(0, 4) === 'RIFF' && ascii(8, 12) === 'WEBP') return 'image/webp';
  return null;
}

function readHead(path) {
  const fd = openSync(path, 'r');
  try {
    const head = Buffer.alloc(12);
    return head.subarray(0, readSync(fd, head, 0, 12, 0));
  } finally {
    closeSync(fd);
  }
}

/** Checks an image value of a --set file: /media/<id> of an upload, or /media/<name> of an image in the media/ folder. */
export function setImageChecker(setFile) {
  const folder = mediaFolder(setFile);
  const where = `media/ naast ${basename(setFile)}`;
  return (value, path) => {
    noImage(value, path);
    if (MEDIA_URL.test(value)) return;
    if (!value.startsWith('/media/')) {
      throw bad(`${path}: verwacht een afbeelding: /media/<naam> van een bestand in ${where}, of /media/ met het id van een upload.`);
    }
    const name = value.slice('/media/'.length);
    if (!MEDIA_NAME.test(name)) {
      throw bad(`${path}: ${value} is geen geldige naam; gebruik alleen letters, cijfers, ., _ en - (niet beginnend met een punt).`);
    }
    let stat;
    try {
      stat = lstatSync(join(folder, name));
    } catch {
      throw bad(`${path}: ${name} staat niet in ${where}.`);
    }
    if (!stat.isFile()) throw bad(`${path}: ${name} in ${where} is geen gewoon bestand.`);
    if (stat.size > MAX_MEDIA_BYTES) throw bad(`${path}: ${name} is groter dan 10 MiB; zo'n afbeelding neemt de server niet aan.`);
    if (!sniffImage(readHead(join(folder, name)))) throw bad(`${path}: ${name} is geen PNG, JPEG, WebP of GIF.`);
  };
}

/** The bytes and type of /media/<name> from the media/ folder, or null when there is no such image. */
export async function readMedia(folder, name) {
  if (!folder || !MEDIA_NAME.test(name)) return null;
  const path = join(folder, name);
  try {
    const stat = await lstat(path);
    if (!stat.isFile() || stat.size > MAX_MEDIA_BYTES) return null;
    const bytes = await readFile(path);
    const type = sniffImage(bytes.subarray(0, 12));
    return type ? { bytes, type } : null;
  } catch {
    return null;
  }
}
