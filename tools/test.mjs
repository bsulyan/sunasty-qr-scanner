#!/usr/bin/env node

import assert from 'node:assert/strict';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { chromium } from '@playwright/test';
import sharp from 'sharp';

import {
  decodeCroppedRegionFromRgba,
  decodeMultiQrFromRgba,
} from '../src/core/qr-decoder.js';
import {
  generateQrRgba,
  generateQrSvg,
} from '../src/core/qr-generator.js';
import {
  generateTotpCode,
  parseQrPayload,
  serializeScanHistoryToCsv,
} from '../src/core/qr-payload.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const EXT_DIR = resolve(__dirname, '..');

function blitRgba(dstData, dstW, dstH, src, destX, destY) {
  for (let y = 0; y < src.height; y++) {
    const dy = destY + y;
    if (dy < 0 || dy >= dstH) continue;
    for (let x = 0; x < src.width; x++) {
      const dx = destX + x;
      if (dx < 0 || dx >= dstW) continue;
      const sIdx = (y * src.width + x) * 4;
      const dIdx = (dy * dstW + dx) * 4;
      dstData[dIdx] = src.data[sIdx];
      dstData[dIdx + 1] = src.data[sIdx + 1];
      dstData[dIdx + 2] = src.data[sIdx + 2];
      dstData[dIdx + 3] = src.data[sIdx + 3];
    }
  }
}

function createBlankRgba(width, height, bg = [255, 255, 255]) {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let i = 0; i < data.length; i += 4) {
    data[i] = bg[0];
    data[i + 1] = bg[1];
    data[i + 2] = bg[2];
    data[i + 3] = 255;
  }
  return { data, width, height };
}

async function rgbaToPngDataUrl(frame) {
  const pngBuf = await sharp(Buffer.from(frame.data.buffer), {
    raw: { width: frame.width, height: frame.height, channels: 4 },
  })
    .png()
    .toBuffer();
  return `data:image/png;base64,${pngBuf.toString('base64')}`;
}

async function runUnitTests() {
  console.log('Running unit tests...');

  const rfcSecret = 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ';
  const rfcTotp = await generateTotpCode(rfcSecret, 59000, 30, 6);
  assert.equal(rfcTotp.code, '287082');
  assert.equal(rfcTotp.remainingSeconds, 1);

  const liveTotp = await generateTotpCode('JBSWY3DPEHPK3PXP', 1700000000000, 30, 6);
  assert.match(liveTotp.code, /^\d{6}$/);

  const urlSecure = parseQrPayload('https://sunasty.com/qr-scan/?ref=ext');
  assert.equal(urlSecure.kind, 'url');
  assert.equal(urlSecure.domain, 'sunasty.com');
  assert.equal(urlSecure.isInsecureHttp, false);
  assert.equal(urlSecure.hasSecurityWarning, false);

  const urlInsecure = parseQrPayload('http://192.168.1.1/login');
  assert.equal(urlInsecure.kind, 'url');
  assert.equal(urlInsecure.isInsecureHttp, true);
  assert.equal(urlInsecure.isRawIp, true);
  assert.equal(urlInsecure.hasSecurityWarning, true);

  const wifiParsed = parseQrPayload('WIFI:S:SunastyFiber5G;T:WPA2;P:FiberGuest2026!;H:false;;');
  assert.equal(wifiParsed.kind, 'wifi');
  assert.equal(wifiParsed.ssid, 'SunastyFiber5G');
  assert.equal(wifiParsed.encryption, 'WPA2');
  assert.equal(wifiParsed.password, 'FiberGuest2026!');

  const totpParsed = parseQrPayload(
    'otpauth://totp/Sunasty:bastien@ulysan.fr?secret=JBSWY3DPEHPK3PXP&issuer=Sunasty'
  );
  assert.equal(totpParsed.kind, 'totp');
  assert.equal(totpParsed.issuer, 'Sunasty');
  assert.equal(totpParsed.account, 'bastien@ulysan.fr');
  assert.equal(totpParsed.secret, 'JBSWY3DPEHPK3PXP');

  const vcardParsed = parseQrPayload(
    'BEGIN:VCARD\nVERSION:3.0\nFN:Bastien Sulyan\nORG:Ulysan\nTEL:+33612345678\nEMAIL:contact@ulysan.fr\nEND:VCARD'
  );
  assert.equal(vcardParsed.kind, 'vcard');
  assert.equal(vcardParsed.fullName, 'Bastien Sulyan');
  assert.equal(vcardParsed.org, 'Ulysan');

  const csvOut = serializeScanHistoryToCsv([
    {
      timestamp: '2026-10-21T12:00:00.000Z',
      source: 'file',
      type: 'url',
      isUrl: true,
      data: 'https://sunasty.com/qr-scan/',
    },
  ]);
  assert.ok(csvOut.includes('timestamp,source,type,isUrl,data'));
  assert.ok(csvOut.includes('https://sunasty.com/qr-scan/'));

  const qr1Text = 'otpauth://totp/Sunasty:bastien@ulysan.fr?secret=JBSWY3DPEHPK3PXP&issuer=Sunasty';
  const qr2Text = 'https://sunasty.com/qr-scan/';
  const qr3Text = 'WIFI:S:SunastyFiber5G;T:WPA2;P:FiberGuest2026!;;';

  const qr1Img = generateQrRgba(qr1Text, { size: 220, margin: 2 });
  const qr2Img = generateQrRgba(qr2Text, { size: 220, margin: 2 });
  const qr3Img = generateQrRgba(qr3Text, { size: 220, margin: 2 });

  const multiCanvas = createBlankRgba(820, 280, [248, 250, 252]);
  blitRgba(multiCanvas.data, multiCanvas.width, multiCanvas.height, qr1Img, 30, 30);
  blitRgba(multiCanvas.data, multiCanvas.width, multiCanvas.height, qr2Img, 300, 30);
  blitRgba(multiCanvas.data, multiCanvas.width, multiCanvas.height, qr3Img, 570, 30);

  const multiHits = decodeMultiQrFromRgba(multiCanvas, { source: 'file', exhaustive: true });
  const decodedTexts = multiHits.map((h) => h.data);
  assert.equal(multiHits.length, 3);
  assert.ok(decodedTexts.includes(qr1Text));
  assert.ok(decodedTexts.includes(qr2Text));
  assert.ok(decodedTexts.includes(qr3Text));

  const smallQrText = 'https://ulysan.fr/';
  const smallQr = generateQrRgba(smallQrText, { size: 84, margin: 2 });
  const largeScreen = createBlankRgba(1200, 800, [250, 250, 252]);
  blitRgba(largeScreen.data, largeScreen.width, largeScreen.height, smallQr, 1060, 660);

  const offCenterHits = decodeMultiQrFromRgba(largeScreen, { source: 'file', exhaustive: true });
  assert.ok(offCenterHits.some((h) => h.data === smallQrText));

  const lowContrastText = 'mailto:contact@sunasty.com?subject=LowContrastQR';
  const lowContrastQr = generateQrRgba(lowContrastText, {
    size: 220,
    margin: 2,
    darkRgb: [110, 110, 115],
    lightRgb: [155, 155, 160],
  });
  const lowContrastHits = decodeMultiQrFromRgba(lowContrastQr, {
    source: 'file',
    exhaustive: true,
    forceThresholdPass: true,
  });
  assert.ok(lowContrastHits.some((h) => h.data === lowContrastText));

  const croppedHits = decodeCroppedRegionFromRgba(
    largeScreen,
    { x: 1045, y: 645, width: 115, height: 115 },
    'file'
  );
  assert.equal(croppedHits.length, 1);
  assert.equal(croppedHits[0].data, smallQrText);

  const svgStr = generateQrSvg('https://sunasty.com/qr-code/', { ecc: 'H', margin: 2, size: 1024 });
  assert.ok(svgStr.startsWith('<svg') && svgStr.includes('<path d="M'));

  console.log('Unit tests passed.');
  return { multiCanvas };
}

async function launchChromiumBrowser() {
  try {
    return await chromium.launch({ headless: true });
  } catch {
    return await chromium.launch({ channel: 'chrome', headless: true });
  }
}

async function runPlaywrightE2E(multiCanvas) {
  console.log('Running Playwright E2E tests...');
  const multiDataUrl = await rgbaToPngDataUrl(multiCanvas);

  const browser = await launchChromiumBrowser();
  try {
    const page = await browser.newPage({ viewport: { width: 400, height: 560 } });
    const consoleErrors = [];
    const pageErrors = [];

    page.on('console', (msg) => {
      if (msg.type() === 'error') consoleErrors.push(msg.text());
    });
    page.on('pageerror', (err) => pageErrors.push(String(err)));

    const popupFileUrl = pathToFileURL(join(EXT_DIR, 'popup.html')).href;
    await page.goto(`${popupFileUrl}?lang=en&theme=light`, { waitUntil: 'load' });
    await page.waitForFunction(() => Boolean(window.__SUNASTY_QR__));

    await page.evaluate(async (dataUrl) => {
      await window.__SUNASTY_QR__.processImageDataUrl(dataUrl, { source: 'file' });
    }, multiDataUrl);

    const cardCount = await page.locator('#scan-results-list .qr-card').count();
    assert.equal(cardCount, 3);

    const totpText = await page.locator('.js-totp-digits').first().textContent();
    assert.match(totpText?.trim() || '', /^\d{3}\s\d{3}$/);

    await page.click('#btn-select-area');
    assert.equal(await page.locator('#crop-workspace').isVisible(), true);
    await page.click('#btn-close-crop');

    await page.click('#tab-btn-camera');
    assert.equal(await page.locator('#panel-camera').isVisible(), true);

    await page.click('#tab-btn-generate');
    assert.equal(await page.locator('#panel-generate').isVisible(), true);
    await page.fill('#gen-text-input', 'https://sunasty.com/qr-code/');
    await page.selectOption('#gen-ecc-select', 'H');
    const previewDataUrl = await page.evaluate(() => {
      const c = /** @type {HTMLCanvasElement} */ (document.getElementById('gen-preview-canvas'));
      return c.toDataURL('image/png');
    });
    assert.ok(previewDataUrl.startsWith('data:image/png;base64,'));

    await page.click('#tab-btn-history');
    const histCount = await page.locator('#history-list .qr-card').count();
    assert.equal(histCount, 3);

    const camPage = await browser.newPage({ viewport: { width: 800, height: 600 } });
    camPage.on('console', (msg) => {
      if (msg.type() === 'error') consoleErrors.push(msg.text());
    });
    camPage.on('pageerror', (err) => pageErrors.push(String(err)));
    const camFileUrl = pathToFileURL(join(EXT_DIR, 'camera.html')).href;
    await camPage.goto(camFileUrl, { waitUntil: 'load' });
    const camHeader = await camPage.locator('.qr-title').textContent();
    assert.ok(camHeader?.includes('Sunasty QR'));
    await camPage.close();

    assert.equal(consoleErrors.length, 0, `Console errors: ${consoleErrors.join('; ')}`);
    assert.equal(pageErrors.length, 0, `Page errors: ${pageErrors.join('; ')}`);
    console.log('Playwright E2E tests passed.');
  } finally {
    await browser.close();
  }
}

async function main() {
  const { multiCanvas } = await runUnitTests();
  await runPlaywrightE2E(multiCanvas);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
