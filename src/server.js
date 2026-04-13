#!/usr/bin/env node
/**
 * SerpDerp v2 — Unified Pipeline Server
 * 4-phase pipeline: Phone Search → Address Search → Deep Scan → Output
 * Usage: node src/server.js   →   http://localhost:3456
 */

import 'dotenv/config';
import express from 'express';
import { EventEmitter } from 'events';
import { fileURLToPath } from 'url';
import { dirname, join, resolve, basename, sep } from 'path';
import { existsSync, writeFileSync, mkdirSync } from 'fs';
import { randomBytes, timingSafeEqual } from 'crypto';
import { spawn } from 'child_process';
import { ingestCSV } from './ingest.js';
import { bulkSearch, bulkSearchByName } from './searcher.js';
import { fetchUrls } from './fetcher.js';
import { analyzeAll, calculateRisk, quickClassify } from './analyzer.js';
import { writeCSV, writeJSON, writeSummary } from './output.js';
import { takeScreenshot } from './screenshot.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// ─── Security: roots for path validation ────────────────────────────────────
const UPLOAD_ROOT = resolve('./uploads');
const OUTPUT_ROOT = resolve('./output');
mkdirSync(UPLOAD_ROOT, { recursive: true });
mkdirSync(OUTPUT_ROOT, { recursive: true });

function ensureWithin(root, target) {
  const full = resolve(target);
  if (full !== root && !full.startsWith(root + sep)) {
    throw new Error(`Path outside allowed root: ${target}`);
  }
  return full;
}

function safeUploadFilename(name) {
  const base = basename(String(name || 'input.csv'));
  // Block control chars, path separators, and Windows-reserved characters.
  // basename() already strips directory components; this catches anything
  // weird that slips through and prevents surprises on the filesystem.
  if (/[\x00-\x1f\\/:*?"<>|]/.test(base)) throw new Error('Invalid filename characters');
  if (!base.toLowerCase().endsWith('.csv')) throw new Error('Only .csv files allowed');
  return ensureWithin(UPLOAD_ROOT, join(UPLOAD_ROOT, base));
}

// ─── Security: auth token ───────────────────────────────────────────────────
const AUTH_TOKEN = randomBytes(24).toString('hex');
const AUTH_TOKEN_BUF = Buffer.from(AUTH_TOKEN);

function tokenMatches(provided) {
  if (typeof provided !== 'string') return false;
  const buf = Buffer.from(provided);
  if (buf.length !== AUTH_TOKEN_BUF.length) return false;
  return timingSafeEqual(buf, AUTH_TOKEN_BUF);
}

const app = express();
app.use(express.json({ limit: '20mb' })); // CSV upload cap

// Auth middleware for /api/* routes. Accepts header or ?t= query string
// (EventSource cannot set custom headers, so SSE uses the query form).
app.use('/api', (req, res, next) => {
  const provided = req.get('X-Auth-Token') || req.query.t;
  if (!tokenMatches(provided)) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  next();
});

// ─── Pipeline State ──────────────────────────────────────────────────────────

const state = { running: false, aborted: false, startedAt: null, phase: 'idle', outputDir: null };
const bus = new EventEmitter();

// ─── Routes ──────────────────────────────────────────────────────────────────

// Dashboard root: inject the auth token into the page on first load
// so the user doesn't need to copy/paste it from the console.
app.get('/', (req, res) => {
  if (req.query.t && tokenMatches(req.query.t)) {
    return res.sendFile(join(__dirname, 'dashboard.html'));
  }
  res.status(401).type('text/plain').send(
    'Unauthorized. Open the URL printed in the server console (includes ?t=<token>).'
  );
});

// Download a starter CSV template so users can see the expected columns.
app.get('/api/template.csv', (_req, res) => {
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', 'attachment; filename="serpderp-template.csv"');
  res.sendFile(join(__dirname, 'template.csv'));
});

// Upload CSV — receives file content as JSON, saves to disk
app.post('/api/upload-csv', (req, res) => {
  try {
    const { content, filename } = req.body;
    if (typeof content !== 'string' || !content) {
      return res.status(400).json({ error: 'No CSV content' });
    }
    if (content.length > 20 * 1024 * 1024) {
      return res.status(413).json({ error: 'CSV too large (max 20 MB)' });
    }
    const savePath = safeUploadFilename(filename);
    writeFileSync(savePath, content, 'utf-8');
    res.json({ path: savePath, size: content.length });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// Start unified pipeline
app.post('/api/start', (req, res) => {
  if (state.running) return res.status(409).json({ error: 'Pipeline already running' });
  const { csvPath, apiKey, limit = 0, outputDir = './output', delay = 1500, fetchDelay = 500, noCache = false, addressOnly = false, captureAds = false } = req.body;
  if (!csvPath) return res.status(400).json({ error: 'No CSV path provided' });
  if (!apiKey) return res.status(400).json({ error: 'No SERPAPI Key provided' });

  let fullCsv, fullOut;
  try {
    fullCsv = ensureWithin(UPLOAD_ROOT, csvPath);
    fullOut = ensureWithin(OUTPUT_ROOT, outputDir);
  } catch (err) {
    return res.status(400).json({ error: err.message });
  }
  if (!existsSync(fullCsv)) return res.status(400).json({ error: `CSV not found: ${fullCsv}` });

  const parsedLimit = parseInt(limit, 10) || 0;
  console.log(`Starting pipeline: csv=${fullCsv}, limit=${parsedLimit}, addressOnly=${addressOnly}, noCache=${noCache}, captureAds=${captureAds}`);
  res.json({ status: 'started' });
  runPipeline({ csvPath: fullCsv, limit: parsedLimit, outputDir: fullOut, delay: parseInt(delay,10)||1500, fetchDelay: parseInt(fetchDelay,10)||500, noCache, apiKey, addressOnly, captureAds });
});

// Stop
app.post('/api/stop', (_req, res) => {
  if (!state.running) return res.status(409).json({ error: 'No pipeline running' });
  state.aborted = true;
  res.json({ status: 'stopping' });
});

// Status
app.get('/api/status', (_req, res) => res.json(state));

// Open the last run's output directory in the host OS file manager.
// Path is re-validated against OUTPUT_ROOT; argv is passed to spawn()
// without a shell so there is no command injection surface.
app.post('/api/open-output', (_req, res) => {
  if (!state.outputDir) {
    return res.status(400).json({ error: 'No output directory yet — run a pipeline first.' });
  }
  let target;
  try {
    target = ensureWithin(OUTPUT_ROOT, state.outputDir);
  } catch (err) {
    return res.status(400).json({ error: err.message });
  }
  if (!existsSync(target)) {
    return res.status(400).json({ error: `Output directory does not exist: ${target}` });
  }

  let cmd, args;
  if (process.platform === 'win32')      { cmd = 'explorer.exe'; args = [target]; }
  else if (process.platform === 'darwin'){ cmd = 'open';          args = [target]; }
  else                                   { cmd = 'xdg-open';      args = [target]; }

  try {
    const child = spawn(cmd, args, { detached: true, stdio: 'ignore', shell: false });
    child.on('error', (err) => console.error(`open-output spawn error: ${err.message}`));
    child.unref();
    res.json({ ok: true, path: target });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// SSE
app.get('/api/events', (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  const onEvent = (data) => res.write(`data: ${JSON.stringify(data)}\n\n`);
  bus.on('pipeline', onEvent);
  req.on('close', () => bus.off('pipeline', onEvent));
});

// ─── Unified Pipeline ────────────────────────────────────────────────────────

async function runPipeline(opts) {
  state.running = true;
  state.aborted = false;
  state.startedAt = Date.now();
  state.phase = 'ingest';
  state.outputDir = opts.outputDir;

  const emit = (data) => bus.emit('pipeline', data);

  try {
    // ─── INGEST ──────────────────────────────────────────────────────────
    emit({ type: 'phase', phase: 'ingest', message: 'Parsing CSV...' });
    const { records: rawRecords, stats: ingestStats } = await ingestCSV(opts.csvPath);
    let records = rawRecords;
    if (opts.limit > 0) records = records.slice(0, opts.limit);
    emit({ type: 'ingest_done', total: records.length, stats: ingestStats });

    if (records.length === 0) {
      emit({ type: 'complete', message: 'No valid records found in CSV', stats: { totalResults: 0 }, riskTiers: { HIGH: 0, MEDIUM: 0, LOW: 0, NONE: 0 }, elapsed: Date.now() - state.startedAt });
      state.running = false; state.phase = 'done'; return;
    }

    const phoneResults = new Map(); // phoneNorm → { record, searchResult }
    let apiCalls = 0, cachedSearches = 0, searchErrors = 0;

    if (!opts.addressOnly) {
      // ─── PHASE 1: PHONE SEARCH ─────────────────────────────────────────
      state.phase = 'phone_search';
      emit({ type: 'phase', phase: 'phone_search', message: `📞 Phase 1: Searching ${records.length} phones...` });
      const phoneCacheDir = join(opts.outputDir, 'cache', 'search');
      let idx = 0;

      for await (const { record, searchResult } of bulkSearch(records, {
        apiKey: opts.apiKey, cacheDir: phoneCacheDir, delay: opts.delay, noCache: opts.noCache,
      })) {
        if (state.aborted) { emit({ type: 'aborted', message: 'Stopped by user' }); state.running = false; return; }
        idx++;
        if (searchResult.fromCache) cachedSearches++; else apiCalls++;
        if (searchResult.error) searchErrors++;

        const tier = quickClassify(searchResult);
        phoneResults.set(record.phoneNorm, { record, searchResult, phoneTier: tier });

        emit({
          type: 'search_progress', current: idx, total: records.length,
          identifier: record.phoneFormatted, licensee: record.licensee.slice(0, 40),
          hits: searchResult.organicResults.length, cached: searchResult.fromCache,
          error: searchResult.error || null, apiCalls, cachedSearches, searchErrors,
          tier,
        });
      }
      if (state.aborted) { emit({ type: 'aborted', message: 'Stopped by user' }); state.running = false; return; }

      const p1ApiCalls = apiCalls;
      emit({ type: 'phase_done', phase: 'phone_search', message: `Phase 1 complete: ${p1ApiCalls} API calls, ${cachedSearches} cached, ${searchErrors} errors` });
      console.log(`Phase 1 complete: ${p1ApiCalls} API calls, ${cachedSearches} cached, ${searchErrors} errors`);
    } else {
      // Address-only mode: seed phoneResults with empty search results
      for (const record of records) {
        phoneResults.set(record.phoneNorm, { record, searchResult: { totalResults: 0, organicResults: [] }, phoneTier: 'NONE' });
      }
      emit({ type: 'phase_done', phase: 'phone_search', message: 'Phase 1 skipped (address-only mode)' });
      console.log('Phase 1 skipped (address-only mode)');
    }

    // ─── PHASE 2: ADDRESS SEARCH ─────────────────────────────────────────
    state.phase = 'address_search';
    const needsAddress = opts.addressOnly
      ? [...phoneResults.values()] // address-only: search ALL
      : [...phoneResults.values()].filter(({ phoneTier }) => phoneTier === 'NONE' || phoneTier === 'LOW');
    const skipCount = phoneResults.size - needsAddress.length;
    emit({ type: 'phase', phase: 'address_search', message: `📍 Phase 2: Address search on ${needsAddress.length} establishments${skipCount > 0 ? ` (skipping ${skipCount} with hits)` : ''}...` });

    const addrCacheDir = join(opts.outputDir, 'cache', 'search-addr');
    const addressRecords = needsAddress.map(({ record }) => record);
    let addrApiCalls = 0, addrCached = 0, addrErrors = 0, addrIdx = 0;

    for await (const { record, searchResult } of bulkSearchByName(addressRecords, {
      apiKey: opts.apiKey, cacheDir: addrCacheDir, delay: opts.delay, noCache: opts.noCache,
    })) {
      if (state.aborted) { emit({ type: 'aborted', message: 'Stopped by user' }); state.running = false; return; }
      addrIdx++;
      if (searchResult.fromCache) addrCached++; else addrApiCalls++;
      if (searchResult.error) addrErrors++;

      // Merge address results into existing phone results
      const existing = phoneResults.get(record.phoneNorm);
      if (existing) {
        // Combine organic results (dedupe by URL)
        const existingUrls = new Set(existing.searchResult.organicResults.map((r) => r.link));
        const newResults = searchResult.organicResults.filter((r) => !existingUrls.has(r.link));
        existing.searchResult.organicResults.push(...newResults.map((r) => ({ ...r, source: 'address' })));
        existing.searchResult.totalResults += searchResult.totalResults;
        existing.addressSearchResult = searchResult;
      }

      emit({
        type: 'search_progress', current: addrIdx, total: addressRecords.length,
        identifier: record.address, licensee: record.licensee.slice(0, 40),
        hits: searchResult.organicResults.length, cached: searchResult.fromCache,
        error: searchResult.error || null,
        apiCalls: apiCalls + addrApiCalls, cachedSearches: cachedSearches + addrCached, searchErrors: searchErrors + addrErrors,
      });
    }
    if (state.aborted) { emit({ type: 'aborted', message: 'Stopped by user' }); state.running = false; return; }

    apiCalls += addrApiCalls; cachedSearches += addrCached; searchErrors += addrErrors;
    emit({ type: 'phase_done', phase: 'address_search', message: `Phase 2 complete: ${addrApiCalls} API calls, ${addrCached} cached` });
    console.log(`Phase 2 complete: ${addrApiCalls} API calls, ${addrCached} cached, ${addrErrors} errors`);

    // ─── PHASE 3: DEEP SCAN ──────────────────────────────────────────────
    state.phase = 'deepscan';
    // Collect all unique URLs to fetch, tracking which source they came from
    const urlsToFetch = [];
    for (const [phoneNorm, { record, searchResult, addressSearchResult }] of phoneResults) {
      const urls = searchResult.organicResults;
      if (urls.length > 0) {
        urlsToFetch.push({
          record,
          urls,
          phoneNorm,
          hasAddressSource: !!addressSearchResult,
        });
      }
    }

    emit({ type: 'phase', phase: 'deepscan', message: `🔍 Phase 3: Deep scanning ${urlsToFetch.length} establishments...` });
    const pageCacheDir = join(opts.outputDir, 'cache', 'pages');
    let pagesFetched = 0, pagesFromCache = 0, fetchErrors = 0;
    const allResults = [];

    for (let i = 0; i < urlsToFetch.length; i++) {
      if (state.aborted) { emit({ type: 'aborted', message: 'Stopped by user' }); state.running = false; return; }
      const { record, urls, phoneNorm, hasAddressSource } = urlsToFetch[i];

      const fetchResults = await fetchUrls(urls, {
        cacheDir: pageCacheDir, delay: opts.fetchDelay, noCache: opts.noCache,
      });

      pagesFetched += fetchResults.filter((fr) => !fr.fromCache && !fr.error).length;
      pagesFromCache += fetchResults.filter((fr) => fr.fromCache).length;
      fetchErrors += fetchResults.filter((fr) => fr.error).length;

      // For address-sourced URLs, pass null phoneNorm to skip phone dampener
      // For phone-sourced URLs, pass phoneNorm for phone dampener
      const phoneFetchResults = fetchResults.filter((fr) => !fr.source || fr.source !== 'address');
      const addrFetchResults = fetchResults.filter((fr) => fr.source === 'address');

      const phoneFlags = analyzeAll(phoneFetchResults, phoneNorm);
      const addrFlags = analyzeAll(addrFetchResults, null); // null = skip phone dampener
      const confirmedFlags = [...phoneFlags, ...addrFlags].sort((a, b) => b.score - a.score);

      if (opts.captureAds && confirmedFlags.length > 0) {
        const screenshotDir = join(opts.outputDir, 'screenshots');
        let index = 1;
        for (const flag of confirmedFlags) {
          emit({ type: 'deepscan_progress', current: i + 1, total: urlsToFetch.length, identifier: record.licensee.slice(0, 30), message: `Capturing screenshot for ${flag.domain}...` });
          console.log(`Capturing screenshot for ${flag.url}`);
          const safeDomain = (flag.domain || 'unknown').replace(/[^a-z0-9]/gi, '_');
          const safeLicense = record.licenseNumber ? record.licenseNumber.replace(/[^a-z0-9]/gi, '') : 'UNK';
          const filename = `${safeLicense}_${safeDomain}_${index}.png`;
          const shotPath = await takeScreenshot(flag.url, screenshotDir, filename);
          if (shotPath) {
            flag.screenshotPath = shotPath;
          }
          index++;
        }
      }

      allResults.push({ record, searchResult: urlsToFetch[i], confirmedFlags });

      emit({
        type: 'deepscan_progress', current: i + 1, total: urlsToFetch.length,
        identifier: record.licensee.slice(0, 30), licensee: record.licensee.slice(0, 40),
        urlsScanned: fetchResults.length, flagsFound: confirmedFlags.length,
        flags: confirmedFlags.slice(0, 3).map((f) => ({ url: f.url, domain: f.domain, reason: (f.flagReason || '').slice(0, 150), score: f.score, sourceType: f.sourceType })),
        pagesFetched, pagesFromCache, fetchErrors,
      });
    }

    emit({ type: 'phase_done', phase: 'deepscan', message: `Phase 3 complete: ${pagesFetched} pages fetched, ${pagesFromCache} cached, ${fetchErrors} errors` });
    console.log(`Phase 3 complete: ${pagesFetched} pages fetched, ${pagesFromCache} cached, ${fetchErrors} errors`);

    // ─── PHASE 4: SCORE & OUTPUT ─────────────────────────────────────────
    state.phase = 'output';
    emit({ type: 'phase', phase: 'output', message: '📊 Phase 4: Scoring and generating output...' });

    const riskTiers = { HIGH: 0, MEDIUM: 0, LOW: 0, NONE: 0 };
    const resultMap = new Map();
    for (const { record, confirmedFlags } of allResults) {
      resultMap.set(record.phoneNorm, confirmedFlags || []);
    }

    const finalResults = records.map((record) => {
      const flags = resultMap.get(record.phoneNorm) || [];
      const phoneData = phoneResults.get(record.phoneNorm);
      const totalSearchResults = phoneData ? phoneData.searchResult.totalResults : 0;
      const { riskScore, riskTier, riskLabel } = calculateRisk(flags, totalSearchResults);
      riskTiers[riskTier] = (riskTiers[riskTier] || 0) + 1;

      return {
        licenseNumber: record.licenseNumber, licensee: record.licensee,
        fullAddress: [record.address, record.address2].filter(Boolean).join(' '),
        city: record.city, state: record.state, zip: record.zip,
        phoneFormatted: record.phoneFormatted, phoneNorm: record.phoneNorm,
        riskScore, riskTier, riskLabel,
        totalSearchResults, sharedPhone: record.sharedPhone, allLicensees: record.allLicensees,
        confirmedFlags: flags.map((f) => ({
          url: f.url, domain: f.domain, flagReason: f.flagReason,
          score: f.score, excerpt: f.excerpt, sourceType: f.sourceType,
          screenshotPath: f.screenshotPath || null
        })),
        searchError: phoneData?.searchResult.error || null,
        processedAt: new Date().toISOString(),
      };
    });

    const runtimeStats = {
      totalRows: ingestStats.totalRows, filteredByStatus: ingestStats.filteredByStatus,
      invalidPhone: ingestStats.invalidPhone, duplicatePhone: ingestStats.duplicatePhone,
      validRecords: ingestStats.validRecords, apiCalls, cachedSearches, pagesFetched,
      addressSearches: addrApiCalls, addressCached: addrCached,
    };

    const csvResult = await writeCSV(finalResults, opts.outputDir);
    const jsonResult = writeJSON(finalResults, opts.outputDir);
    const summaryResult = writeSummary(finalResults, runtimeStats, opts.outputDir);

    state.phase = 'done';
    const flaggedCount = finalResults.filter((r) => r.confirmedFlags.length > 0).length;
    emit({
      type: 'complete', riskTiers,
      stats: {
        apiCalls, cachedSearches, pagesFetched, pagesFromCache, searchErrors, fetchErrors,
        addressSearches: addrApiCalls, addressCached: addrCached,
        totalResults: finalResults.length, flaggedCount,
      },
      outputs: { csv: csvResult.path, json: jsonResult.path, summary: summaryResult.path, csvRows: csvResult.rowCount, maxFlags: csvResult.maxFlags },
      topFlagged: finalResults.filter((r) => r.riskTier === 'HIGH').sort((a, b) => b.riskScore - a.riskScore).slice(0, 10)
        .map((r) => ({ licensee: r.licensee, phone: r.phoneFormatted, riskScore: r.riskScore, flagCount: r.confirmedFlags.length, topFlag: r.confirmedFlags[0]?.url || null })),
      elapsed: Date.now() - state.startedAt,
      message: `Pipeline complete. ${flaggedCount} of ${finalResults.length} establishments flagged.`,
    });
    console.log(`Pipeline complete. ${flaggedCount} of ${finalResults.length} flagged. Output: ${opts.outputDir}`);
  } catch (err) {
    state.phase = 'error';
    emit({ type: 'error', message: err.message });
    console.error('Pipeline error:', err);
  } finally {
    state.running = false;
    state.aborted = false;
  }
}

// JSON error handler: avoid leaking stack traces via Express's default HTML page.
app.use((err, _req, res, _next) => {
  console.error('Request error:', err.message);
  res.status(err.status || 400).json({ error: err.message || 'Bad request' });
});

// ─── Start Server ────────────────────────────────────────────────────────────

const PORT = process.env.PORT || 3456;
app.listen(PORT, '127.0.0.1', () => {
  console.log(`\n  SerpDerp Dashboard → http://127.0.0.1:${PORT}/?t=${AUTH_TOKEN}\n`);
  console.log('  (Bound to loopback only. Token rotates on every server restart.)\n');
});
