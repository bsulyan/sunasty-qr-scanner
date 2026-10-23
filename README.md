# Sunasty QR Code Scanner & Generator

Chrome extension (Manifest V3) for scanning and generating QR codes locally in the browser.

Web tools: [Sunasty QR Scanner](https://sunasty.com/qr-scan/) | [Sunasty QR Generator](https://sunasty.com/qr-code/) | [Ulysan](https://ulysan.fr/)

---

## Overview

`sunasty-qr-scanner` decodes and generates QR codes directly in the browser without sending images or payloads to external servers.

### Features

- **Active tab scan**: captures the visible tab via `chrome.tabs.captureVisibleTab` when opening the popup or pressing `Alt+Shift+Q`.
- **Interactive area crop**: drag a selection rectangle in the popup or directly on the active page (works on images, `<canvas>`, video frames, and PDF viewers) with 2x nearest-neighbor supersampling for small codes.
- **Multi-QR detection**: combines Chromium's `BarcodeDetector` (when available) with an iterative `jsQR` pipeline (full frame, multi-scale, 3x3 overlapping tiles, and luminance thresholding for low-contrast or inverted codes).
- **Image import**: drag and drop, file picker, clipboard paste (`Ctrl+V`), or right-click context menu on any web image.
- **Webcam scanner**: live camera feed with device selection and mirror toggle.
- **Structured payload parsing**:
  - `WIFI:` network credentials (SSID, encryption type, password copy).
  - `otpauth://totp/` 2FA secrets with live 6-digit RFC 6238 `HMAC-SHA1` code generation via the Web Crypto API.
  - `BEGIN:VCARD` contact cards with `.vcf` export.
  - `http://` and `https://` URLs, `mailto:`, `tel:`, `sms:`, and plain text.
- **QR code generator**: exports crisp 1024x1024 PNG and vector SVG with configurable error correction (`L`, `M`, `Q`, `H`) and quiet zone margin.
- **Local history**: optional history stored in `chrome.storage.local` with search and CSV/JSON export.

---

## Development

### Prerequisites

- Node.js 20+
- npm

### Build

```bash
npm install
npm run build
```

This compiles `src/popup-entry.js` and `src/camera-entry.js` with `esbuild`, generates the localized `_locales/` files and PNG icons in `icons/`, writes `manifest.json`, and packages the extension archive in `dist/`.

### Test

```bash
npm test
```

Runs the Node unit test suite (TOTP RFC 6238 vectors, payload parser, multi-QR tile decoder, low-contrast thresholding) followed by Playwright Chromium E2E tests on `popup.html` and `camera.html`.

### Load unpacked in Chrome

1. Run `npm run build`.
2. Open `chrome://extensions` in Chrome.
3. Enable **Developer mode**.
4. Click **Load unpacked** and select the repository root folder.

---

## Note en français

Extension Chrome (Manifest V3) permettant de scanner et de générer des codes QR localement dans le navigateur (capture de l'onglet actif, sélection de zone sur la page, import d'image, caméra, décodage multi-QR, codes 2FA TOTP, Wi-Fi, vCard et export PNG/SVG). Retrouvez également la version web sur [sunasty.com/qr-scan](https://sunasty.com/qr-scan/) et [sunasty.com/qr-code](https://sunasty.com/qr-code/).

## License

[MIT](./LICENSE) — Copyright (c) 2026 [Bastien Sulyan (Ulysan)](https://ulysan.fr/)
