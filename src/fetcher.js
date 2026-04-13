/**
 * SerpDerp — URL Content Fetcher (Phase 2: Deep Scan)
 * Fetches HTML from discovered URLs, extracts visible text,
 * applies domain filtering, and caches results.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { createHash } from 'crypto';
import { isIP } from 'net';
import dns from 'dns/promises';
import path from 'path';

// ─── SSRF guard ──────────────────────────────────────────────────────────────

const MAX_FETCH_BYTES = 2 * 1024 * 1024; // 2 MB per page

function isPrivateIP(ip) {
  if (!ip) return true;
  const v = ip.toLowerCase();
  if (v === '::1' || v === '0.0.0.0' || v === '::') return true;
  if (v.startsWith('127.')) return true;
  if (v.startsWith('10.')) return true;
  if (v.startsWith('192.168.')) return true;
  if (/^172\.(1[6-9]|2\d|3[01])\./.test(v)) return true;
  if (v.startsWith('169.254.')) return true; // link-local + cloud metadata
  if (v.startsWith('fc') || v.startsWith('fd')) return true; // ULA v6
  if (v.startsWith('fe80')) return true; // link-local v6
  if (v === '::ffff:127.0.0.1') return true;
  return false;
}

/**
 * Validate a URL is safe to fetch: http(s) scheme + non-private host.
 * Note: DNS rebinding between check and connect is a residual risk;
 * acceptable for this offline-triage tool.
 * @returns {Promise<{ok: true} | {ok: false, reason: string}>}
 */
export async function checkUrlSafety(url) {
  let parsed;
  try { parsed = new URL(url); } catch { return { ok: false, reason: 'Invalid URL' }; }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return { ok: false, reason: `Blocked scheme: ${parsed.protocol}` };
  }
  const host = parsed.hostname;
  if (!host) return { ok: false, reason: 'No hostname' };
  if (isIP(host)) {
    return isPrivateIP(host) ? { ok: false, reason: 'Private/loopback IP' } : { ok: true };
  }
  try {
    const addrs = await dns.lookup(host, { all: true });
    if (!addrs.length) return { ok: false, reason: 'DNS empty' };
    for (const a of addrs) {
      if (isPrivateIP(a.address)) return { ok: false, reason: `Resolves to private IP ${a.address}` };
    }
    return { ok: true };
  } catch (err) {
    return { ok: false, reason: `DNS error: ${err.message}` };
  }
}

// ─── Domain Classification ──────────────────────────────────────────────────

/**
 * SUSPECT DOMAINS — known illicit ad, review, and escort platforms.
 * Organized by category. These get PRIORITY scanning.
 */
const SUSPECT_DOMAINS = new Set([
  // Review / Rating Sites
  'rubmaps.ch', 'rubmaps.com',
  'eccie.net',
  'usasexguide.nl', 'usasexguide.info',
  'eroticmonkey.ch', 'eroticmonkey.com',
  'theeroticreview.com',
  'tnaboard.com',
  'perb.cc',
  'mongerplanet.com',
  'sipsap.com',
  'happyendingz.com',
  'massageplanet.net',
  'amp-reviews.net',
  'spahunters.com',
  'naughtyreviews.com',

  // Classified Ad / Posting Platforms
  'skipthegames.com',
  'megapersonals.com', 'megapersonals.eu',
  'listcrawler.com',
  'escortbabylon.net',
  'bedpage.com',
  'adultsearch.com',
  'tryst.link',
  'slixa.com',
  'privatedelights.ch',
  'ts4rent.eu',
  'eros.com',
  'onebackpage.com',
  'ibackpage.com',
  'ebackpage.com',
  'yesbackpage.com',
  '2backpage.com',
  'postbackpage.com',
  'bodyrubsmap.com',
  'cityxguide.com',
  'escortalligator.com',
  'callescort.org',
  'eurogirlsescort.com',
  'gentlemanstiffany.com',

  // Forum / Discussion Boards
  'internationalsexguide.nl',
  'preferred411.com',
  'utopiaboys.com',

  // Aggregators (legacy — moved to AGGREGATOR_DOMAINS but kept here for scan inclusion)
  'escort-ads.com',
  'topescortbabes.com',
  'scarletblue.com.au',
]);

/**
 * DIRECT AD PLATFORMS — sites where the establishment itself is listed/advertised.
 * These get the highest score multiplier (1.5x).
 */
const DIRECT_AD_DOMAINS = new Set([
  'skipthegames.com', 'megapersonals.com', 'megapersonals.eu',
  'listcrawler.com', 'escortbabylon.net', 'bedpage.com',
  'adultsearch.com', 'tryst.link', 'slixa.com', 'privatedelights.ch',
  'ts4rent.eu', 'eros.com', 'onebackpage.com', 'ibackpage.com',
  'ebackpage.com', 'yesbackpage.com', '2backpage.com', 'postbackpage.com',
  'cityxguide.com', 'escortalligator.com', 'callescort.org',
  'eurogirlsescort.com', 'gentlemanstiffany.com', 'escort-ads.com',
  'topescortbabes.com', 'bodyrubsmap.com',
]);

/**
 * REVIEW/RATING SITES — sites where users review the establishment.
 * Baseline score multiplier (1.0x).
 */
const REVIEW_SITE_DOMAINS = new Set([
  'rubmaps.ch', 'rubmaps.com', 'rubmaps.city', 'forum.rubmaps.ch',
  'eccie.net', 'm.eccie.net',
  'usasexguide.nl', 'usasexguide.info',
  'eroticmonkey.ch', 'eroticmonkey.com',
  'theeroticreview.com', 'tnaboard.com',
  'perb.cc', 'mongerplanet.com', 'sipsap.com',
  'happyendingz.com', 'massageplanet.net', 'amp-reviews.net',
  'spahunters.com', 'naughtyreviews.com',
  'internationalsexguide.nl', 'preferred411.com',
]);

/**
 * AGGREGATOR/DIRECTORY SITES — city-level escort directories.
 * These often match on geography alone, not the specific establishment.
 * Lowest score multiplier (0.5x).
 */
const AGGREGATOR_DOMAINS = new Set([
  'hot.com', 'bunnyagent.com', 'massage2book.com',
  'worldredlightdistricts.com', '5escorts.com', 'xlamma.com',
  'secrethostess.com', 'callgirlxguide.com', 'scarletblue.com.au',
  'gfe.bedpage.com', 'bestprosintown.com', 'callgirlxguide.com',
  '365doctor.in', 'sonobello.com', 'harmelingpt.com', 'wanderlog.com',
  'postcard.inc', 'jobtoday.com',
]);

/**
 * MAINSTREAM DOMAINS — known false-positive sources. SKIP these.
 */
const SKIP_DOMAINS = new Set([
  'google.com', 'google.co', 'goo.gl',
  'yelp.com',
  'yellowpages.com',
  'bbb.org',
  'facebook.com', 'fb.com',
  'instagram.com',
  'twitter.com', 'x.com',
  'linkedin.com',
  'mapquest.com',
  'manta.com',
  'chamberofcommerce.com',
  'superpages.com',
  'whitepages.com',
  'angi.com', 'angieslist.com',
  'thumbtack.com',
  'nextdoor.com',
  'foursquare.com',
  'tripadvisor.com',
  'trustpilot.com',
  'glassdoor.com',
  'indeed.com',
  'apple.com',
  'microsoft.com',
  'amazon.com',
  'wikipedia.org',
  'pinterest.com',
  'tiktok.com',
  'youtube.com',
  'massagebook.com',
  'vagaro.com',
  'mindbodyonline.com',
  'schedulicity.com',
  'groupon.com',
  'booksy.com',
  'genbook.com',
  'reddit.com',
]);

/**
 * Extract the registrable domain from a URL
 * "https://www.rubmaps.ch/foo/bar" → "rubmaps.ch"
 */
function extractDomain(url) {
  try {
    const hostname = new URL(url).hostname.toLowerCase();
    return hostname.replace(/^www\./, '');
  } catch {
    return null;
  }
}

/**
 * Data file extensions — skip these URLs entirely
 */
const DATA_FILE_EXTENSIONS = new Set([
  '.csv', '.xlsx', '.xls', '.tsv', '.json',
  '.pdf', '.doc', '.docx',
  '.zip', '.gz', '.tar', '.7z',
  '.xml', '.rss',
]);

function isDataFileUrl(url) {
  try {
    const pathname = new URL(url).pathname.toLowerCase();
    return [...DATA_FILE_EXTENSIONS].some((ext) => pathname.endsWith(ext));
  } catch {
    return false;
  }
}

/**
 * Helper: check if domain matches a set (exact or subdomain)
 */
function domainMatchesSet(domain, domainSet) {
  if (domainSet.has(domain)) return true;
  for (const d of domainSet) {
    if (domain.endsWith(`.${d}`)) return true;
  }
  return false;
}

/**
 * Classify a URL's domain for scan/skip decisions
 * @returns {'suspect' | 'skip' | 'unknown'}
 */
export function classifyDomain(url) {
  const domain = extractDomain(url);
  if (!domain) return 'skip';
  if (isDataFileUrl(url)) return 'skip';
  if (domainMatchesSet(domain, SKIP_DOMAINS)) return 'skip';
  if (domain.endsWith('.gov')) return 'skip';
  if (domainMatchesSet(domain, SUSPECT_DOMAINS)) return 'suspect';
  if (domainMatchesSet(domain, DIRECT_AD_DOMAINS)) return 'suspect';
  if (domainMatchesSet(domain, REVIEW_SITE_DOMAINS)) return 'suspect';
  if (domainMatchesSet(domain, AGGREGATOR_DOMAINS)) return 'suspect';
  return 'unknown';
}

/**
 * Get the source type for scoring multiplier.
 * @param {string} url
 * @returns {'direct_ad' | 'review_site' | 'aggregator' | 'unknown'}
 */
export function getSourceType(url) {
  const domain = extractDomain(url);
  if (!domain) return 'unknown';
  if (domainMatchesSet(domain, DIRECT_AD_DOMAINS)) return 'direct_ad';
  if (domainMatchesSet(domain, REVIEW_SITE_DOMAINS)) return 'review_site';
  if (domainMatchesSet(domain, AGGREGATOR_DOMAINS)) return 'aggregator';
  return 'unknown';
}

// ─── HTML Text Extraction ────────────────────────────────────────────────────

/**
 * Strip HTML tags and extract visible text content
 * Keeps meaningful spacing between elements
 */
function htmlToText(html) {
  return html
    // Remove script and style blocks entirely
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, ' ')
    // Convert block elements to newlines
    .replace(/<\/(p|div|h[1-6]|li|tr|br|hr)[^>]*>/gi, '\n')
    .replace(/<br\s*\/?>/gi, '\n')
    // Remove all remaining tags
    .replace(/<[^>]+>/g, ' ')
    // Decode common HTML entities
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, ' ')
    // Collapse whitespace
    .replace(/[ \t]+/g, ' ')
    .replace(/\n\s*\n/g, '\n')
    .trim();
}

// ─── URL Fetcher ─────────────────────────────────────────────────────────────

/**
 * Generate cache key from URL
 */
function urlCacheKey(url) {
  return createHash('md5').update(url).digest('hex');
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Fetch a single URL and extract its text content
 * @param {string} url
 * @param {object} opts
 * @param {string} opts.cacheDir
 * @param {boolean} opts.noCache
 * @param {number} opts.timeoutMs
 * @returns {Promise<{url, text, domain, classification, error?}>}
 */
async function fetchUrl(url, opts = {}) {
  const { cacheDir, noCache = false, timeoutMs = 10000 } = opts;

  const domain = extractDomain(url);
  const classification = classifyDomain(url);

  // Check cache
  const cacheFile = path.join(cacheDir, `${urlCacheKey(url)}.json`);
  if (!noCache && existsSync(cacheFile)) {
    try {
      const cached = JSON.parse(readFileSync(cacheFile, 'utf-8'));
      return { ...cached, fromCache: true };
    } catch {
      // Corrupted cache
    }
  }

  try {
    const safety = await checkUrlSafety(url);
    if (!safety.ok) throw new Error(`Blocked: ${safety.reason}`);

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);

    const response = await fetch(url, {
      signal: controller.signal,
      headers: {
        'User-Agent':
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
        Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.9',
      },
      redirect: 'follow',
    });

    if (!response.ok) {
      clearTimeout(timeout);
      throw new Error(`HTTP ${response.status}`);
    }

    const contentType = response.headers.get('content-type') || '';
    if (!contentType.includes('text/html') && !contentType.includes('application/xhtml')) {
      clearTimeout(timeout);
      throw new Error(`Non-HTML content: ${contentType}`);
    }

    // Streaming read with a hard byte cap to avoid memory exhaustion.
    const reader = response.body.getReader();
    const chunks = [];
    let total = 0;
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        total += value.length;
        if (total > MAX_FETCH_BYTES) {
          await reader.cancel();
          throw new Error(`Response too large (>${MAX_FETCH_BYTES} bytes)`);
        }
        chunks.push(value);
      }
    } finally {
      clearTimeout(timeout);
    }
    const html = Buffer.concat(chunks).toString('utf-8');
    const text = htmlToText(html);

    const result = {
      url,
      domain,
      classification,
      text: text.slice(0, 50000), // Cap at 50KB of text
      textLength: text.length,
      fetchedAt: new Date().toISOString(),
      error: null,
    };

    // Cache
    mkdirSync(path.dirname(cacheFile), { recursive: true });
    writeFileSync(cacheFile, JSON.stringify(result, null, 2));

    return { ...result, fromCache: false };
  } catch (err) {
    const errorMsg = err.name === 'AbortError' ? 'Timeout (10s)' : err.message;
    return {
      url,
      domain,
      classification,
      text: '',
      textLength: 0,
      fetchedAt: new Date().toISOString(),
      error: errorMsg,
      fromCache: false,
    };
  }
}

/**
 * Fetch all URLs from search results for a single establishment
 * Filters out skip-listed domains, fetches suspect + unknown domains
 * @param {Array} organicResults - From SerpApi searcher
 * @param {object} opts
 * @returns {Promise<Array>} Array of fetch results
 */
export async function fetchUrls(organicResults, opts = {}) {
  const { cacheDir, noCache = false, fetchDelay = 500 } = opts;

  const results = [];

  for (const organic of organicResults) {
    const classification = classifyDomain(organic.link);

    if (classification === 'skip') {
      continue; // Skip mainstream domains
    }

    const fetchResult = await fetchUrl(organic.link, { cacheDir, noCache });

    // Attach the SerpApi snippet for additional context
    fetchResult.serpSnippet = organic.snippet;
    fetchResult.serpTitle = organic.title;

    results.push(fetchResult);

    // Brief delay between fetches
    if (!fetchResult.fromCache) {
      await sleep(fetchDelay);
    }
  }

  return results;
}

export { SUSPECT_DOMAINS, SKIP_DOMAINS, extractDomain, htmlToText };
