/**
 * SerpDerp — SerpApi Search Module (Phase 1: Discovery)
 * Searches phone numbers + trafficking keywords via Google Search API.
 * Includes rate limiting, retry logic, and disk caching.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { createHash } from 'crypto';
import path from 'path';
import { formatPhone } from './ingest.js';

const SEARCH_ENDPOINT = 'https://serpapi.com/search.json';

/**
 * Build the search query for a phone number
 * Uses exact-match quoting + boolean OR for keywords
 */
function buildQuery(phoneNorm) {
  const formatted = formatPhone(phoneNorm);
  return `"${formatted}" ("girls" OR "escort" OR "rubmaps" OR "sex")`;
}

/**
 * Generate a cache key from phone number
 */
function cacheKey(phoneNorm) {
  return createHash('md5').update(phoneNorm).digest('hex');
}

/**
 * Sleep for ms milliseconds
 */
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Search SerpApi for a single phone number
 * @param {string} phoneNorm - 10-digit normalized phone
 * @param {object} opts
 * @param {string} opts.apiKey - SerpApi key
 * @param {string} opts.cacheDir - Cache directory path
 * @param {boolean} opts.noCache - Skip cache
 * @returns {Promise<object>} Search results
 */
async function searchSingle(phoneNorm, opts) {
  const { apiKey, cacheDir, noCache = false } = opts;

  // Check cache
  const cacheFile = path.join(cacheDir, `${cacheKey(phoneNorm)}.json`);
  if (!noCache && existsSync(cacheFile)) {
    try {
      const cached = JSON.parse(readFileSync(cacheFile, 'utf-8'));
      return { ...cached, fromCache: true };
    } catch {
      // Corrupted cache, re-fetch
    }
  }

  const query = buildQuery(phoneNorm);

  const params = new URLSearchParams({
    engine: 'google',
    q: query,
    api_key: apiKey,
    gl: 'us',
    hl: 'en',
    safe: 'off',
    num: '20',
  });

  const url = `${SEARCH_ENDPOINT}?${params.toString()}`;

  // Retry with exponential backoff
  let lastError;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const response = await fetch(url);

      if (response.status === 429) {
        // Rate limited — wait longer
        const waitMs = Math.pow(2, attempt + 2) * 1000;
        console.warn(`  ⚠ Rate limited, waiting ${waitMs / 1000}s...`);
        await sleep(waitMs);
        continue;
      }

      if (!response.ok) {
        const text = await response.text();
        throw new Error(`SerpApi HTTP ${response.status}: ${text.slice(0, 200)}`);
      }

      const data = await response.json();

      // Check for API-level errors
      if (data.error) {
        throw new Error(`SerpApi error: ${data.error}`);
      }

      // Extract what we need
      const result = {
        phoneNorm,
        query,
        totalResults: data.search_information?.total_results || 0,
        organicResults: (data.organic_results || []).map((r) => ({
          position: r.position,
          title: r.title || '',
          link: r.link || '',
          snippet: r.snippet || '',
          displayedLink: r.displayed_link || '',
        })),
        searchedAt: new Date().toISOString(),
        fromCache: false,
      };

      // Save to cache
      mkdirSync(path.dirname(cacheFile), { recursive: true });
      writeFileSync(cacheFile, JSON.stringify(result, null, 2));

      return result;
    } catch (err) {
      lastError = err;
      if (attempt < 2) {
        const waitMs = Math.pow(2, attempt) * 1000;
        console.warn(`  ⚠ Attempt ${attempt + 1} failed: ${err.message}. Retrying in ${waitMs / 1000}s...`);
        await sleep(waitMs);
      }
    }
  }

  // All retries exhausted
  return {
    phoneNorm,
    query: buildQuery(phoneNorm),
    totalResults: 0,
    organicResults: [],
    searchedAt: new Date().toISOString(),
    fromCache: false,
    error: lastError?.message || 'Unknown error after 3 retries',
  };
}

/**
 * Bulk search an array of establishment records
 * @param {Array} records - From ingest module
 * @param {object} opts
 * @param {string} opts.apiKey
 * @param {string} opts.cacheDir
 * @param {number} opts.delay - ms between requests (default 1500)
 * @param {boolean} opts.noCache
 * @param {number} opts.limit - max records to search (0 = all)
 * @returns {AsyncGenerator} Yields {record, searchResult} objects
 */
export async function* bulkSearch(records, opts) {
  const { apiKey, cacheDir, delay = 1500, noCache = false, limit = 0 } = opts;

  const toSearch = limit > 0 ? records.slice(0, limit) : records;
  const total = toSearch.length;
  let cachedCount = 0;
  let apiCount = 0;
  let errorCount = 0;

  for (let i = 0; i < total; i++) {
    const record = toSearch[i];
    const searchResult = await searchSingle(record.phoneNorm, { apiKey, cacheDir, noCache });

    if (searchResult.fromCache) cachedCount++;
    else apiCount++;
    if (searchResult.error) errorCount++;

    const hitCount = searchResult.organicResults.length;
    const status = searchResult.error
      ? `❌ Error: ${searchResult.error}`
      : searchResult.fromCache
        ? `📦 Cached — ${hitCount} results`
        : `${hitCount} results`;

    console.log(
      `[${i + 1}/${total}] ${record.phoneFormatted} (${record.licensee.slice(0, 30)})... ${status}`
    );

    yield { record, searchResult };

    // Rate limit (skip delay for cached results)
    if (!searchResult.fromCache && i < total - 1) {
      await sleep(delay);
    }
  }

  console.log(`\nPhase 1 complete: ${apiCount} API calls, ${cachedCount} cached, ${errorCount} errors`);
}

export { buildQuery, cacheKey };

/**
 * Build a search query using physical address + city.
 * Strips suite/unit/apt numbers — Google doesn't index them reliably.
 */
function buildAddressQuery(address, city, state) {
  const addr = address
    .replace(/\b(?:STE|SUITE|APT|UNIT|SPC|BLDG|RM|#)\s*[\w-]*/gi, '') // strip suite/unit
    .replace(/[^\w\s]/g, '') // strip punctuation
    .replace(/\s+/g, ' ')
    .trim();
  return `"${addr}" "${city}" ("escort" OR "rubmaps" OR "sex" OR "girls")`;
}

/**
 * Search SerpApi for a single establishment by name/address
 */
async function searchSingleByName(record, opts) {
  const { apiKey, cacheDir, noCache = false } = opts;
  const addrKey = `${record.address}_${record.city}_${record.state}`.toLowerCase().replace(/\W+/g, '_');
  const cacheHash = createHash('md5').update(addrKey).digest('hex');
  const cacheFile = path.join(cacheDir, `${cacheHash}.json`);

  if (!noCache && existsSync(cacheFile)) {
    try {
      const cached = JSON.parse(readFileSync(cacheFile, 'utf-8'));
      return { ...cached, fromCache: true };
    } catch {}
  }

  const query = buildAddressQuery(record.address, record.city, record.state);
  const params = new URLSearchParams({ engine: 'google', q: query, api_key: apiKey, num: 10, gl: 'us', hl: 'en' });

  let lastError = null;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const res = await fetch(`${SEARCH_ENDPOINT}?${params}`);
      if (!res.ok) {
        const body = await res.text();
        throw new Error(`SerpApi error: ${res.status} — ${body.slice(0, 200)}`);
      }
      const data = await res.json();
      if (data.error) throw new Error(`SerpApi error: ${data.error}`);

      const result = {
        addrKey,
        query,
        totalResults: data.search_information?.total_results || 0,
        organicResults: (data.organic_results || []).slice(0, 10).map((r) => ({
          position: r.position, title: r.title || '', link: r.link || '',
          snippet: r.snippet || '', displayedLink: r.displayed_link || '',
        })),
        searchedAt: new Date().toISOString(),
        fromCache: false,
      };

      if (!existsSync(cacheDir)) mkdirSync(cacheDir, { recursive: true });
      writeFileSync(cacheFile, JSON.stringify(result, null, 2));
      return result;
    } catch (err) {
      lastError = err;
      if (attempt < 2) await sleep(Math.pow(2, attempt) * 1000);
    }
  }
  return { addrKey, query, totalResults: 0, organicResults: [], searchedAt: new Date().toISOString(), fromCache: false, error: lastError?.message || 'Unknown error' };
}

/**
 * Bulk search establishments by name/address
 * @param {Array} records - Establishment records to search
 * @param {object} opts
 * @returns {AsyncGenerator} Yields {record, searchResult}
 */
export async function* bulkSearchByName(records, opts) {
  const { apiKey, cacheDir, delay = 1500, noCache = false } = opts;
  const total = records.length;
  let cachedCount = 0, apiCount = 0, errorCount = 0;

  for (let i = 0; i < total; i++) {
    const record = records[i];
    const searchResult = await searchSingleByName(record, { apiKey, cacheDir, noCache });
    if (searchResult.fromCache) cachedCount++; else apiCount++;
    if (searchResult.error) errorCount++;

    const hitCount = searchResult.organicResults.length;
    const status = searchResult.error ? `❌ ${searchResult.error}` : searchResult.fromCache ? `📦 Cached — ${hitCount}` : `${hitCount} results`;
    console.log(`[${i + 1}/${total}] ${record.licensee.slice(0, 30)} (${record.city})... ${status}`);
    yield { record, searchResult };

    if (!searchResult.fromCache && i < total - 1) await sleep(delay);
  }
  console.log(`\nAddress search complete: ${apiCount} API calls, ${cachedCount} cached, ${errorCount} errors`);
}
