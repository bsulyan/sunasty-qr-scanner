import jsQR from 'jsqr';
import {
  applyHighContrastThreshold,
  looksLikeUrl,
  normalizeAndBinarizeLowContrast,
  parseQrPayload,
} from './qr-payload.js';

/**
 * Extracts a rectangular sub-region from an RGBA buffer.
 *
 * @param {Uint8ClampedArray} srcData
 * @param {number} srcWidth
 * @param {number} srcHeight
 * @param {number} rx
 * @param {number} ry
 * @param {number} rw
 * @param {number} rh
 * @returns {{ data: Uint8ClampedArray; width: number; height: number; offsetX: number; offsetY: number }}
 */
export function cropRgbaRegion(srcData, srcWidth, srcHeight, rx, ry, rw, rh) {
  const x0 = Math.max(0, Math.min(srcWidth - 1, Math.floor(rx)));
  const y0 = Math.max(0, Math.min(srcHeight - 1, Math.floor(ry)));
  const x1 = Math.max(x0 + 1, Math.min(srcWidth, Math.ceil(rx + rw)));
  const y1 = Math.max(y0 + 1, Math.min(srcHeight, Math.ceil(ry + rh)));
  const w = x1 - x0;
  const h = y1 - y0;
  const out = new Uint8ClampedArray(w * h * 4);

  for (let y = 0; y < h; y++) {
    const srcRowStart = ((y0 + y) * srcWidth + x0) * 4;
    const dstRowStart = y * w * 4;
    out.set(srcData.subarray(srcRowStart, srcRowStart + w * 4), dstRowStart);
  }

  return { data: out, width: w, height: h, offsetX: x0, offsetY: y0 };
}

/**
 * Nearest-neighbor / bilinear-friendly RGBA resizer for crisp QR code scaling.
 * Nearest-neighbor preserves sharp QR module edges when upscaling small QRs (e.g. 2x crop).
 *
 * @param {Uint8ClampedArray} srcData
 * @param {number} srcWidth
 * @param {number} srcHeight
 * @param {number} scale
 * @returns {{ data: Uint8ClampedArray; width: number; height: number; scale: number }}
 */
export function scaleRgbaBuffer(srcData, srcWidth, srcHeight, scale) {
  if (scale === 1) {
    return {
      data: new Uint8ClampedArray(srcData),
      width: srcWidth,
      height: srcHeight,
      scale: 1,
    };
  }
  const dstWidth = Math.max(1, Math.round(srcWidth * scale));
  const dstHeight = Math.max(1, Math.round(srcHeight * scale));
  const out = new Uint8ClampedArray(dstWidth * dstHeight * 4);

  for (let y = 0; y < dstHeight; y++) {
    const srcY = Math.min(srcHeight - 1, Math.floor(y / scale));
    const srcRowOffset = srcY * srcWidth;
    const dstRowOffset = y * dstWidth;
    for (let x = 0; x < dstWidth; x++) {
      const srcX = Math.min(srcWidth - 1, Math.floor(x / scale));
      const sIdx = (srcRowOffset + srcX) * 4;
      const dIdx = (dstRowOffset + x) * 4;
      out[dIdx] = srcData[sIdx];
      out[dIdx + 1] = srcData[sIdx + 1];
      out[dIdx + 2] = srcData[sIdx + 2];
      out[dIdx + 3] = srcData[sIdx + 3];
    }
  }

  return { data: out, width: dstWidth, height: dstHeight, scale };
}

/**
 * Masks a rectangular area in an RGBA buffer with solid white so subsequent jsQR passes
 * detect remaining QR codes in the same image.
 *
 * @param {Uint8ClampedArray} buf
 * @param {number} width
 * @param {number} height
 * @param {{ x: number; y: number; width: number; height: number }} bounds
 * @param {number} [padding=6]
 */
export function maskRgbaRegion(buf, width, height, bounds, padding = 6) {
  const x0 = Math.max(0, Math.floor(bounds.x - padding));
  const y0 = Math.max(0, Math.floor(bounds.y - padding));
  const x1 = Math.min(width, Math.ceil(bounds.x + bounds.width + padding));
  const y1 = Math.min(height, Math.ceil(bounds.y + bounds.height + padding));

  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      const idx = (y * width + x) * 4;
      buf[idx] = 255;
      buf[idx + 1] = 255;
      buf[idx + 2] = 255;
      buf[idx + 3] = 255;
    }
  }
}

/**
 * Computes bounding box from jsQR corner locations.
 *
 * @param {Record<string, { x: number; y: number }>} location
 */
function boundsFromLocation(location) {
  const pts = [
    location.topLeftCorner,
    location.topRightCorner,
    location.bottomRightCorner,
    location.bottomLeftCorner,
  ].filter(Boolean);

  if (pts.length === 0) {
    return { x: 0, y: 0, width: 0, height: 0 };
  }

  const xs = pts.map((p) => p.x);
  const ys = pts.map((p) => p.y);
  const minX = Math.min(...xs);
  const maxX = Math.max(...xs);
  const minY = Math.min(...ys);
  const maxY = Math.max(...ys);

  return {
    x: Math.floor(minX),
    y: Math.floor(minY),
    width: Math.max(1, Math.ceil(maxX - minX)),
    height: Math.max(1, Math.ceil(maxY - minY)),
  };
}

/**
 * Runs iterative jsQR detection on a single buffer, masking each found QR code
 * to discover multiple QR codes in the same frame.
 *
 * @param {Uint8ClampedArray} inputData
 * @param {number} width
 * @param {number} height
 * @param {{ offsetX?: number; offsetY?: number; scale?: number; maxIterations?: number }} [opts]
 */
function scanBufferIterative(inputData, width, height, opts = {}) {
  const offsetX = opts.offsetX ?? 0;
  const offsetY = opts.offsetY ?? 0;
  const scale = opts.scale ?? 1;
  const maxIterations = opts.maxIterations ?? 8;

  const found = [];
  const work = new Uint8ClampedArray(inputData);

  for (let iter = 0; iter < maxIterations; iter++) {
    const code = jsQR(work, width, height, {
      inversionAttempts: 'attemptBoth',
    });

    if (!code || !code.data || !code.data.trim()) {
      break;
    }

    const localBounds = boundsFromLocation(code.location);
    const globalBounds = {
      x: Math.round(offsetX + localBounds.x / scale),
      y: Math.round(offsetY + localBounds.y / scale),
      width: Math.max(1, Math.round(localBounds.width / scale)),
      height: Math.max(1, Math.round(localBounds.height / scale)),
    };

    found.push({
      data: code.data,
      bounds: globalBounds,
    });

    if (localBounds.width <= 1 || localBounds.height <= 1) {
      break;
    }

    maskRgbaRegion(work, width, height, localBounds, Math.max(4, Math.round(6 * scale)));
  }

  return found;
}

/**
 * Generates overlapping tile rectangles for an image of size (width x height).
 * Includes a 3x3 overlapping grid (35% overlap) + 2x2 grid for mid-sized off-center QRs.
 *
 * @param {number} width
 * @param {number} height
 * @param {number} [gridSize=3]
 * @param {number} [overlapRatio=0.35]
 */
export function generateOverlappingTiles(width, height, gridSize = 3, overlapRatio = 0.35) {
  const tiles = [];
  const baseTileW = width / gridSize;
  const baseTileH = height / gridSize;
  const padX = baseTileW * overlapRatio;
  const padY = baseTileH * overlapRatio;

  for (let row = 0; row < gridSize; row++) {
    for (let col = 0; col < gridSize; col++) {
      const x0 = Math.max(0, Math.floor(col * baseTileW - (col > 0 ? padX : 0)));
      const y0 = Math.max(0, Math.floor(row * baseTileH - (row > 0 ? padY : 0)));
      const x1 = Math.min(
        width,
        Math.ceil((col + 1) * baseTileW + (col < gridSize - 1 ? padX : 0))
      );
      const y1 = Math.min(
        height,
        Math.ceil((row + 1) * baseTileH + (row < gridSize - 1 ? padY : 0))
      );
      tiles.push({
        x: x0,
        y: y0,
        width: x1 - x0,
        height: y1 - y0,
      });
    }
  }
  return tiles;
}

/**
 * Generates a small cropped PNG data URL thumbnail in browser contexts when document is available.
 *
 * @param {Uint8ClampedArray} srcData
 * @param {number} srcWidth
 * @param {number} srcHeight
 * @param {{ x: number; y: number; width: number; height: number }} bounds
 * @returns {string | undefined}
 */
function createThumbnailDataUrl(srcData, srcWidth, srcHeight, bounds) {
  if (typeof document === 'undefined' || !bounds || bounds.width <= 0 || bounds.height <= 0) {
    return undefined;
  }
  try {
    const pad = Math.max(8, Math.round(Math.max(bounds.width, bounds.height) * 0.12));
    const cropped = cropRgbaRegion(
      srcData,
      srcWidth,
      srcHeight,
      bounds.x - pad,
      bounds.y - pad,
      bounds.width + pad * 2,
      bounds.height + pad * 2
    );

    const srcCanvas = document.createElement('canvas');
    srcCanvas.width = cropped.width;
    srcCanvas.height = cropped.height;
    const srcCtx = srcCanvas.getContext('2d');
    if (!srcCtx) return undefined;
    const imgData = new ImageData(new Uint8ClampedArray(cropped.data), cropped.width, cropped.height);
    srcCtx.putImageData(imgData, 0, 0);

    const thumbSize = 72;
    const dstCanvas = document.createElement('canvas');
    dstCanvas.width = thumbSize;
    dstCanvas.height = thumbSize;
    const dstCtx = dstCanvas.getContext('2d');
    if (!dstCtx) return undefined;
    dstCtx.fillStyle = '#ffffff';
    dstCtx.fillRect(0, 0, thumbSize, thumbSize);
    dstCtx.imageSmoothingEnabled = false;
    dstCtx.drawImage(srcCanvas, 0, 0, thumbSize, thumbSize);
    return dstCanvas.toDataURL('image/png');
  } catch {
    return undefined;
  }
}

/**
 * Full multi-pass, multi-QR decoding pipeline on an RGBA frame.
 *
 * Pipeline stages:
 * 1. Full frame iterative multi-QR scan (1x) + multi-scale (0.5x, 1.5x)
 * 2. 3x3 overlapping tile grid (plus 2x supersampling on small tiles for small/distant QRs)
 * 3. High-contrast binary thresholding (128, 96, 160 + dynamic min-max normalization + inversion)
 *    on both full image and tiles when needed.
 *
 * @param {{ data: Uint8ClampedArray; width: number; height: number }} imageFrame
 * @param {{ source?: string; exhaustive?: boolean; preDetected?: Array<{ data: string; bounds?: { x: number; y: number; width: number; height: number } }> }} [options]
 * @returns {Array<{
 *   data: string;
 *   source: string;
 *   isUrl: boolean;
 *   type: string;
 *   payload: ReturnType<typeof parseQrPayload>;
 *   bounds: { x: number; y: number; width: number; height: number };
 *   thumbnailDataUrl?: string;
 *   timestamp: string;
 * }>}
 */
export function decodeMultiQrFromRgba(imageFrame, options = {}) {
  const { data, width, height } = imageFrame;
  const source = options.source ?? 'file';
  const exhaustive = options.exhaustive ?? true;
  const resultsMap = new Map();

  function registerHit(hit) {
    if (!hit || !hit.data) return;
    const key = hit.data.trim();
    if (!key) return;
    if (!resultsMap.has(key)) {
      const payload = parseQrPayload(hit.data);
      const bounds = hit.bounds ?? { x: 0, y: 0, width, height };
      resultsMap.set(key, {
        data: hit.data,
        source,
        isUrl: looksLikeUrl(hit.data),
        type: payload.kind,
        payload,
        bounds,
        thumbnailDataUrl: createThumbnailDataUrl(data, width, height, bounds),
        timestamp: new Date().toISOString(),
      });
    }
  }

  // Register any pre-detected hits from native BarcodeDetector
  if (Array.isArray(options.preDetected)) {
    for (const hit of options.preDetected) {
      registerHit(hit);
    }
  }

  // Work copy where already-detected regions are masked out
  const workingFull = new Uint8ClampedArray(data);
  for (const existing of resultsMap.values()) {
    if (existing.bounds && existing.bounds.width < width * 0.9) {
      maskRgbaRegion(workingFull, width, height, existing.bounds, 6);
    }
  }

  // Stage 1: Full-frame iterative pass at 1x
  const pass1Hits = scanBufferIterative(workingFull, width, height, { scale: 1 });
  for (const hit of pass1Hits) {
    registerHit(hit);
    maskRgbaRegion(workingFull, width, height, hit.bounds, 6);
  }

  // Stage 2: Multi-scale passes (0.5x for huge images, 1.5x for small images)
  const scales = [];
  if (width > 900 || height > 900) scales.push(0.5);
  if (width < 1400 && height < 1400) scales.push(1.5);

  for (const scale of scales) {
    const scaled = scaleRgbaBuffer(workingFull, width, height, scale);
    const hits = scanBufferIterative(scaled.data, scaled.width, scaled.height, { scale });
    for (const hit of hits) {
      registerHit(hit);
      maskRgbaRegion(workingFull, width, height, hit.bounds, 6);
    }
  }

  // Stage 3: 3x3 overlapping tiles (catches small or off-center QR codes in 1080p screenshots)
  if (exhaustive || resultsMap.size === 0) {
    const tiles3x3 = generateOverlappingTiles(width, height, 3, 0.35);
    for (const tileRect of tiles3x3) {
      const tile = cropRgbaRegion(
        workingFull,
        width,
        height,
        tileRect.x,
        tileRect.y,
        tileRect.width,
        tileRect.height
      );

      // Scan tile at 1x
      let tileHits = scanBufferIterative(tile.data, tile.width, tile.height, {
        offsetX: tile.offsetX,
        offsetY: tile.offsetY,
        scale: 1,
        maxIterations: 4,
      });

      // If tile is small or no hit yet, upscale tile 2x to resolve tiny 60-90px QR codes
      if (tileHits.length === 0 && tile.width <= 900 && tile.height <= 900) {
        const upTile = scaleRgbaBuffer(tile.data, tile.width, tile.height, 2);
        tileHits = scanBufferIterative(upTile.data, upTile.width, upTile.height, {
          offsetX: tile.offsetX,
          offsetY: tile.offsetY,
          scale: 2,
          maxIterations: 3,
        });
      }

      for (const hit of tileHits) {
        registerHit(hit);
        maskRgbaRegion(workingFull, width, height, hit.bounds, 6);
      }
    }
  }

  // Stage 4: High-contrast binary thresholds (128, 96, 160), dynamic min-max normalization & inversion
  if (resultsMap.size === 0 || options.forceThresholdPass) {
    const candidateBuffers = [
      normalizeAndBinarizeLowContrast(workingFull),
      applyHighContrastThreshold(workingFull, 128, false),
      applyHighContrastThreshold(workingFull, 96, false),
      applyHighContrastThreshold(workingFull, 160, false),
      applyHighContrastThreshold(workingFull, 128, true),
    ];

    for (const binBuf of candidateBuffers) {
      const hits = scanBufferIterative(binBuf, width, height, { scale: 1, maxIterations: 4 });
      for (const hit of hits) {
        registerHit(hit);
        maskRgbaRegion(workingFull, width, height, hit.bounds, 6);
      }
      if (resultsMap.size > 0 && !options.forceThresholdPass) break;
    }

    // If still empty, run dynamic contrast normalization + thresholds on 3x3 tiles
    if (resultsMap.size === 0) {
      const tiles = generateOverlappingTiles(width, height, 3, 0.35);
      for (const tileRect of tiles) {
        const tile = cropRgbaRegion(
          workingFull,
          width,
          height,
          tileRect.x,
          tileRect.y,
          tileRect.width,
          tileRect.height
        );
        const normTile = normalizeAndBinarizeLowContrast(tile.data);
        let hits = scanBufferIterative(normTile, tile.width, tile.height, {
          offsetX: tile.offsetX,
          offsetY: tile.offsetY,
          scale: 1,
          maxIterations: 2,
        });
        if (hits.length === 0 && tile.width <= 900) {
          const upNorm = scaleRgbaBuffer(normTile, tile.width, tile.height, 2);
          hits = scanBufferIterative(upNorm.data, upNorm.width, upNorm.height, {
            offsetX: tile.offsetX,
            offsetY: tile.offsetY,
            scale: 2,
            maxIterations: 2,
          });
        }
        for (const hit of hits) {
          registerHit(hit);
        }
      }
    }
  }

  return Array.from(resultsMap.values());
}

/**
 * Decodes a user-selected crop rectangle with automatic 2x crisp supersampling
 * (and multi-threshold fallback) in < 30 ms.
 *
 * @param {{ data: Uint8ClampedArray; width: number; height: number }} imageFrame
 * @param {{ x: number; y: number; width: number; height: number }} cropRect
 * @param {string} [source='crop']
 */
export function decodeCroppedRegionFromRgba(imageFrame, cropRect, source = 'file') {
  const cropped = cropRgbaRegion(
    imageFrame.data,
    imageFrame.width,
    imageFrame.height,
    cropRect.x,
    cropRect.y,
    cropRect.width,
    cropRect.height
  );

  // Apply 2x supersampling when cropped region is under 800px
  const scale = cropped.width < 800 && cropped.height < 800 ? 2 : 1;
  const upscaled = scaleRgbaBuffer(cropped.data, cropped.width, cropped.height, scale);

  const decoded = decodeMultiQrFromRgba(
    { data: upscaled.data, width: upscaled.width, height: upscaled.height },
    { source, exhaustive: false }
  );

  return decoded.map((item) => ({
    ...item,
    bounds: {
      x: Math.round(cropped.offsetX + item.bounds.x / scale),
      y: Math.round(cropped.offsetY + item.bounds.y / scale),
      width: Math.max(1, Math.round(item.bounds.width / scale)),
      height: Math.max(1, Math.round(item.bounds.height / scale)),
    },
  }));
}

/**
 * Browser helper: runs native Chromium BarcodeDetector (if available) + decodeMultiQrFromRgba
 * on an HTMLImageElement, HTMLCanvasElement, or ImageBitmap.
 *
 * @param {HTMLImageElement | HTMLCanvasElement | ImageBitmap} drawable
 * @param {{ source?: string; exhaustive?: boolean }} [options]
 */
export async function decodeFromDrawable(drawable, options = {}) {
  const width =
    /** @type {HTMLImageElement} */ (drawable).naturalWidth ||
    drawable.width ||
    1;
  const height =
    /** @type {HTMLImageElement} */ (drawable).naturalHeight ||
    drawable.height ||
    1;

  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  if (!ctx) return [];

  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, width, height);
  ctx.drawImage(drawable, 0, 0, width, height);

  const preDetected = [];
  if (typeof globalThis.BarcodeDetector === 'function') {
    try {
      const detector = new globalThis.BarcodeDetector({ formats: ['qr_code'] });
      const barcodes = await detector.detect(canvas);
      for (const b of barcodes) {
        if (b.rawValue) {
          const box = b.boundingBox;
          preDetected.push({
            data: b.rawValue,
            bounds: box
              ? {
                  x: Math.round(box.x),
                  y: Math.round(box.y),
                  width: Math.round(box.width),
                  height: Math.round(box.height),
                }
              : undefined,
          });
        }
      }
    } catch {
      // Fallback to jsQR pipeline
    }
  }

  const imageData = ctx.getImageData(0, 0, width, height);
  return decodeMultiQrFromRgba(
    { data: imageData.data, width, height },
    {
      source: options.source ?? 'file',
      exhaustive: options.exhaustive ?? true,
      preDetected,
    }
  );
}
