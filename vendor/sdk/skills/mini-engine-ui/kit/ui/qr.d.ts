// Types for qr.js (uqr 0.1.3, MIT, see qr-LICENSE.txt), so a strict `tsc --checkJs` reads these instead of the untyped module.
// Keep qr.js itself out of the type check: "exclude": ["assets/ui/qr.js"] in the game's jsconfig.json.
export interface QrOptions {
  /** Error correction level; default 'L'. */
  ecc?: 'L' | 'M' | 'Q' | 'H';
  boostEcc?: boolean;
  minVersion?: number;
  maxVersion?: number;
  maskPattern?: number;
  /** Quiet zone in modules; default 1. */
  border?: number;
}
export interface QrSvgOptions extends QrOptions {
  pixelSize?: number;
  whiteColor?: string;
  blackColor?: string;
}
/** An SVG string with only a `viewBox`, a background rect and one path. */
export function renderSVG(data: string | number[], options?: QrSvgOptions): string;
