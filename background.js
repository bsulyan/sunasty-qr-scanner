const CONTEXT_MENU_ID = 'sunasty-scan-qr-image';

function setupContextMenu() {
  if (!chrome.contextMenus) return;
  chrome.contextMenus.removeAll(() => {
    void chrome.runtime.lastError;
    const title =
      (chrome.i18n && chrome.i18n.getMessage('ctxScanImage')) ||
      'Scan this QR code with Sunasty';
    chrome.contextMenus.create(
      {
        id: CONTEXT_MENU_ID,
        title,
        contexts: ['image', 'page'],
      },
      () => {
        void chrome.runtime.lastError;
      }
    );
  });
}

chrome.runtime.onInstalled.addListener(() => {
  setupContextMenu();
});

chrome.runtime.onStartup.addListener(() => {
  setupContextMenu();
});

async function blobToDataUrl(blob) {
  const buffer = await blob.arrayBuffer();
  const bytes = new Uint8Array(buffer);
  let binary = '';
  const chunkSize = 0x8000;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize));
  }
  const base64 = btoa(binary);
  const mime = blob.type || 'image/png';
  return `data:${mime};base64,${base64}`;
}

function captureTabDataUrl(windowId) {
  return new Promise((resolve) => {
    try {
      const targetWindow = typeof windowId === 'number' ? windowId : chrome.windows.WINDOW_ID_CURRENT;
      chrome.tabs.captureVisibleTab(targetWindow, { format: 'png' }, (dataUrl) => {
        if (chrome.runtime.lastError || !dataUrl) {
          resolve(null);
        } else {
          resolve(dataUrl);
        }
      });
    } catch {
      resolve(null);
    }
  });
}

async function openResultPopup(query = '') {
  if (chrome.action && typeof chrome.action.openPopup === 'function') {
    try {
      await chrome.action.openPopup();
      return;
    } catch {
      // Fallback to popup window if openPopup is restricted
    }
  }
  const url = chrome.runtime.getURL(`popup.html${query}`);
  chrome.windows.create({
    url,
    type: 'popup',
    width: 416,
    height: 600,
  });
}

if (chrome.contextMenus && chrome.contextMenus.onClicked) {
  chrome.contextMenus.onClicked.addListener(async (info, tab) => {
    if (info.menuItemId !== CONTEXT_MENU_ID) return;

    let dataUrl = null;
    if (info.srcUrl) {
      if (info.srcUrl.startsWith('data:image/')) {
        dataUrl = info.srcUrl;
      } else {
        try {
          const response = await fetch(info.srcUrl, { credentials: 'omit', cache: 'force-cache' });
          if (response.ok) {
            const blob = await response.blob();
            dataUrl = await blobToDataUrl(blob);
          }
        } catch {
          // Fallback to visible tab capture below
        }
      }
    }

    if (!dataUrl) {
      dataUrl = await captureTabDataUrl(tab?.windowId);
    }

    if (dataUrl) {
      await chrome.storage.local.set({
        sunasty_pending_scan: {
          dataUrl,
          sourceUrl: info.srcUrl || tab?.url || '',
          timestamp: Date.now(),
        },
      });
      await openResultPopup('?contextScan=1');
    }
  });
}

function injectedPageRegionOverlay() {
  const existing = document.getElementById('__sunasty_qr_crop_overlay__');
  if (existing) existing.remove();

  const overlay = document.createElement('div');
  overlay.id = '__sunasty_qr_crop_overlay__';
  Object.assign(overlay.style, {
    position: 'fixed',
    inset: '0',
    zIndex: '2147483647',
    background: 'rgba(15, 23, 42, 0.42)',
    cursor: 'crosshair',
    userSelect: 'none',
    fontFamily: 'system-ui, -apple-system, sans-serif',
  });

  const banner = document.createElement('div');
  banner.textContent = 'Sunasty QR — Drag a rectangle around the QR code (Esc to cancel)';
  Object.assign(banner.style, {
    position: 'fixed',
    top: '16px',
    left: '50%',
    transform: 'translateX(-50%)',
    background: '#0f172a',
    color: '#f8fafc',
    border: '1px solid #2563eb',
    borderRadius: '999px',
    padding: '8px 18px',
    fontSize: '13px',
    fontWeight: '600',
    boxShadow: '0 8px 24px rgba(0,0,0,0.45)',
    pointerEvents: 'none',
  });

  const box = document.createElement('div');
  Object.assign(box.style, {
    position: 'fixed',
    border: '2px solid #2563eb',
    background: 'rgba(37, 99, 235, 0.16)',
    boxShadow: '0 0 0 9999px rgba(15, 23, 42, 0.48)',
    display: 'none',
    pointerEvents: 'none',
  });

  overlay.appendChild(box);
  overlay.appendChild(banner);
  document.documentElement.appendChild(overlay);

  let startX = 0;
  let startY = 0;
  let dragging = false;

  function cleanup() {
    window.removeEventListener('keydown', onKeyDown, true);
    overlay.remove();
  }

  function onKeyDown(e) {
    if (e.key === 'Escape') {
      e.preventDefault();
      cleanup();
    }
  }

  window.addEventListener('keydown', onKeyDown, true);

  overlay.addEventListener('mousedown', (e) => {
    if (e.button !== 0) return;
    dragging = true;
    startX = e.clientX;
    startY = e.clientY;
    box.style.display = 'block';
    box.style.left = `${startX}px`;
    box.style.top = `${startY}px`;
    box.style.width = '0px';
    box.style.height = '0px';
  });

  overlay.addEventListener('mousemove', (e) => {
    if (!dragging) return;
    const x = Math.min(startX, e.clientX);
    const y = Math.min(startY, e.clientY);
    const w = Math.abs(e.clientX - startX);
    const h = Math.abs(e.clientY - startY);
    box.style.left = `${x}px`;
    box.style.top = `${y}px`;
    box.style.width = `${w}px`;
    box.style.height = `${h}px`;
  });

  overlay.addEventListener('mouseup', (e) => {
    if (!dragging) return;
    dragging = false;
    const x = Math.min(startX, e.clientX);
    const y = Math.min(startY, e.clientY);
    const w = Math.abs(e.clientX - startX);
    const h = Math.abs(e.clientY - startY);
    cleanup();
    if (w < 12 || h < 12) return;

    const dpr = window.devicePixelRatio || 1;
    requestAnimationFrame(() => {
      setTimeout(() => {
        chrome.runtime.sendMessage({
          action: 'page-crop-coordinates',
          cropRect: {
            x: Math.round(x * dpr),
            y: Math.round(y * dpr),
            width: Math.round(w * dpr),
            height: Math.round(h * dpr),
          },
        });
      }, 40);
    });
  });
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message || typeof message !== 'object') return false;

  if (message.action === 'capture-visible-tab') {
    captureTabDataUrl(message.windowId).then((dataUrl) => {
      sendResponse({ ok: Boolean(dataUrl), dataUrl });
    });
    return true;
  }

  if (message.action === 'inject-page-cropper') {
    const tabId = message.tabId;
    if (!tabId || !chrome.scripting) {
      sendResponse({ ok: false, reason: 'scripting-unavailable' });
      return false;
    }
    chrome.scripting
      .executeScript({
        target: { tabId },
        func: injectedPageRegionOverlay,
      })
      .then(() => sendResponse({ ok: true }))
      .catch((err) => sendResponse({ ok: false, reason: String(err?.message || err) }));
    return true;
  }

  if (message.action === 'page-crop-coordinates') {
    const winId = sender?.tab?.windowId;
    captureTabDataUrl(winId).then(async (dataUrl) => {
      if (dataUrl && message.cropRect) {
        await chrome.storage.local.set({
          sunasty_pending_crop: {
            dataUrl,
            cropRect: message.cropRect,
            timestamp: Date.now(),
          },
        });
        await openResultPopup('?pageCrop=1');
      }
      sendResponse({ ok: Boolean(dataUrl) });
    });
    return true;
  }

  return false;
});
