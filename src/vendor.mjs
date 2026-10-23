import { readFileSync } from 'node:fs';

export const VENDOR_DIR = new URL('../vendor/', import.meta.url);
export const SKILLS_DIR = new URL('sdk/skills/', VENDOR_DIR);
export const PACKAGE = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));

export function vendorInfo() {
  try {
    return JSON.parse(readFileSync(new URL('VENDOR.json', VENDOR_DIR), 'utf8')).sdk;
  } catch {
    return null;
  }
}
