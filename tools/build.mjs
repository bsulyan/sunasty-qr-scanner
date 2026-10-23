#!/usr/bin/env node

import { mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import esbuild from 'esbuild';
import sharp from 'sharp';
import { zipSync } from 'fflate';
import { LOCALES, SUPPORTED_LOCALES } from '../src/core/i18n.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT_DIR = resolve(__dirname, '..');
const SRC_DIR = join(ROOT_DIR, 'src');
const DIST_DIR = join(ROOT_DIR, 'dist');
const ZIP_PATH = join(DIST_DIR, 'sunasty-qr-scanner-v1.0.1.zip');

const ICON_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 128 128">
  <rect x="6" y="6" width="116" height="116" rx="24" fill="#0f172a"/>
  <rect x="24" y="24" width="32" height="32" rx="4" fill="none" stroke="#ffffff" stroke-width="6"/>
  <rect x="34" y="34" width="12" height="12" rx="1.5" fill="#ffffff"/>
  <rect x="72" y="24" width="32" height="32" rx="4" fill="none" stroke="#ffffff" stroke-width="6"/>
  <rect x="82" y="34" width="12" height="12" rx="1.5" fill="#ffffff"/>
  <rect x="24" y="72" width="32" height="32" rx="4" fill="none" stroke="#ffffff" stroke-width="6"/>
  <rect x="34" y="82" width="12" height="12" rx="1.5" fill="#ffffff"/>
  <rect x="70" y="70" width="11" height="11" rx="1.5" fill="#2563eb"/>
  <rect x="93" y="70" width="11" height="11" rx="1.5" fill="#ffffff"/>
  <rect x="81.5" y="81.5" width="11" height="11" rx="1.5" fill="#2563eb"/>
  <rect x="70" y="93" width="11" height="11" rx="1.5" fill="#ffffff"/>
  <rect x="93" y="93" width="11" height="11" rx="1.5" fill="#2563eb"/>
</svg>`;

const RUNTIME_ENTRIES = [
  'manifest.json',
  'popup.html',
  'popup.css',
  'popup.js',
  'camera.html',
  'camera.js',
  'background.js',
  'icons',
  '_locales',
];

function collectDirForZip(dir, baseDir, acc) {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    const st = statSync(full);
    if (st.isDirectory()) {
      collectDirForZip(full, baseDir, acc);
    } else {
      const rel = relative(baseDir, full).replace(/\\/g, '/');
      acc[rel] = new Uint8Array(readFileSync(full));
    }
  }
}

function collectRuntimeFilesForZip(rootDir) {
  const acc = {};
  for (const item of RUNTIME_ENTRIES) {
    const full = join(rootDir, item);
    const st = statSync(full);
    if (st.isDirectory()) {
      collectDirForZip(full, rootDir, acc);
    } else {
      acc[item] = new Uint8Array(readFileSync(full));
    }
  }
  return acc;
}

export async function buildExtension() {
  mkdirSync(join(ROOT_DIR, 'icons'), { recursive: true });
  mkdirSync(DIST_DIR, { recursive: true });

  const manifest = {
    manifest_version: 3,
    name: '__MSG_extName__',
    description: '__MSG_extDescription__',
    version: '1.0.1',
    default_locale: 'en',
    homepage_url: 'https://sunasty.com/qr-scan/',
    author: 'Bastien Sulyan (Ulysan)',
    permissions: ['activeTab', 'contextMenus', 'storage', 'scripting'],
    icons: {
      16: 'icons/icon-16.png',
      32: 'icons/icon-32.png',
      48: 'icons/icon-48.png',
      128: 'icons/icon-128.png',
    },
    action: {
      default_popup: 'popup.html',
      default_title: '__MSG_extName__',
      default_icon: {
        16: 'icons/icon-16.png',
        32: 'icons/icon-32.png',
        48: 'icons/icon-48.png',
        128: 'icons/icon-128.png',
      },
    },
    background: {
      service_worker: 'background.js',
    },
    commands: {
      _execute_action: {
        suggested_key: {
          default: 'Alt+Shift+Q',
          mac: 'Alt+Shift+Q',
        },
        description: '__MSG_cmdScanTab__',
      },
    },
    content_security_policy: {
      extension_pages: "script-src 'self'; object-src 'self';",
    },
  };

  writeFileSync(join(ROOT_DIR, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n', 'utf8');

  for (const lang of SUPPORTED_LOCALES) {
    const dict = LOCALES[lang];
    if (!dict) throw new Error(`Missing locale dictionary: ${lang}`);
    if (dict.extName.length > 75) {
      throw new Error(`Locale ${lang} extName exceeds 75 chars (${dict.extName.length})`);
    }
    if (dict.extDescription.length > 132) {
      throw new Error(`Locale ${lang} extDescription exceeds 132 chars (${dict.extDescription.length})`);
    }
    const localeDir = join(ROOT_DIR, '_locales', lang);
    mkdirSync(localeDir, { recursive: true });
    const messagesJson = {};
    for (const [key, val] of Object.entries(dict)) {
      messagesJson[key] = { message: val };
    }
    writeFileSync(join(localeDir, 'messages.json'), JSON.stringify(messagesJson, null, 2) + '\n', 'utf8');
  }

  const svgBuffer = Buffer.from(ICON_SVG, 'utf8');
  for (const size of [16, 32, 48, 128]) {
    const iconOut = join(ROOT_DIR, 'icons', `icon-${size}.png`);
    await sharp(svgBuffer).resize(size, size).png({ compressionLevel: 9 }).toFile(iconOut);
  }

  await esbuild.build({
    entryPoints: [join(SRC_DIR, 'popup-entry.js')],
    bundle: true,
    outfile: join(ROOT_DIR, 'popup.js'),
    format: 'iife',
    target: ['chrome114'],
    charset: 'utf8',
    minify: false,
    legalComments: 'none',
    tsconfigRaw: '{}',
  });

  await esbuild.build({
    entryPoints: [join(SRC_DIR, 'camera-entry.js')],
    bundle: true,
    outfile: join(ROOT_DIR, 'camera.js'),
    format: 'iife',
    target: ['chrome114'],
    charset: 'utf8',
    minify: false,
    legalComments: 'none',
    tsconfigRaw: '{}',
  });

  const filesMap = collectRuntimeFilesForZip(ROOT_DIR);
  const zipped = zipSync(filesMap, { level: 9 });
  writeFileSync(ZIP_PATH, Buffer.from(zipped));

  console.log(`Built extension -> ${ROOT_DIR}`);
  console.log(`Packaged ZIP (${Object.keys(filesMap).length} files, ${zipped.byteLength} bytes) -> ${ZIP_PATH}`);
  return { outDir: ROOT_DIR, zipPath: ZIP_PATH, fileCount: Object.keys(filesMap).length };
}

const isMain =
  process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));

if (isMain) {
  buildExtension().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
