import { decodeFromDrawable } from './core/qr-decoder.js';
import { resolveLocale, t } from './core/i18n.js';
import { generateTotpCode, parseQrPayload, truncateForDisplay } from './core/qr-payload.js';

let currentLocale = resolveLocale();
let stream = null;
let scanInterval = null;
let mirrored = false;

function escapeHtml(str) {
  return String(str ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function applyTranslations() {
  currentLocale = resolveLocale();
  document.documentElement.lang = currentLocale.replace('_', '-');
  const elements = document.querySelectorAll('[data-i18n]');
  for (const el of elements) {
    const key = el.getAttribute('data-i18n');
    if (key) el.textContent = t(key, currentLocale);
  }
}

async function renderCameraHits(hits) {
  const container = document.getElementById('cam-full-results');
  if (!container) return;
  container.innerHTML = '';

  for (const item of hits) {
    const payload = item.payload || parseQrPayload(item.data);
    const card = document.createElement('article');
    card.className = 'qr-card';
    let extra = '';
    if (payload.kind === 'totp' && payload.secret) {
      try {
        const totp = await generateTotpCode(payload.secret, Date.now(), payload.period || 30, payload.digits || 6);
        extra = `<div class="totp-live-widget"><span class="totp-digits">${escapeHtml(totp.code)}</span><span class="totp-seconds">${totp.remainingSeconds}s</span></div>`;
      } catch {
        // ignore
      }
    }
    card.innerHTML = `
      <div class="qr-badges-row">
        <span class="type-badge type-badge--${escapeHtml(payload.kind)}">${escapeHtml(payload.kind.toUpperCase())}</span>
      </div>
      ${extra}
      <div class="url-display-box">${escapeHtml(truncateForDisplay(item.data, 280))}</div>
      <div class="qr-card-actions">
        <button type="button" class="btn btn-xs btn-primary js-copy">${escapeHtml(t('btnCopyText', currentLocale))}</button>
      </div>
    `;
    card.querySelector('.js-copy')?.addEventListener('click', () => {
      navigator.clipboard?.writeText(item.data);
    });
    container.appendChild(card);
  }
}

async function startCamera(deviceId) {
  stopCamera();
  const video = /** @type {HTMLVideoElement | null} */ (document.getElementById('cam-full-video'));
  const badge = document.getElementById('cam-perm-badge');
  const select = /** @type {HTMLSelectElement | null} */ (document.getElementById('cam-full-select'));
  if (!video) return;

  try {
    stream = await navigator.mediaDevices.getUserMedia({
      audio: false,
      video: deviceId
        ? { deviceId: { exact: deviceId }, width: { ideal: 1280 }, height: { ideal: 720 } }
        : { facingMode: 'environment', width: { ideal: 1280 }, height: { ideal: 720 } },
    });
    video.srcObject = stream;
    await video.play();

    if (badge) {
      badge.textContent = 'Camera Active ✓';
      badge.classList.add('granted');
    }

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

    const workCanvas = document.createElement('canvas');
    scanInterval = setInterval(async () => {
      if (!video.videoWidth || !video.videoHeight) return;
      workCanvas.width = video.videoWidth;
      workCanvas.height = video.videoHeight;
      const ctx = workCanvas.getContext('2d', { willReadFrequently: true });
      if (!ctx) return;
      ctx.drawImage(video, 0, 0);
      const hits = await decodeFromDrawable(workCanvas, { source: 'camera', exhaustive: false });
      if (hits.length > 0) {
        await renderCameraHits(hits);
      }
    }, 80);
  } catch (err) {
    if (badge) {
      badge.textContent = `Permission needed (${err?.name || 'prompt'})`;
      badge.classList.remove('granted');
    }
  }
}

function stopCamera() {
  if (scanInterval) {
    clearInterval(scanInterval);
    scanInterval = null;
  }
  if (stream) {
    for (const tr of stream.getTracks()) tr.stop();
    stream = null;
  }
}

document.addEventListener('DOMContentLoaded', () => {
  applyTranslations();

  document.getElementById('btn-cam-full-start')?.addEventListener('click', () => startCamera());
  document.getElementById('btn-cam-full-stop')?.addEventListener('click', () => stopCamera());
  document.getElementById('btn-cam-full-mirror')?.addEventListener('click', () => {
    mirrored = !mirrored;
    document.getElementById('cam-full-video')?.classList.toggle('mirrored', mirrored);
  });

  const select = /** @type {HTMLSelectElement | null} */ (document.getElementById('cam-full-select'));
  select?.addEventListener('change', () => startCamera(select.value));

  const params = new URLSearchParams(location.search);
  if (params.get('setup') === '1') {
    startCamera();
  }
});
