export const SCAN_ACCEPTED_MIME = [
  'image/jpeg',
  'image/png',
  'image/webp',
  'image/gif',
  'image/bmp',
  'image/svg+xml',
];

export const SCAN_MAX_BYTES = 20 * 1024 * 1024;

/**
 * Returns true if the given MIME string is accepted for image scanning.
 * @param {string} mime
 * @returns {boolean}
 */
export function isAcceptedScanMime(mime) {
  return SCAN_ACCEPTED_MIME.includes(mime);
}

/**
 * Returns true if the string starts with http:// or https://.
 * @param {string} data
 * @returns {boolean}
 */
export function looksLikeUrl(data) {
  return /^https?:\/\//i.test(String(data ?? '').trim());
}

/**
 * Analyzes an HTTP/HTTPS URL for security preview before user click.
 * Extracts domain, protocol, whether it uses unencrypted HTTP, or a raw IPv4/IPv6 host.
 *
 * @param {string} rawUrl
 */
export function analyzeUrlSecurity(rawUrl) {
  const trimmed = String(rawUrl ?? '').trim();
  try {
    const parsed = new URL(trimmed);
    const protocol = parsed.protocol.toLowerCase();
    const hostname = parsed.hostname;
    const isInsecureHttp = protocol === 'http:';
    const isRawIp =
      /^\d{1,3}(?:\.\d{1,3}){3}$/.test(hostname) ||
      hostname.startsWith('[') ||
      /^[0-9a-f:]+$/i.test(hostname);
    const pathAndQuery = (parsed.pathname === '/' && !parsed.search && !parsed.hash)
      ? ''
      : `${parsed.pathname}${parsed.search}${parsed.hash}`;
    return {
      valid: true,
      href: parsed.href,
      protocol,
      domain: hostname,
      pathAndQuery,
      isInsecureHttp,
      isRawIp,
      hasSecurityWarning: isInsecureHttp || isRawIp,
    };
  } catch {
    return {
      valid: false,
      href: trimmed,
      protocol: '',
      domain: trimmed,
      pathAndQuery: '',
      isInsecureHttp: /^http:\/\//i.test(trimmed),
      isRawIp: false,
      hasSecurityWarning: true,
    };
  }
}

function unescapeWifiField(val) {
  return val.replace(/\\([\\;,:"])/g, '$1');
}

function matchWifiField(body, key) {
  const regex = new RegExp(`(?:^|;)${key}:((?:\\\\.|[^;])*)`, 'i');
  const match = regex.exec(body);
  return match && match[1] ? unescapeWifiField(match[1]) : '';
}

function matchVcardLine(raw, prop) {
  const regex = new RegExp(`^${prop}(?:;[^:]*)?:(.*)$`, 'im');
  const match = regex.exec(raw);
  return match && match[1] ? match[1].trim() : '';
}

/**
 * Parses raw QR code text into a structured payload:
 * wifi | vcard | email | sms | phone | totp | url | text
 *
 * @param {string} data
 */
export function parseQrPayload(data) {
  const raw = String(data ?? '');
  const trimmed = raw.trim();

  // 1. Wi-Fi: WIFI:S:MySSID;T:WPA;P:secret;H:true;;
  if (/^WIFI:/i.test(trimmed)) {
    const body = trimmed.slice(5);
    const ssid = matchWifiField(body, 'S');
    const encryption = matchWifiField(body, 'T') || 'nopass';
    const password = matchWifiField(body, 'P');
    const hiddenRaw = matchWifiField(body, 'H');
    const hidden = /^true$/i.test(hiddenRaw);
    return {
      kind: 'wifi',
      ssid,
      encryption,
      password,
      hidden,
    };
  }

  // 2. vCard: BEGIN:VCARD ... END:VCARD
  if (/^BEGIN:VCARD/i.test(trimmed)) {
    const fullName = matchVcardLine(trimmed, 'FN') || matchVcardLine(trimmed, 'N');
    const phone = matchVcardLine(trimmed, 'TEL');
    const email = matchVcardLine(trimmed, 'EMAIL');
    const org = matchVcardLine(trimmed, 'ORG');
    return {
      kind: 'vcard',
      fullName,
      phone,
      email,
      org,
      rawVcard: trimmed,
    };
  }

  // 3a. MATMSG:TO:user@example.com;SUB:Hi;BODY:Hello;;
  if (/^MATMSG:/i.test(trimmed)) {
    const body = trimmed.slice(7);
    const to = matchWifiField(body, 'TO');
    const subject = matchWifiField(body, 'SUB');
    const msgBody = matchWifiField(body, 'BODY');
    const params = [];
    if (subject) params.push(`subject=${encodeURIComponent(subject)}`);
    if (msgBody) params.push(`body=${encodeURIComponent(msgBody)}`);
    const query = params.length > 0 ? `?${params.join('&')}` : '';
    return {
      kind: 'email',
      to,
      subject,
      body: msgBody,
      mailtoHref: `mailto:${to}${query}`,
    };
  }

  // 3b. mailto:user@example.com?subject=Hi&body=Hello
  if (/^mailto:/i.test(trimmed)) {
    const withoutScheme = trimmed.slice(7);
    const qIndex = withoutScheme.indexOf('?');
    const to =
      qIndex >= 0
        ? decodeURIComponent(withoutScheme.slice(0, qIndex))
        : decodeURIComponent(withoutScheme);
    const queryStr = qIndex >= 0 ? withoutScheme.slice(qIndex + 1) : '';
    const searchParams = new URLSearchParams(queryStr);
    const subject = searchParams.get('subject') ?? '';
    const msgBody = searchParams.get('body') ?? '';
    return {
      kind: 'email',
      to,
      subject,
      body: msgBody,
      mailtoHref: trimmed,
    };
  }

  // 4. SMS: smsto:123456:Hello or sms:123456?body=Hello
  if (/^smsto:/i.test(trimmed)) {
    const rest = trimmed.slice(6);
    const colonIdx = rest.indexOf(':');
    const number = colonIdx >= 0 ? rest.slice(0, colonIdx).trim() : rest.trim();
    const message = colonIdx >= 0 ? rest.slice(colonIdx + 1).trim() : '';
    const smsHref = message
      ? `sms:${number}?body=${encodeURIComponent(message)}`
      : `sms:${number}`;
    return {
      kind: 'sms',
      number,
      message,
      smsHref,
    };
  }

  if (/^sms:/i.test(trimmed)) {
    const rest = trimmed.slice(4);
    const qIdx = rest.indexOf('?');
    const number = qIdx >= 0 ? rest.slice(0, qIdx).trim() : rest.trim();
    const queryStr = qIdx >= 0 ? rest.slice(qIdx + 1) : '';
    const searchParams = new URLSearchParams(queryStr);
    const message = searchParams.get('body') ?? '';
    return {
      kind: 'sms',
      number,
      message,
      smsHref: trimmed,
    };
  }

  // 5. Phone: tel:+123456789
  if (/^tel:/i.test(trimmed)) {
    const number = trimmed.slice(4).trim();
    return {
      kind: 'phone',
      number,
      telHref: `tel:${number}`,
    };
  }

  // 6. TOTP: otpauth://totp/Issuer:Account?secret=XYZ&issuer=Issuer
  if (/^otpauth:\/\//i.test(trimmed)) {
    const withoutScheme = trimmed.replace(/^otpauth:\/\/[^/]+\/?/i, '');
    const qIdx = withoutScheme.indexOf('?');
    const rawLabel = qIdx >= 0 ? withoutScheme.slice(0, qIdx) : withoutScheme;
    let label = rawLabel;
    try {
      label = decodeURIComponent(rawLabel);
    } catch {
      label = rawLabel;
    }
    const queryStr = qIdx >= 0 ? withoutScheme.slice(qIdx + 1) : '';
    const searchParams = new URLSearchParams(queryStr);
    const secret = (searchParams.get('secret') ?? '').replace(/\s+/g, '').toUpperCase();
    let issuer = searchParams.get('issuer') ?? '';
    let account = label;
    if (label.includes(':')) {
      const [labelIssuer, ...restAccount] = label.split(':');
      if (!issuer) issuer = labelIssuer.trim();
      account = restAccount.join(':').trim();
    }
    const digits = Number.parseInt(searchParams.get('digits') ?? '6', 10) || 6;
    const period = Number.parseInt(searchParams.get('period') ?? '30', 10) || 30;
    return {
      kind: 'totp',
      label,
      account,
      issuer,
      secret,
      digits,
      period,
    };
  }

  // 7. URL or plain text
  if (looksLikeUrl(trimmed)) {
    const security = analyzeUrlSecurity(trimmed);
    return {
      kind: 'url',
      text: trimmed,
      ...security,
    };
  }

  return { kind: 'text', text: raw };
}

/**
 * Decodes an RFC 4648 Base32 secret string into a Uint8Array.
 *
 * @param {string} base32
 * @returns {Uint8Array}
 */
export function decodeBase32(base32) {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  const cleaned = String(base32 ?? '')
    .toUpperCase()
    .replace(/[\s=-]+/g, '');
  if (!cleaned) return new Uint8Array(0);

  let bits = 0;
  let value = 0;
  const bytes = [];

  for (let i = 0; i < cleaned.length; i++) {
    const idx = alphabet.indexOf(cleaned[i]);
    if (idx === -1) {
      throw new Error(`Invalid Base32 character: ${cleaned[i]}`);
    }
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      bytes.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }

  return new Uint8Array(bytes);
}

/**
 * Computes a live 6-digit (or N-digit) TOTP code using Web Crypto API HMAC-SHA1 (RFC 6238).
 *
 * @param {string} secretBase32 - Base32-encoded TOTP secret key
 * @param {number} [timestampMs] - Current timestamp in milliseconds (defaults to Date.now())
 * @param {number} [period=30] - Time step in seconds (default 30)
 * @param {number} [digits=6] - Number of digits (default 6)
 * @returns {Promise<{ code: string; remainingSeconds: number; period: number; counter: number }>}
 */
export async function generateTotpCode(
  secretBase32,
  timestampMs = Date.now(),
  period = 30,
  digits = 6
) {
  const keyBytes = decodeBase32(secretBase32);
  if (keyBytes.length === 0) {
    throw new Error('Empty TOTP secret');
  }

  const epochSeconds = Math.floor(timestampMs / 1000);
  const counter = Math.floor(epochSeconds / period);
  const remainingSeconds = period - (epochSeconds % period);

  const counterBytes = new Uint8Array(8);
  let temp = counter;
  for (let i = 7; i >= 0; i--) {
    counterBytes[i] = temp & 0xff;
    temp = Math.floor(temp / 256);
  }

  const subtle = globalThis.crypto?.subtle;
  if (!subtle) {
    throw new Error('Web Crypto API subtle is not available');
  }

  const cryptoKey = await subtle.importKey(
    'raw',
    keyBytes,
    { name: 'HMAC', hash: { name: 'SHA-1' } },
    false,
    ['sign']
  );

  const signature = await subtle.sign('HMAC', cryptoKey, counterBytes);
  const hmac = new Uint8Array(signature);
  const offset = hmac[hmac.length - 1] & 0x0f;
  const binary =
    ((hmac[offset] & 0x7f) << 24) |
    ((hmac[offset + 1] & 0xff) << 16) |
    ((hmac[offset + 2] & 0xff) << 8) |
    (hmac[offset + 3] & 0xff);

  const modulo = 10 ** digits;
  const code = String(binary % modulo).padStart(digits, '0');

  return {
    code,
    remainingSeconds,
    period,
    counter,
  };
}

/**
 * Applies a high-contrast grayscale luminance threshold (and optional inversion)
 * to RGBA pixel data. Returns a new Uint8ClampedArray.
 *
 * @param {Uint8ClampedArray} data
 * @param {number} [threshold=128]
 * @param {boolean} [invert=false]
 * @returns {Uint8ClampedArray}
 */
export function applyHighContrastThreshold(data, threshold = 128, invert = false) {
  const out = new Uint8ClampedArray(data.length);
  for (let i = 0; i + 3 < data.length; i += 4) {
    const r = data[i];
    const g = data[i + 1];
    const b = data[i + 2];
    const a = data[i + 3];
    const lum = a < 128 ? 255 : 0.299 * r + 0.587 * g + 0.114 * b;
    let bw = lum >= threshold ? 255 : 0;
    if (invert) bw = 255 - bw;
    out[i] = bw;
    out[i + 1] = bw;
    out[i + 2] = bw;
    out[i + 3] = 255;
  }
  return out;
}

/**
 * Normalizes low-contrast RGBA buffers by stretching luminance between min and max
 * and applying a clean binary threshold at the midpoint.
 *
 * @param {Uint8ClampedArray} data
 * @returns {Uint8ClampedArray}
 */
export function normalizeAndBinarizeLowContrast(data) {
  const out = new Uint8ClampedArray(data.length);
  let minLum = 255;
  let maxLum = 0;

  for (let i = 0; i + 3 < data.length; i += 4) {
    const a = data[i + 3];
    const lum = a < 128 ? 255 : 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2];
    if (lum < minLum) minLum = lum;
    if (lum > maxLum) maxLum = lum;
  }

  const mid = (minLum + maxLum) / 2;
  for (let i = 0; i + 3 < data.length; i += 4) {
    const a = data[i + 3];
    const lum = a < 128 ? 255 : 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2];
    const bw = lum >= mid ? 255 : 0;
    out[i] = bw;
    out[i + 1] = bw;
    out[i + 2] = bw;
    out[i + 3] = 255;
  }
  return out;
}

function escapeCsvCell(value) {
  const str = String(value ?? '');
  if (/[",\r\n]/.test(str)) {
    return `"${str.replace(/"/g, '""')}"`;
  }
  return str;
}

/**
 * Serializes an array of QR scan results to an RFC 4180 CSV string.
 *
 * @param {Array<{ timestamp?: string; source?: string; type?: string; isUrl?: boolean; data: string }>} results
 * @returns {string}
 */
export function serializeScanHistoryToCsv(results) {
  const header = 'timestamp,source,type,isUrl,data';
  const rows = (results ?? []).map((r) => {
    const ts = escapeCsvCell(r.timestamp ?? '');
    const src = escapeCsvCell(r.source ?? 'file');
    const kind = escapeCsvCell(r.type ?? (r.isUrl ? 'url' : 'text'));
    const urlFlag = r.isUrl ? 'true' : 'false';
    const dataCell = escapeCsvCell(r.data ?? '');
    return `${ts},${src},${kind},${urlFlag},${dataCell}`;
  });
  return [header, ...rows].join('\n');
}

/**
 * Serializes an array of QR scan results to a formatted JSON string.
 *
 * @param {Array<Record<string, unknown>>} results
 * @returns {string}
 */
export function serializeScanHistoryToJson(results) {
  return JSON.stringify(results ?? [], null, 2);
}

/**
 * Truncates decoded data for compact UI display.
 *
 * @param {string} data
 * @param {number} [maxLen=200]
 * @returns {string}
 */
export function truncateForDisplay(data, maxLen = 200) {
  const str = String(data ?? '');
  if (str.length <= maxLen) return str;
  return str.slice(0, maxLen) + '…';
}
