import {
  decodeCroppedRegionFromRgba,
  decodeFromDrawable,
  decodeMultiQrFromRgba,
} from './core/qr-decoder.js';
import {
  generateQrRgba,
  generateQrSvg,
  renderQrToCanvas,
} from './core/qr-generator.js';
import {
  generateTotpCode,
  looksLikeUrl,
  parseQrPayload,
  serializeScanHistoryToCsv,
  serializeScanHistoryToJson,
  truncateForDisplay,
} from './core/qr-payload.js';
import { resolveLocale, t } from './core/i18n.js';

const STORAGE_KEY_HISTORY = 'sunasty_qr_history';
const STORAGE_KEY_HISTORY_ENABLED = 'sunasty_qr_history_enabled';
const STORAGE_KEY_THEME = 'sunasty_qr_theme';
const MAX_HISTORY_ITEMS = 100;

let currentLocale = resolveLocale();
let currentTheme = 'light';
let activeTabName = 'scan';
let historyItems = [];
let historyEnabled = true;
let totpIntervalId = null;

// Last loaded/captured RGBA frame for interactive cropping
let currentSourceFrame = null;
let currentSourceDataUrl = null;

// Camera state
let cameraStream = null;
let cameraTimerId = null;
let cameraMirrored = false;

/**
 * Storage wrapper compatible with both chrome.storage.local and standalone localStorage.
 */
const storage = {
  async get(keys) {
    if (typeof chrome !== 'undefined' && chrome.storage?.local) {
      return new Promise((resolve) => {
        chrome.storage.local.get(keys, (res) => resolve(res || {}));
      });
    }
    const out = {};
    const list = Array.isArray(keys) ? keys : [keys];
    for (const k of list) {
      try {
        const raw = localStorage.getItem(k);
        if (raw !== null) out[k] = JSON.parse(raw);
      } catch {
        // ignore
      }
    }
    return out;
  },
  async set(obj) {
    if (typeof chrome !== 'undefined' && chrome.storage?.local) {
      return new Promise((resolve) => {
        chrome.storage.local.set(obj, () => resolve());
      });
    }
    for (const [k, v] of Object.entries(obj)) {
      try {
        localStorage.setItem(k, JSON.stringify(v));
      } catch {
        // ignore
      }
    }
  },
  async remove(key) {
    if (typeof chrome !== 'undefined' && chrome.storage?.local) {
      return new Promise((resolve) => {
        chrome.storage.local.remove(key, () => resolve());
      });
    }
    try {
      localStorage.removeItem(key);
    } catch {
      // ignore
    }
  },
};

/**
 * Displays a transient toast notification at the bottom of the popup.
 * @param {string} msg
 */
function showToast(msg) {
  const banner = document.getElementById('toast-banner');
  if (!banner) return;
  banner.textContent = msg;
  banner.hidden = false;
  clearTimeout(banner._timer);
  banner._timer = setTimeout(() => {
    banner.hidden = true;
  }, 1900);
}

/**
 * Copies text to clipboard and triggers toast.
 * @param {string} text
 */
async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    const ta = document.createElement('textarea');
    ta.value = text;
    document.body.appendChild(ta);
    ta.select();
    document.execCommand('copy');
    ta.remove();
  }
  showToast(t('copiedToast', currentLocale));
}

/**
 * Triggers a browser file download from a Blob or data URL.
 * @param {string} filename
 * @param {string | Blob} contentOrUrl
 * @param {string} [mime]
 */
function triggerDownload(filename, contentOrUrl, mime = 'text/plain;charset=utf-8') {
  let url = '';
  let revoke = false;
  if (typeof contentOrUrl === 'string' && contentOrUrl.startsWith('data:')) {
    url = contentOrUrl;
  } else {
    const blob =
      contentOrUrl instanceof Blob
        ? contentOrUrl
        : new Blob([contentOrUrl], { type: mime });
    url = URL.createObjectURL(blob);
    revoke = true;
  }
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  if (revoke) {
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
}

/**
 * Applies i18n translations to all [data-i18n] elements.
 * @param {string} [locale]
 */
function applyTranslations(locale = currentLocale) {
  currentLocale = resolveLocale(locale);
  document.documentElement.lang = currentLocale.replace('_', '-');

  const elements = document.querySelectorAll('[data-i18n]');
  for (const el of elements) {
    const key = el.getAttribute('data-i18n');
    if (key) {
      el.textContent = t(key, currentLocale);
    }
  }

  const genInput = document.getElementById('gen-text-input');
  if (genInput) {
    genInput.setAttribute('placeholder', t('genInputPlaceholder', currentLocale));
  }
  const histSearch = document.getElementById('history-search-input');
  if (histSearch) {
    histSearch.setAttribute('placeholder', t('histSearchPlaceholder', currentLocale));
  }
  const themeBtn = document.getElementById('btn-theme-toggle');
  if (themeBtn) {
    const label = t('themeToggleTitle', currentLocale);
    themeBtn.title = label;
    themeBtn.setAttribute('aria-label', label);
  }
}

/**
 * Sets and persists the UI theme ('dark' or 'light').
 * @param {'dark' | 'light'} theme
 * @param {boolean} [persist=true]
 */
async function applyTheme(theme, persist = true) {
  currentTheme = theme === 'light' ? 'light' : 'dark';
  document.documentElement.setAttribute('data-theme', currentTheme);
  if (persist) {
    await storage.set({ [STORAGE_KEY_THEME]: currentTheme });
  }
}

/**
 * Switches between the 4 main tabs ('scan', 'camera', 'generate', 'history').
 * @param {string} tabName
 */
function switchTab(tabName) {
  activeTabName = tabName;
  const tabBtns = document.querySelectorAll('.qr-tab-btn');
  for (const btn of tabBtns) {
    const isTarget = btn.getAttribute('data-tab') === tabName;
    btn.setAttribute('aria-selected', isTarget ? 'true' : 'false');
  }

  const panels = {
    scan: document.getElementById('panel-scan'),
    camera: document.getElementById('panel-camera'),
    generate: document.getElementById('panel-generate'),
    history: document.getElementById('panel-history'),
  };

  for (const [name, panel] of Object.entries(panels)) {
    if (panel) {
      panel.hidden = name !== tabName;
    }
  }

  if (tabName === 'camera') {
    initCameraTab();
  } else {
    stopCameraStream();
  }

  if (tabName === 'generate') {
    updateQrGeneratorPreview();
  }

  if (tabName === 'history') {
    renderHistoryList();
  }
}

/**
 * Escapes HTML special characters to prevent XSS when rendering decoded QR payloads.
 * @param {string} str
 */
function escapeHtml(str) {
  return String(str ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * Formats a 6-digit TOTP code as "123 456" for readability.
 * @param {string} code
 */
function formatTotpDisplay(code) {
  const s = String(code ?? '');
  if (s.length === 6) {
    return `${s.slice(0, 3)} ${s.slice(3)}`;
  }
  return s;
}

/**
 * Creates a DOM element for a single decoded QR result card (`ParsedQrPayload`).
 *
 * @param {ReturnType<typeof decodeMultiQrFromRgba>[number]} item
 * @returns {HTMLElement}
 */
function createResultCardElement(item) {
  const card = document.createElement('article');
  card.className = 'qr-card';
  const payload = item.payload || parseQrPayload(item.data);
  const kind = payload.kind;

  const badgeLabels = {
    url: 'URL',
    wifi: 'Wi-Fi',
    totp: '2FA TOTP',
    vcard: 'vCard',
    email: 'Email',
    sms: 'SMS',
    phone: 'Tel',
    text: 'Text',
  };

  let securityBadgeHtml = '';
  if (kind === 'url') {
    if (payload.isInsecureHttp) {
      securityBadgeHtml = `<span class="sec-badge sec-badge--warn">${escapeHtml(t('securityHttpWarn', currentLocale))}</span>`;
    } else if (payload.isRawIp) {
      securityBadgeHtml = `<span class="sec-badge sec-badge--warn">${escapeHtml(t('securityIpWarn', currentLocale))}</span>`;
    } else {
      securityBadgeHtml = `<span class="sec-badge sec-badge--ok">${escapeHtml(t('securityHttps', currentLocale))}</span>`;
    }
  }

  const thumbHtml = item.thumbnailDataUrl
    ? `<img class="qr-thumb" src="${item.thumbnailDataUrl}" alt="QR miniature">`
    : '';

  let bodyHtml = '';
  if (kind === 'url') {
    const proto = escapeHtml(payload.protocol ? `${payload.protocol}//` : '');
    const domain = escapeHtml(payload.domain || payload.text);
    const rest = escapeHtml(payload.pathAndQuery || '');
    bodyHtml = `
      <div class="url-display-box">
        <span>${proto}</span><strong class="url-domain-highlight">${domain}</strong><span>${rest}</span>
      </div>
    `;
  } else if (kind === 'wifi') {
    const maskedPass = payload.password ? '••••••••••' : '—';
    bodyHtml = `
      <div class="kv-grid">
        <span class="kv-label">${escapeHtml(t('wifiSsid', currentLocale))}</span>
        <span class="kv-value">${escapeHtml(payload.ssid || '—')}</span>
        <span class="kv-label">${escapeHtml(t('wifiSecurity', currentLocale))}</span>
        <span class="kv-value">${escapeHtml(payload.encryption || 'WPA2')}</span>
        <span class="kv-label">${escapeHtml(t('wifiPassword', currentLocale))}</span>
        <span class="kv-value">
          <code class="wifi-pass-val" data-revealed="false">${maskedPass}</code>
          ${
            payload.password
              ? `<button type="button" class="btn btn-xs btn-ghost js-toggle-pass">${escapeHtml(t('btnShowPass', currentLocale))}</button>`
              : ''
          }
        </span>
      </div>
    `;
  } else if (kind === 'totp') {
    bodyHtml = `
      <div class="totp-live-widget" data-totp-secret="${escapeHtml(payload.secret)}" data-totp-period="${payload.period || 30}" data-totp-digits="${payload.digits || 6}">
        <div class="totp-code-group">
          <span class="totp-caption">${escapeHtml(t('totpLiveCode', currentLocale))}</span>
          <span class="totp-digits js-totp-digits">--- ---</span>
        </div>
        <div class="totp-timer-pill">
          <span class="totp-seconds js-totp-seconds">--s</span>
          <div class="totp-progress-track">
            <div class="totp-progress-bar js-totp-bar" style="width: 100%"></div>
          </div>
        </div>
      </div>
      <div class="kv-grid">
        <span class="kv-label">${escapeHtml(t('totpIssuer', currentLocale))}</span>
        <span class="kv-value">${escapeHtml(payload.issuer || 'Authenticator')}</span>
        <span class="kv-label">${escapeHtml(t('totpAccount', currentLocale))}</span>
        <span class="kv-value">${escapeHtml(payload.account || payload.label || '—')}</span>
      </div>
    `;
  } else if (kind === 'vcard') {
    bodyHtml = `
      <div class="kv-grid">
        <span class="kv-label">${escapeHtml(t('vcardName', currentLocale))}</span>
        <span class="kv-value">${escapeHtml(payload.fullName || '—')}</span>
        ${
          payload.org
            ? `<span class="kv-label">${escapeHtml(t('vcardOrg', currentLocale))}</span><span class="kv-value">${escapeHtml(payload.org)}</span>`
            : ''
        }
        ${
          payload.phone
            ? `<span class="kv-label">${escapeHtml(t('vcardPhone', currentLocale))}</span><span class="kv-value">${escapeHtml(payload.phone)}</span>`
            : ''
        }
        ${
          payload.email
            ? `<span class="kv-label">${escapeHtml(t('vcardEmail', currentLocale))}</span><span class="kv-value">${escapeHtml(payload.email)}</span>`
            : ''
        }
      </div>
    `;
  } else if (kind === 'email') {
    bodyHtml = `
      <div class="kv-grid">
        <span class="kv-label">To</span>
        <span class="kv-value">${escapeHtml(payload.to)}</span>
        ${
          payload.subject
            ? `<span class="kv-label">Subject</span><span class="kv-value">${escapeHtml(payload.subject)}</span>`
            : ''
        }
      </div>
    `;
  } else if (kind === 'sms' || kind === 'phone') {
    bodyHtml = `
      <div class="kv-grid">
        <span class="kv-label">${escapeHtml(t('vcardPhone', currentLocale))}</span>
        <span class="kv-value">${escapeHtml(payload.number)}</span>
        ${
          payload.message
            ? `<span class="kv-label">SMS</span><span class="kv-value">${escapeHtml(payload.message)}</span>`
            : ''
        }
      </div>
    `;
  } else {
    bodyHtml = `
      <div class="url-display-box">${escapeHtml(truncateForDisplay(item.data, 280))}</div>
    `;
  }

  let actionsHtml = '';
  if (kind === 'url') {
    actionsHtml = `
      <button type="button" class="btn btn-xs btn-primary js-copy-raw">${escapeHtml(t('btnCopyUrl', currentLocale))}</button>
      <a href="${escapeHtml(payload.href || item.data)}" target="_blank" rel="noopener noreferrer" class="btn btn-xs btn-secondary">${escapeHtml(t('btnOpenUrl', currentLocale))} ↗</a>
    `;
  } else if (kind === 'wifi') {
    actionsHtml = `
      <button type="button" class="btn btn-xs btn-primary js-copy-wifi-pass">${escapeHtml(t('btnCopyPass', currentLocale))}</button>
      <button type="button" class="btn btn-xs btn-secondary js-copy-raw">${escapeHtml(t('btnCopyText', currentLocale))}</button>
    `;
  } else if (kind === 'totp') {
    actionsHtml = `
      <button type="button" class="btn btn-xs btn-primary js-copy-totp-code">${escapeHtml(t('btnCopyTotp', currentLocale))}</button>
      <button type="button" class="btn btn-xs btn-secondary js-copy-totp-secret">${escapeHtml(t('btnCopySecret', currentLocale))}</button>
    `;
  } else if (kind === 'vcard') {
    actionsHtml = `
      <button type="button" class="btn btn-xs btn-primary js-dl-vcf">${escapeHtml(t('btnDownloadVcf', currentLocale))}</button>
      <button type="button" class="btn btn-xs btn-secondary js-copy-raw">${escapeHtml(t('btnCopyText', currentLocale))}</button>
    `;
  } else if (kind === 'email') {
    actionsHtml = `
      <a href="${escapeHtml(payload.mailtoHref)}" target="_blank" rel="noopener noreferrer" class="btn btn-xs btn-primary">${escapeHtml(t('btnSendEmail', currentLocale))}</a>
      <button type="button" class="btn btn-xs btn-secondary js-copy-raw">${escapeHtml(t('btnCopyText', currentLocale))}</button>
    `;
  } else if (kind === 'sms') {
    actionsHtml = `
      <a href="${escapeHtml(payload.smsHref)}" class="btn btn-xs btn-primary">${escapeHtml(t('btnSendSms', currentLocale))}</a>
      <button type="button" class="btn btn-xs btn-secondary js-copy-raw">${escapeHtml(t('btnCopyText', currentLocale))}</button>
    `;
  } else if (kind === 'phone') {
    actionsHtml = `
      <a href="${escapeHtml(payload.telHref)}" class="btn btn-xs btn-primary">${escapeHtml(t('btnCallPhone', currentLocale))}</a>
      <button type="button" class="btn btn-xs btn-secondary js-copy-raw">${escapeHtml(t('btnCopyText', currentLocale))}</button>
    `;
  } else {
    actionsHtml = `
      <button type="button" class="btn btn-xs btn-primary js-copy-raw">${escapeHtml(t('btnCopyText', currentLocale))}</button>
    `;
  }

  card.innerHTML = `
    <div class="qr-card-top">
      ${thumbHtml}
      <div class="qr-card-head">
        <div class="qr-badges-row">
          <span class="type-badge type-badge--${escapeHtml(kind)}">${escapeHtml(badgeLabels[kind] || 'QR')}</span>
          ${securityBadgeHtml}
        </div>
        ${bodyHtml}
      </div>
    </div>
    <div class="qr-card-actions">
      ${actionsHtml}
    </div>
  `;

  // Wire card event listeners
  const copyRawBtn = card.querySelector('.js-copy-raw');
  if (copyRawBtn) {
    copyRawBtn.addEventListener('click', () => copyText(item.data));
  }

  const togglePassBtn = card.querySelector('.js-toggle-pass');
  const passValEl = card.querySelector('.wifi-pass-val');
  if (togglePassBtn && passValEl && kind === 'wifi') {
    togglePassBtn.addEventListener('click', () => {
      const revealed = passValEl.getAttribute('data-revealed') === 'true';
      if (revealed) {
        passValEl.textContent = '••••••••••';
        passValEl.setAttribute('data-revealed', 'false');
        togglePassBtn.textContent = t('btnShowPass', currentLocale);
      } else {
        passValEl.textContent = payload.password;
        passValEl.setAttribute('data-revealed', 'true');
        togglePassBtn.textContent = t('btnHidePass', currentLocale);
      }
    });
  }

  const copyWifiBtn = card.querySelector('.js-copy-wifi-pass');
  if (copyWifiBtn && kind === 'wifi') {
    copyWifiBtn.addEventListener('click', () => copyText(payload.password || ''));
  }

  const copyTotpCodeBtn = card.querySelector('.js-copy-totp-code');
  if (copyTotpCodeBtn && kind === 'totp') {
    copyTotpCodeBtn.addEventListener('click', async () => {
      try {
        const res = await generateTotpCode(payload.secret, Date.now(), payload.period || 30, payload.digits || 6);
        await copyText(res.code);
      } catch {
        await copyText(payload.secret);
      }
    });
  }

  const copyTotpSecretBtn = card.querySelector('.js-copy-totp-secret');
  if (copyTotpSecretBtn && kind === 'totp') {
    copyTotpSecretBtn.addEventListener('click', () => copyText(payload.secret || ''));
  }

  const dlVcfBtn = card.querySelector('.js-dl-vcf');
  if (dlVcfBtn && kind === 'vcard') {
    dlVcfBtn.addEventListener('click', () => {
      triggerDownload('qr-contact.vcf', payload.rawVcard, 'text/vcard;charset=utf-8');
    });
  }

  return card;
}

/**
 * Refreshes all live TOTP 6-digit authenticator widgets currently in the DOM.
 */
async function refreshTotpWidgets() {
  const widgets = document.querySelectorAll('.totp-live-widget');
  if (widgets.length === 0) return;

  for (const w of widgets) {
    const secret = w.getAttribute('data-totp-secret') || '';
    const period = Number.parseInt(w.getAttribute('data-totp-period') || '30', 10) || 30;
    const digits = Number.parseInt(w.getAttribute('data-totp-digits') || '6', 10) || 6;
    const digitsEl = w.querySelector('.js-totp-digits');
    const secEl = w.querySelector('.js-totp-seconds');
    const barEl = w.querySelector('.js-totp-bar');

    if (!secret) continue;
    try {
      const { code, remainingSeconds } = await generateTotpCode(secret, Date.now(), period, digits);
      if (digitsEl) digitsEl.textContent = formatTotpDisplay(code);
      if (secEl) secEl.textContent = `${remainingSeconds}s`;
      if (barEl) {
        const pct = Math.max(4, Math.round((remainingSeconds / period) * 100));
        barEl.style.width = `${pct}%`;
      }
    } catch {
      if (digitsEl) digitsEl.textContent = 'INVALID';
    }
  }
}

/**
 * Renders an array of decoded QR results into the Scanner tab and records them to history.
 *
 * @param {ReturnType<typeof decodeMultiQrFromRgba>} results
 * @param {number} [elapsedMs]
 * @param {boolean} [recordHistory=true]
 */
async function renderScanResults(results, elapsedMs = 0, recordHistory = true) {
  const listEl = document.getElementById('scan-results-list');
  const emptyEl = document.getElementById('scan-empty-state');
  const statusBar = document.getElementById('scan-status-bar');
  const countBadge = document.getElementById('scan-count-badge');
  const timingBadge = document.getElementById('scan-timing-badge');

  if (!listEl || !emptyEl || !statusBar) return;
  listEl.innerHTML = '';

  if (totpIntervalId) {
    clearInterval(totpIntervalId);
    totpIntervalId = null;
  }

  if (!results || results.length === 0) {
    statusBar.hidden = true;
    emptyEl.hidden = false;
    return;
  }

  emptyEl.hidden = true;
  statusBar.hidden = false;

  if (countBadge) {
    countBadge.textContent =
      results.length === 1
        ? t('resultsFoundSingle', currentLocale)
        : t('resultsFoundCount', currentLocale, { count: results.length });
  }
  if (timingBadge) {
    timingBadge.textContent = elapsedMs > 0 ? `${Math.round(elapsedMs)} ms` : '';
  }

  for (const item of results) {
    listEl.appendChild(createResultCardElement(item));
  }

  await refreshTotpWidgets();
  if (document.querySelectorAll('.totp-live-widget').length > 0) {
    totpIntervalId = setInterval(refreshTotpWidgets, 1000);
  }

  if (recordHistory && historyEnabled) {
    await appendToHistory(results);
  }
}

/**
 * Loads an image Data URL into an HTMLImageElement, extracts its RGBA frame,
 * runs the multi-QR decoder, and renders results.
 *
 * @param {string} dataUrl
 * @param {{ source?: string; cropRect?: { x: number; y: number; width: number; height: number }; openCropper?: boolean }} [opts]
 */
async function processImageDataUrl(dataUrl, opts = {}) {
  if (!dataUrl) return [];
  const t0 = performance.now();

  const img = new Image();
  const loaded = await new Promise((resolve) => {
    img.onload = () => resolve(true);
    img.onerror = () => resolve(false);
    img.src = dataUrl;
  });

  if (!loaded) return [];

  const width = img.naturalWidth || img.width || 1;
  const height = img.naturalHeight || img.height || 1;
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  if (!ctx) return [];
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, width, height);
  ctx.drawImage(img, 0, 0, width, height);

  const imgData = ctx.getImageData(0, 0, width, height);
  currentSourceFrame = { data: imgData.data, width, height };
  currentSourceDataUrl = dataUrl;

  if (opts.openCropper) {
    openInteractiveCropper(img);
  }

  let results = [];
  if (opts.cropRect) {
    results = decodeCroppedRegionFromRgba(
      currentSourceFrame,
      opts.cropRect,
      opts.source || 'file'
    );
  } else {
    results = await decodeFromDrawable(img, {
      source: opts.source || 'file',
      exhaustive: true,
    });
  }

  const elapsed = performance.now() - t0;
  await renderScanResults(results, elapsed, true);
  return results;
}

/**
 * Opens the interactive in-popup cropper on the given image or currentSourceDataUrl.
 * Allows dragging a rectangle with the mouse to decode any specific area with 2x supersampling.
 *
 * @param {HTMLImageElement} [imgElement]
 */
async function openInteractiveCropper(imgElement) {
  const workspace = document.getElementById('crop-workspace');
  const cropCanvas = /** @type {HTMLCanvasElement | null} */ (document.getElementById('crop-canvas'));
  const selectionEl = document.getElementById('crop-selection-rect');
  if (!workspace || !cropCanvas || !selectionEl) return;

  let img = imgElement;
  if (!img && currentSourceDataUrl) {
    img = new Image();
    await new Promise((resolve) => {
      img.onload = () => resolve(true);
      img.onerror = () => resolve(false);
      img.src = currentSourceDataUrl;
    });
  }

  if (!img) return;

  workspace.hidden = false;
  selectionEl.hidden = true;

  const maxW = 352;
  const maxH = 152;
  const natW = img.naturalWidth || img.width || 352;
  const natH = img.naturalHeight || img.height || 152;
  const ratio = Math.min(maxW / natW, maxH / natH);
  const dispW = Math.max(1, Math.round(natW * ratio));
  const dispH = Math.max(1, Math.round(natH * ratio));

  cropCanvas.width = dispW;
  cropCanvas.height = dispH;
  cropCanvas.dataset.scaleX = String(natW / dispW);
  cropCanvas.dataset.scaleY = String(natH / dispH);

  const ctx = cropCanvas.getContext('2d');
  if (ctx) {
    ctx.drawImage(img, 0, 0, dispW, dispH);
  }
}

/**
 * Wires mouse drag events on the in-popup cropper stage (#crop-stage).
 */
function setupCropStageEvents() {
  const stage = document.getElementById('crop-stage');
  const cropCanvas = /** @type {HTMLCanvasElement | null} */ (document.getElementById('crop-canvas'));
  const selectionEl = document.getElementById('crop-selection-rect');
  const closeBtn = document.getElementById('btn-close-crop');
  const pageOverlayBtn = document.getElementById('btn-page-overlay-crop');
  const workspace = document.getElementById('crop-workspace');

  if (!stage || !cropCanvas || !selectionEl || !workspace) return;

  let dragging = false;
  let startX = 0;
  let startY = 0;

  stage.addEventListener('mousedown', (e) => {
    if (!currentSourceFrame) return;
    const canvasRect = cropCanvas.getBoundingClientRect();
    const stageRect = stage.getBoundingClientRect();
    startX = Math.max(canvasRect.left, Math.min(canvasRect.right, e.clientX)) - stageRect.left;
    startY = Math.max(canvasRect.top, Math.min(canvasRect.bottom, e.clientY)) - stageRect.top;
    dragging = true;
    selectionEl.hidden = false;
    selectionEl.style.left = `${startX}px`;
    selectionEl.style.top = `${startY}px`;
    selectionEl.style.width = '0px';
    selectionEl.style.height = '0px';
  });

  window.addEventListener('mousemove', (e) => {
    if (!dragging) return;
    const canvasRect = cropCanvas.getBoundingClientRect();
    const stageRect = stage.getBoundingClientRect();
    const curX = Math.max(canvasRect.left, Math.min(canvasRect.right, e.clientX)) - stageRect.left;
    const curY = Math.max(canvasRect.top, Math.min(canvasRect.bottom, e.clientY)) - stageRect.top;
    const x = Math.min(startX, curX);
    const y = Math.min(startY, curY);
    const w = Math.abs(curX - startX);
    const h = Math.abs(curY - startY);
    selectionEl.style.left = `${x}px`;
    selectionEl.style.top = `${y}px`;
    selectionEl.style.width = `${w}px`;
    selectionEl.style.height = `${h}px`;
  });

  window.addEventListener('mouseup', async (e) => {
    if (!dragging) return;
    dragging = false;
    if (!currentSourceFrame) return;

    const canvasRect = cropCanvas.getBoundingClientRect();
    const stageRect = stage.getBoundingClientRect();
    const curX = Math.max(canvasRect.left, Math.min(canvasRect.right, e.clientX)) - stageRect.left;
    const curY = Math.max(canvasRect.top, Math.min(canvasRect.bottom, e.clientY)) - stageRect.top;

    const canvasOffsetLeft = canvasRect.left - stageRect.left;
    const canvasOffsetTop = canvasRect.top - stageRect.top;

    const localX = Math.max(0, Math.min(startX, curX) - canvasOffsetLeft);
    const localY = Math.max(0, Math.min(startY, curY) - canvasOffsetTop);
    const localW = Math.abs(curX - startX);
    const localH = Math.abs(curY - startY);

    if (localW < 8 || localH < 8) return;

    const scaleX = Number.parseFloat(cropCanvas.dataset.scaleX || '1') || 1;
    const scaleY = Number.parseFloat(cropCanvas.dataset.scaleY || '1') || 1;

    const cropRect = {
      x: Math.round(localX * scaleX),
      y: Math.round(localY * scaleY),
      width: Math.round(localW * scaleX),
      height: Math.round(localH * scaleY),
    };

    const t0 = performance.now();
    const hits = decodeCroppedRegionFromRgba(currentSourceFrame, cropRect, 'file');
    const elapsed = performance.now() - t0;
    await renderScanResults(hits, elapsed, true);
  });

  if (closeBtn) {
    closeBtn.addEventListener('click', () => {
      workspace.hidden = true;
    });
  }

  if (pageOverlayBtn) {
    pageOverlayBtn.addEventListener('click', async () => {
      if (typeof chrome !== 'undefined' && chrome.tabs?.query && chrome.runtime?.sendMessage) {
        chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
          const activeTab = tabs && tabs[0];
          if (activeTab && activeTab.id) {
            chrome.runtime.sendMessage(
              { action: 'inject-page-cropper', tabId: activeTab.id },
              (res) => {
                if (res && res.ok) {
                  window.close();
                }
              }
            );
          }
        });
      }
    });
  }

  window.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !workspace.hidden) {
      workspace.hidden = true;
    }
  });
}

/**
 * Captures the currently active Chrome tab via chrome.tabs.captureVisibleTab
 * and runs multi-QR detection (or opens the interactive cropper).
 *
 * @param {{ openCropper?: boolean }} [opts]
 */
async function scanActiveTab(opts = {}) {
  if (typeof chrome !== 'undefined' && chrome.tabs?.captureVisibleTab) {
    try {
      const dataUrl = await new Promise((resolve) => {
        chrome.tabs.captureVisibleTab(null, { format: 'png' }, (url) => {
          if (chrome.runtime?.lastError || !url) resolve(null);
          else resolve(url);
        });
      });
      if (dataUrl) {
        await processImageDataUrl(dataUrl, {
          source: 'file',
          openCropper: opts.openCropper,
        });
        return;
      }
    } catch {
      // Fallback if captureVisibleTab is unavailable in standalone context
    }
  }

  // If a source image is already loaded in memory (e.g. from drag & drop or test), open cropper on it
  if (opts.openCropper && currentSourceDataUrl) {
    await openInteractiveCropper();
  }
}

async function initCameraTab() {
  const permCard = document.getElementById('camera-perm-card');
  const liveBox = document.getElementById('camera-live-box');
  if (!permCard || !liveBox) return;

  let state = 'prompt';
  if (navigator.permissions && typeof navigator.permissions.query === 'function') {
    try {
      const status = await navigator.permissions.query({
        name: /** @type {PermissionName} */ ('camera'),
      });
      state = status.state;
      status.onchange = () => {
        if (activeTabName === 'camera') initCameraTab();
      };
    } catch {
      state = 'prompt';
    }
  }

  if (state === 'granted') {
    permCard.hidden = true;
    liveBox.hidden = false;
    await startCameraStream();
  } else {
    permCard.hidden = false;
    liveBox.hidden = true;
  }
}

async function startCameraStream(deviceId) {
  stopCameraStream();
  const video = /** @type {HTMLVideoElement | null} */ (document.getElementById('camera-video'));
  const select = /** @type {HTMLSelectElement | null} */ (document.getElementById('camera-device-select'));
  const toggleBtn = document.getElementById('btn-camera-toggle');
  if (!video) return;

  try {
    const constraints = {
      audio: false,
      video: deviceId
        ? { deviceId: { exact: deviceId }, width: { ideal: 1280 }, height: { ideal: 720 } }
        : { facingMode: 'environment', width: { ideal: 1280 }, height: { ideal: 720 } },
    };
    cameraStream = await navigator.mediaDevices.getUserMedia(constraints);
    video.srcObject = cameraStream;
    await video.play();
    if (toggleBtn) toggleBtn.textContent = t('camStopBtn', currentLocale);

    // Populate camera selector
    if (select && navigator.mediaDevices.enumerateDevices) {
      const devices = await navigator.mediaDevices.enumerateDevices();
      const cams = devices.filter((d) => d.kind === 'videoinput');
      select.innerHTML = '';
      cams.forEach((cam, idx) => {
        const opt = document.createElement('option');
        opt.value = cam.deviceId;
        opt.textContent = cam.label || `Camera ${idx + 1}`;
        if (deviceId && cam.deviceId === deviceId) opt.selected = true;
        select.appendChild(opt);
      });
    }

    // 15 FPS scan loop (~66ms)
    const workCanvas = document.createElement('canvas');
    cameraTimerId = setInterval(async () => {
      if (!video.videoWidth || !video.videoHeight) return;
      workCanvas.width = video.videoWidth;
      workCanvas.height = video.videoHeight;
      const ctx = workCanvas.getContext('2d', { willReadFrequently: true });
      if (!ctx) return;
      ctx.drawImage(video, 0, 0);
      const hits = await decodeFromDrawable(workCanvas, {
        source: 'camera',
        exhaustive: false,
      });
      if (hits.length > 0) {
        const liveResults = document.getElementById('camera-live-results');
        if (liveResults) {
          liveResults.innerHTML = '';
          for (const h of hits) {
            liveResults.appendChild(createResultCardElement(h));
          }
          await refreshTotpWidgets();
        }
        if (historyEnabled) {
          await appendToHistory(hits);
        }
      }
    }, 70);
  } catch {
    const permCard = document.getElementById('camera-perm-card');
    const liveBox = document.getElementById('camera-live-box');
    if (permCard) permCard.hidden = false;
    if (liveBox) liveBox.hidden = true;
  }
}

function stopCameraStream() {
  if (cameraTimerId) {
    clearInterval(cameraTimerId);
    cameraTimerId = null;
  }
  if (cameraStream) {
    for (const track of cameraStream.getTracks()) {
      track.stop();
    }
    cameraStream = null;
  }
  const toggleBtn = document.getElementById('btn-camera-toggle');
  if (toggleBtn) toggleBtn.textContent = t('camStartBtn', currentLocale);
}

function getGeneratorOptions() {
  const input = /** @type {HTMLTextAreaElement | null} */ (document.getElementById('gen-text-input'));
  const eccSelect = /** @type {HTMLSelectElement | null} */ (document.getElementById('gen-ecc-select'));
  const marginSelect = /** @type {HTMLSelectElement | null} */ (document.getElementById('gen-margin-select'));

  const text = (input?.value || '').trim() || 'https://sunasty.com/qr-scan/';
  const ecc = /** @type {'L' | 'M' | 'Q' | 'H'} */ (eccSelect?.value || 'M');
  const margin = Number.parseInt(marginSelect?.value || '2', 10);

  return { text, ecc, margin };
}

function updateQrGeneratorPreview() {
  const canvas = /** @type {HTMLCanvasElement | null} */ (document.getElementById('gen-preview-canvas'));
  if (!canvas) return;
  const { text, ecc, margin } = getGeneratorOptions();
  renderQrToCanvas(canvas, text, { ecc, margin, size: 240 });
}

function setupGeneratorTab() {
  const input = /** @type {HTMLTextAreaElement | null} */ (document.getElementById('gen-text-input'));
  const eccSelect = document.getElementById('gen-ecc-select');
  const marginSelect = document.getElementById('gen-margin-select');
  const dlPngBtn = document.getElementById('btn-dl-png');
  const dlSvgBtn = document.getElementById('btn-dl-svg');
  const copyImgBtn = document.getElementById('btn-copy-qr-img');

  // Pre-fill with active tab URL if running inside Chrome extension
  if (typeof chrome !== 'undefined' && chrome.tabs?.query && input) {
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      const tabUrl = tabs?.[0]?.url;
      if (tabUrl && /^https?:\/\//i.test(tabUrl)) {
        input.value = tabUrl;
        updateQrGeneratorPreview();
      }
    });
  }

  input?.addEventListener('input', updateQrGeneratorPreview);
  eccSelect?.addEventListener('change', updateQrGeneratorPreview);
  marginSelect?.addEventListener('change', updateQrGeneratorPreview);

  const presets = document.querySelectorAll('.preset-chip');
  for (const chip of presets) {
    chip.addEventListener('click', () => {
      if (!input) return;
      const type = chip.getAttribute('data-preset');
      if (type === 'url') {
        input.value = 'https://sunasty.com/qr-scan/';
      } else if (type === 'wifi') {
        input.value = 'WIFI:S:MyNetwork;T:WPA;P:MyPassword123;;';
      } else if (type === 'vcard') {
        input.value = 'BEGIN:VCARD\nVERSION:3.0\nFN:Bastien Ulysan\nORG:Sunasty\nTEL:+33600000000\nEMAIL:contact@sunasty.com\nEND:VCARD';
      }
      updateQrGeneratorPreview();
    });
  }

  dlPngBtn?.addEventListener('click', () => {
    const { text, ecc, margin } = getGeneratorOptions();
    const hiResCanvas = document.createElement('canvas');
    const dataUrl = renderQrToCanvas(hiResCanvas, text, { ecc, margin, size: 1024 });
    triggerDownload('sunasty-qr-1024.png', dataUrl);
  });

  dlSvgBtn?.addEventListener('click', () => {
    const { text, ecc, margin } = getGeneratorOptions();
    const svg = generateQrSvg(text, { ecc, margin, size: 1024 });
    triggerDownload('sunasty-qr.svg', svg, 'image/svg+xml;charset=utf-8');
  });

  copyImgBtn?.addEventListener('click', async () => {
    const { text, ecc, margin } = getGeneratorOptions();
    const hiResCanvas = document.createElement('canvas');
    const dataUrl = renderQrToCanvas(hiResCanvas, text, { ecc, margin, size: 1024 });
    try {
      const blob = await new Promise((resolve) => hiResCanvas.toBlob(resolve, 'image/png'));
      if (blob && navigator.clipboard?.write && typeof ClipboardItem !== 'undefined') {
        await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })]);
        showToast(t('copiedToast', currentLocale));
        return;
      }
    } catch {
      // Fallback to copying dataUrl text
    }
    await copyText(dataUrl);
  });

  updateQrGeneratorPreview();
}

async function loadHistoryState() {
  const stored = await storage.get([STORAGE_KEY_HISTORY, STORAGE_KEY_HISTORY_ENABLED]);
  if (Array.isArray(stored[STORAGE_KEY_HISTORY])) {
    historyItems = stored[STORAGE_KEY_HISTORY];
  }
  if (typeof stored[STORAGE_KEY_HISTORY_ENABLED] === 'boolean') {
    historyEnabled = stored[STORAGE_KEY_HISTORY_ENABLED];
  }
  const checkbox = /** @type {HTMLInputElement | null} */ (document.getElementById('history-enable-checkbox'));
  if (checkbox) checkbox.checked = historyEnabled;
  updateHistoryPill();
}

function updateHistoryPill() {
  const pill = document.getElementById('history-count-pill');
  if (!pill) return;
  if (historyItems.length > 0) {
    pill.textContent = String(historyItems.length);
    pill.hidden = false;
  } else {
    pill.hidden = true;
  }
}

async function appendToHistory(newResults) {
  if (!historyEnabled || !Array.isArray(newResults) || newResults.length === 0) return;

  for (const item of newResults) {
    const cleanData = String(item.data ?? '').trim();
    if (!cleanData) continue;
    // Deduplicate consecutive identical entries
    historyItems = historyItems.filter((h) => h.data !== cleanData);
    historyItems.unshift({
      id: `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
      data: item.data,
      source: item.source || 'file',
      isUrl: Boolean(item.isUrl ?? looksLikeUrl(item.data)),
      type: item.type || parseQrPayload(item.data).kind,
      timestamp: item.timestamp || new Date().toISOString(),
    });
  }

  if (historyItems.length > MAX_HISTORY_ITEMS) {
    historyItems = historyItems.slice(0, MAX_HISTORY_ITEMS);
  }

  await storage.set({ [STORAGE_KEY_HISTORY]: historyItems });
  updateHistoryPill();
}

function renderHistoryList() {
  const listEl = document.getElementById('history-list');
  const emptyEl = document.getElementById('history-empty-state');
  const searchInput = /** @type {HTMLInputElement | null} */ (document.getElementById('history-search-input'));
  if (!listEl || !emptyEl) return;

  const query = (searchInput?.value || '').trim().toLowerCase();
  const filtered = query
    ? historyItems.filter(
        (h) =>
          h.data.toLowerCase().includes(query) ||
          (h.type && h.type.toLowerCase().includes(query))
      )
    : historyItems;

  listEl.innerHTML = '';
  if (filtered.length === 0) {
    emptyEl.hidden = false;
    return;
  }
  emptyEl.hidden = true;

  for (const item of filtered) {
    const row = document.createElement('div');
    row.className = 'qr-card';
    const dateStr = item.timestamp ? new Date(item.timestamp).toLocaleString() : '';
    row.innerHTML = `
      <div class="qr-badges-row" style="justify-content: space-between;">
        <span class="type-badge type-badge--${escapeHtml(item.type || 'text')}">${escapeHtml(item.type || 'text')}</span>
        <span style="font-size: 10.5px; color: var(--text-secondary);">${escapeHtml(dateStr)}</span>
      </div>
      <div class="url-display-box">${escapeHtml(truncateForDisplay(item.data, 160))}</div>
      <div class="qr-card-actions" style="justify-content: space-between;">
        <button type="button" class="btn btn-xs btn-primary js-hist-copy">${escapeHtml(t('btnCopyText', currentLocale))}</button>
        <button type="button" class="btn btn-xs btn-danger-ghost js-hist-del">✕</button>
      </div>
    `;
    row.querySelector('.js-hist-copy')?.addEventListener('click', () => copyText(item.data));
    row.querySelector('.js-hist-del')?.addEventListener('click', async () => {
      historyItems = historyItems.filter((h) => h.id !== item.id);
      await storage.set({ [STORAGE_KEY_HISTORY]: historyItems });
      updateHistoryPill();
      renderHistoryList();
    });
    listEl.appendChild(row);
  }
}

function setupHistoryTab() {
  const searchInput = document.getElementById('history-search-input');
  const enableCheckbox = /** @type {HTMLInputElement | null} */ (document.getElementById('history-enable-checkbox'));
  const exportCsvBtn = document.getElementById('btn-export-csv');
  const exportJsonBtn = document.getElementById('btn-export-json');
  const clearBtn = document.getElementById('btn-clear-history');

  searchInput?.addEventListener('input', renderHistoryList);
  enableCheckbox?.addEventListener('change', async () => {
    historyEnabled = Boolean(enableCheckbox.checked);
    await storage.set({ [STORAGE_KEY_HISTORY_ENABLED]: historyEnabled });
  });

  exportCsvBtn?.addEventListener('click', () => {
    const csv = serializeScanHistoryToCsv(historyItems);
    triggerDownload('qr-scan-history.csv', csv, 'text/csv;charset=utf-8');
  });

  exportJsonBtn?.addEventListener('click', () => {
    const json = serializeScanHistoryToJson(historyItems);
    triggerDownload('qr-scan-history.json', json, 'application/json;charset=utf-8');
  });

  clearBtn?.addEventListener('click', async () => {
    historyItems = [];
    await storage.set({ [STORAGE_KEY_HISTORY]: [] });
    updateHistoryPill();
    renderHistoryList();
  });
}

async function initPopup() {
  // 1. Theme resolution (?theme=light|dark > saved > prefers-color-scheme)
  const params = new URLSearchParams(location.search);
  const urlTheme = params.get('theme');
  const saved = await storage.get([STORAGE_KEY_THEME]);

  if (urlTheme === 'light' || urlTheme === 'dark') {
    await applyTheme(urlTheme, false);
  } else if (saved[STORAGE_KEY_THEME]) {
    await applyTheme(saved[STORAGE_KEY_THEME], false);
  } else {
    await applyTheme('light', false);
  }

  // 2. Localization
  applyTranslations(params.get('lang') || undefined);

  // 3. Theme toggle button
  document.getElementById('btn-theme-toggle')?.addEventListener('click', () => {
    applyTheme(currentTheme === 'dark' ? 'light' : 'dark', true);
  });

  // 4. Tab switching
  const tabBtns = document.querySelectorAll('.qr-tab-btn');
  for (const btn of tabBtns) {
    btn.addEventListener('click', () => {
      const target = btn.getAttribute('data-tab');
      if (target) switchTab(target);
    });
  }

  // 5. Scanner buttons & dropzone
  document.getElementById('btn-select-area')?.addEventListener('click', async () => {
    if (currentSourceDataUrl) {
      await openInteractiveCropper();
    } else {
      await scanActiveTab({ openCropper: true });
    }
  });

  document.getElementById('btn-rescan-tab')?.addEventListener('click', () => {
    scanActiveTab({ openCropper: false });
  });

  const fileInput = /** @type {HTMLInputElement | null} */ (document.getElementById('scan-file-input'));
  const dropzone = document.getElementById('scan-dropzone');

  async function handleFile(file) {
    if (!file) return;
    const reader = new FileReader();
    const dataUrl = await new Promise((resolve) => {
      reader.onload = () => resolve(typeof reader.result === 'string' ? reader.result : '');
      reader.onerror = () => resolve('');
      reader.readAsDataURL(file);
    });
    if (dataUrl) {
      await processImageDataUrl(dataUrl, { source: 'file' });
    }
  }

  fileInput?.addEventListener('change', () => {
    const file = fileInput.files?.[0];
    if (file) handleFile(file);
  });

  dropzone?.addEventListener('dragover', (e) => {
    e.preventDefault();
    dropzone.classList.add('drag-over');
  });

  dropzone?.addEventListener('dragleave', () => {
    dropzone.classList.remove('drag-over');
  });

  dropzone?.addEventListener('drop', (e) => {
    e.preventDefault();
    dropzone.classList.remove('drag-over');
    const file = e.dataTransfer?.files?.[0];
    if (file) handleFile(file);
  });

  window.addEventListener('paste', (e) => {
    const items = e.clipboardData?.items;
    if (!items) return;
    for (const item of items) {
      if (item.type.startsWith('image/')) {
        const file = item.getAsFile();
        if (file) {
          handleFile(file);
          break;
        }
      }
    }
  });

  // 6. Camera tab buttons
  document.getElementById('btn-authorize-camera')?.addEventListener('click', () => {
    const url =
      typeof chrome !== 'undefined' && chrome.runtime?.getURL
        ? chrome.runtime.getURL('camera.html?setup=1')
        : 'camera.html?setup=1';
    window.open(url, '_blank');
  });

  document.getElementById('btn-open-camera-tab')?.addEventListener('click', () => {
    const url =
      typeof chrome !== 'undefined' && chrome.runtime?.getURL
        ? chrome.runtime.getURL('camera.html')
        : 'camera.html';
    window.open(url, '_blank');
  });

  document.getElementById('btn-camera-mirror')?.addEventListener('click', () => {
    cameraMirrored = !cameraMirrored;
    document.getElementById('camera-video')?.classList.toggle('mirrored', cameraMirrored);
  });

  document.getElementById('btn-camera-toggle')?.addEventListener('click', () => {
    if (cameraStream) stopCameraStream();
    else startCameraStream();
  });

  const camSelect = /** @type {HTMLSelectElement | null} */ (document.getElementById('camera-device-select'));
  camSelect?.addEventListener('change', () => {
    startCameraStream(camSelect.value);
  });

  // 7. Setup Crop Stage, Generator, and History
  setupCropStageEvents();
  setupGeneratorTab();
  await loadHistoryState();
  setupHistoryTab();

  // 8. Check pending context-menu scan or pending page-overlay crop
  const pending = await storage.get(['sunasty_pending_scan', 'sunasty_pending_crop']);
  if (pending.sunasty_pending_crop && pending.sunasty_pending_crop.dataUrl) {
    await storage.remove('sunasty_pending_crop');
    await processImageDataUrl(pending.sunasty_pending_crop.dataUrl, {
      source: 'file',
      cropRect: pending.sunasty_pending_crop.cropRect,
    });
  } else if (pending.sunasty_pending_scan && pending.sunasty_pending_scan.dataUrl) {
    await storage.remove('sunasty_pending_scan');
    await processImageDataUrl(pending.sunasty_pending_scan.dataUrl, {
      source: 'file',
    });
  } else {
    // Automatic scan of the visible tab on popup open
    await scanActiveTab();
  }
}

globalThis.__SUNASTY_QR__ = {
  processImageDataUrl,
  openInteractiveCropper,
  renderScanResults,
  switchTab,
  applyTranslations,
  applyTheme,
  generateQrSvg,
  generateQrRgba,
  renderQrToCanvas,
  generateTotpCode,
  parseQrPayload,
  decodeMultiQrFromRgba,
  decodeCroppedRegionFromRgba,
};

document.addEventListener('DOMContentLoaded', () => {
  initPopup();
});
