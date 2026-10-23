import qrcodeFactory from 'qrcode-generator';

if (qrcodeFactory && qrcodeFactory.stringToBytesFuncs && qrcodeFactory.stringToBytesFuncs['UTF-8']) {
  qrcodeFactory.stringToBytes = qrcodeFactory.stringToBytesFuncs['UTF-8'];
}

export const VALID_ECC_LEVELS = ['L', 'M', 'Q', 'H'];

/**
 * Creates a QR matrix for the given UTF-8 text and error correction level.
 *
 * @param {string} text
 * @param {'L' | 'M' | 'Q' | 'H'} [ecc='M']
 * @returns {{ count: number; isDark: (row: number, col: number) => boolean }}
 */
export function createQrMatrix(text, ecc = 'M') {
  const cleanText = String(text ?? '').trim() || 'https://sunasty.com/qr-scan/';
  const level = VALID_ECC_LEVELS.includes(ecc) ? ecc : 'M';
  const qr = qrcodeFactory(0, level);
  qr.addData(cleanText);
  qr.make();
  const count = qr.getModuleCount();
  return {
    count,
    isDark: (row, col) => qr.isDark(row, col),
  };
}

/**
 * Generates a crisp vector SVG string for a QR code.
 *
 * @param {string} text
 * @param {{ ecc?: 'L' | 'M' | 'Q' | 'H'; margin?: number; size?: number; darkColor?: string; lightColor?: string }} [options]
 * @returns {string}
 */
export function generateQrSvg(text, options = {}) {
  const ecc = options.ecc ?? 'M';
  const margin = Number.isFinite(options.margin) ? Math.max(0, options.margin) : 2;
  const size = options.size ?? 1024;
  const darkColor = options.darkColor ?? '#111113';
  const lightColor = options.lightColor ?? '#ffffff';

  const matrix = createQrMatrix(text, ecc);
  const totalModules = matrix.count + margin * 2;
  const parts = [];

  for (let r = 0; r < matrix.count; r++) {
    for (let c = 0; c < matrix.count; c++) {
      if (matrix.isDark(r, c)) {
        const x = c + margin;
        const y = r + margin;
        parts.push(`M${x},${y}h1v1h-1z`);
      }
    }
  }

  return [
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${totalModules} ${totalModules}" width="${size}" height="${size}" shape-rendering="crispEdges" role="img" aria-label="QR Code">`,
    `  <rect width="${totalModules}" height="${totalModules}" fill="${lightColor}"/>`,
    `  <path d="${parts.join('')}" fill="${darkColor}"/>`,
    `</svg>`,
  ].join('\n');
}

/**
 * Renders a QR code into a pure RGBA pixel buffer (usable in Node or Browser).
 *
 * @param {string} text
 * @param {{
 *   ecc?: 'L' | 'M' | 'Q' | 'H';
 *   margin?: number;
 *   size?: number;
 *   darkRgb?: [number, number, number];
 *   lightRgb?: [number, number, number];
 * }} [options]
 * @returns {{ data: Uint8ClampedArray; width: number; height: number }}
 */
export function generateQrRgba(text, options = {}) {
  const ecc = options.ecc ?? 'M';
  const margin = Number.isFinite(options.margin) ? Math.max(0, options.margin) : 2;
  const size = options.size ?? 256;
  const darkRgb = options.darkRgb ?? [0, 0, 0];
  const lightRgb = options.lightRgb ?? [255, 255, 255];

  const matrix = createQrMatrix(text, ecc);
  const totalModules = matrix.count + margin * 2;
  const data = new Uint8ClampedArray(size * size * 4);

  for (let y = 0; y < size; y++) {
    const modR = Math.floor((y * totalModules) / size) - margin;
    for (let x = 0; x < size; x++) {
      const modC = Math.floor((x * totalModules) / size) - margin;
      const isDark =
        modR >= 0 &&
        modR < matrix.count &&
        modC >= 0 &&
        modC < matrix.count &&
        matrix.isDark(modR, modC);
      const rgb = isDark ? darkRgb : lightRgb;
      const idx = (y * size + x) * 4;
      data[idx] = rgb[0];
      data[idx + 1] = rgb[1];
      data[idx + 2] = rgb[2];
      data[idx + 3] = 255;
    }
  }

  return { data, width: size, height: size };
}

/**
 * Renders a QR code onto an HTMLCanvasElement and returns its PNG data URL.
 *
 * @param {HTMLCanvasElement} canvas
 * @param {string} text
 * @param {{ ecc?: 'L' | 'M' | 'Q' | 'H'; margin?: number; size?: number; darkColor?: string; lightColor?: string }} [options]
 * @returns {string}
 */
export function renderQrToCanvas(canvas, text, options = {}) {
  const ecc = options.ecc ?? 'M';
  const margin = Number.isFinite(options.margin) ? Math.max(0, options.margin) : 2;
  const size = options.size ?? 1024;
  const darkColor = options.darkColor ?? '#111113';
  const lightColor = options.lightColor ?? '#ffffff';

  const matrix = createQrMatrix(text, ecc);
  const totalModules = matrix.count + margin * 2;

  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d');
  if (!ctx) return '';

  ctx.imageSmoothingEnabled = false;
  ctx.fillStyle = lightColor;
  ctx.fillRect(0, 0, size, size);

  ctx.fillStyle = darkColor;
  for (let r = 0; r < matrix.count; r++) {
    for (let c = 0; c < matrix.count; c++) {
      if (matrix.isDark(r, c)) {
        const x0 = Math.floor(((c + margin) * size) / totalModules);
        const y0 = Math.floor(((r + margin) * size) / totalModules);
        const x1 = Math.floor(((c + margin + 1) * size) / totalModules);
        const y1 = Math.floor(((r + margin + 1) * size) / totalModules);
        ctx.fillRect(x0, y0, Math.max(1, x1 - x0), Math.max(1, y1 - y0));
      }
    }
  }

  return canvas.toDataURL('image/png');
}
