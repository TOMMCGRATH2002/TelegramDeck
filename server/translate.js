/**
 * translate.js
 * Lightweight translation using:
 *   1. Google Cloud Translation API (if GOOGLE_TRANSLATE_API_KEY is set)
 *   2. Free unofficial endpoint as fallback (no key needed, rate-limited)
 *
 * Returns { translatedText, detectedLanguage } or null on failure.
 */

const fetch = require('node-fetch');

const GCP_KEY = process.env.GOOGLE_TRANSLATE_API_KEY;

/**
 * Detect language and translate to English if not already English.
 * @param {string} text
 * @returns {Promise<{ translatedText: string, sourceLang: string } | null>}
 */
async function translateToEnglish(text) {
  if (!text || !text.trim()) return null;

  try {
    if (GCP_KEY) {
      return await translateGCP(text);
    } else {
      return await translateFree(text);
    }
  } catch (err) {
    console.warn('Translation failed:', err.message);
    return null;
  }
}

// ─── Google Cloud Translation API ───────────────────────────
async function translateGCP(text) {
  const url = `https://translation.googleapis.com/language/translate/v2?key=${GCP_KEY}`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ q: text, target: 'en', format: 'text' }),
  });
  const data = await res.json();
  const translation = data?.data?.translations?.[0];
  if (!translation) return null;

  const sourceLang = translation.detectedSourceLanguage || 'unknown';
  if (sourceLang === 'en') return null; // already English

  return {
    translatedText: translation.translatedText,
    sourceLang,
  };
}

// ─── Free unofficial endpoint (Google Translate web scrape) ──
// Uses the same endpoint the web app uses. No key required.
// Rate-limited — fine for personal use.
async function translateFree(text) {
  const params = new URLSearchParams({
    client: 'gtx',
    sl: 'auto',
    tl: 'en',
    dt: 't',
    q: text,
  });

  const res = await fetch(`https://translate.googleapis.com/translate_a/single?${params}`, {
    headers: { 'User-Agent': 'Mozilla/5.0' },
    timeout: 5000,
  });

  if (!res.ok) return null;
  const data = await res.json();

  // Response format: [ [ ["translated", "original", ...], ... ], null, "sourceLang" ]
  const sourceLang = data?.[2] || 'unknown';
  if (sourceLang === 'en') return null; // already English, no need to show translation

  const translatedText = data?.[0]
    ?.map(chunk => chunk?.[0] || '')
    .join('') || null;

  if (!translatedText) return null;

  return { translatedText, sourceLang };
}

module.exports = { translateToEnglish };
