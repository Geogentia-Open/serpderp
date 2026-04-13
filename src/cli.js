#!/usr/bin/env node
/**
 * SerpDerp — CLI Runner
 * CTI-Ad Triage Tool entry point.
 *
 * Usage:
 *   node src/cli.js --csv "path/to/file.csv" [options]
 *
 * Options:
 *   --csv <path>        Path to input CSV (required)
 *   --limit <n>         Max phone numbers to search (0 = all, default: 0)
 *   --delay <ms>        Milliseconds between SerpApi calls (default: 1500)
 *   --fetch-delay <ms>  Milliseconds between page fetches (default: 500)
 *   --output <dir>      Output directory (default: ./output)
 *   --no-cache          Bypass all caches
 *   --search-only       Run Phase 1 only (skip deep scan)
 *   --dry-run           Parse CSV + show stats, no API calls
 */

import 'dotenv/config';
import { resolve, join } from 'path';
import { existsSync } from 'fs';
import { ingestCSV } from './ingest.js';
import { bulkSearch } from './searcher.js';
import { fetchUrls } from './fetcher.js';
import { analyzeAll, calculateRisk } from './analyzer.js';
import { writeCSV, writeJSON, writeSummary } from './output.js';

// ─── Arg Parsing ─────────────────────────────────────────────────────────────

function parseArgs(argv) {
  const args = {
    csv: null,
    limit: 0,
    delay: 1500,
    fetchDelay: 500,
    output: './output',
    noCache: false,
    searchOnly: false,
    dryRun: false,
  };

  for (let i = 2; i < argv.length; i++) {
    switch (argv[i]) {
      case '--csv':
        args.csv = argv[++i];
        break;
      case '--limit':
        args.limit = parseInt(argv[++i], 10) || 0;
        break;
      case '--delay':
        args.delay = parseInt(argv[++i], 10) || 1500;
        break;
      case '--fetch-delay':
        args.fetchDelay = parseInt(argv[++i], 10) || 500;
        break;
      case '--output':
        args.output = argv[++i];
        break;
      case '--no-cache':
        args.noCache = true;
        break;
      case '--search-only':
        args.searchOnly = true;
        break;
      case '--dry-run':
        args.dryRun = true;
        break;
      default:
        if (argv[i].startsWith('--')) {
          console.warn(`Unknown option: ${argv[i]}`);
        }
    }
  }

  return args;
}

// ─── Banner ──────────────────────────────────────────────────────────────────

function printBanner() {
  console.log(`
╔═══════════════════════════════════════════════════╗
║     SerpDerp  —  CTI-Ad Triage Tool  v1.0        ║
║     Massage Establishment Indicator Search        ║
╚═══════════════════════════════════════════════════╝
`);
}

// ─── Main ────────────────────────────────────────────────────────────────────

async function main() {
  printBanner();

  const args = parseArgs(process.argv);

  // Validate required args
  if (!args.csv) {
    console.error('❌ Missing required --csv argument');
    console.error('Usage: node src/cli.js --csv "path/to/file.csv" [options]');
    process.exit(1);
  }

  const csvPath = resolve(args.csv);
  if (!existsSync(csvPath)) {
    console.error(`❌ CSV file not found: ${csvPath}`);
    process.exit(1);
  }

  // Validate API key (unless dry-run)
  const apiKey = process.env.SERPAPI_KEY;
  if (!args.dryRun && !apiKey) {
    console.error('❌ SERPAPI_KEY environment variable is not set');
    console.error('   Create a .env file with: SERPAPI_KEY=your_key_here');
    process.exit(1);
  }

  const outputDir = resolve(args.output);
  const searchCacheDir = join(outputDir, 'cache', 'search');
  const pageCacheDir = join(outputDir, 'cache', 'pages');

  // ── Phase 0: Ingest CSV ──────────────────────────────────────────────────

  console.log(`📄 Loading CSV: ${csvPath}`);
  const { records, stats } = await ingestCSV(csvPath, { currentOnly: true });

  console.log(`   Total rows:          ${stats.totalRows}`);
  console.log(`   Filtered (non-CURRENT): ${stats.filteredByStatus}`);
  console.log(`   Invalid phones:      ${stats.invalidPhone}`);
  console.log(`   Duplicate phones:    ${stats.duplicatePhone}`);
  console.log(`   Ready to search:     ${stats.validRecords}`);

  if (args.limit > 0) {
    console.log(`   ⚡ Limit applied:     ${args.limit}`);
  }
  console.log('');

  if (args.dryRun) {
    console.log('🏁 Dry run complete — no API calls made.');
    console.log(`   Would search ${args.limit > 0 ? Math.min(args.limit, stats.validRecords) : stats.validRecords} phone numbers.`);

    // Show first 5 as sample
    console.log('\n   Sample records:');
    for (const rec of records.slice(0, 5)) {
      console.log(`     ${rec.phoneFormatted}  ${rec.licensee}  (${rec.city}, ${rec.state})`);
    }
    return;
  }

  // ── Phase 1: SerpApi Discovery ───────────────────────────────────────────

  console.log('━'.repeat(50));
  console.log('Phase 1: SerpApi Discovery');
  console.log('━'.repeat(50));

  const allResults = [];
  let apiCalls = 0;
  let cachedSearches = 0;

  for await (const { record, searchResult } of bulkSearch(records, {
    apiKey,
    cacheDir: searchCacheDir,
    delay: args.delay,
    noCache: args.noCache,
    limit: args.limit,
  })) {
    if (searchResult.fromCache) cachedSearches++;
    else apiCalls++;

    allResults.push({ record, searchResult });
  }

  // ── Phase 2: Deep Content Scan ───────────────────────────────────────────

  let pagesFetched = 0;

  if (!args.searchOnly) {
    const urlsToFetch = allResults.filter(
      (r) => r.searchResult.organicResults.length > 0
    );

    if (urlsToFetch.length > 0) {
      console.log('');
      console.log('━'.repeat(50));
      console.log(`Phase 2: Deep Content Scan (${urlsToFetch.length} establishments with results)`);
      console.log('━'.repeat(50));

      for (let i = 0; i < urlsToFetch.length; i++) {
        const { record, searchResult } = urlsToFetch[i];
        console.log(
          `\n[${i + 1}/${urlsToFetch.length}] ${record.phoneFormatted} (${record.licensee.slice(0, 30)})`
        );

        // Fetch each URL
        const fetchResults = await fetchUrls(searchResult.organicResults, {
          cacheDir: pageCacheDir,
          noCache: args.noCache,
          fetchDelay: args.fetchDelay,
        });

        pagesFetched += fetchResults.filter((fr) => !fr.fromCache && !fr.error).length;

        // Analyze content
        const confirmedFlags = analyzeAll(fetchResults, record.phoneNorm);

        // Store results
        urlsToFetch[i].confirmedFlags = confirmedFlags;

        // Progress output
        for (const flag of confirmedFlags) {
          console.log(`  ✅ FLAGGED: ${flag.url}`);
          console.log(`     ${flag.flagReason.slice(0, 120)}`);
        }
        if (confirmedFlags.length === 0) {
          console.log(`  ❌ No illicit content confirmed in ${fetchResults.length} pages`);
        }
      }
    }
  }

  // ── Scoring & Output ─────────────────────────────────────────────────────

  console.log('');
  console.log('━'.repeat(50));
  console.log('Generating output...');
  console.log('━'.repeat(50));

  const finalResults = allResults.map(({ record, searchResult, confirmedFlags }) => {
    const flags = confirmedFlags || [];
    const { riskScore, riskTier, riskLabel } = calculateRisk(
      flags,
      searchResult.totalResults
    );

    return {
      licenseNumber: record.licenseNumber,
      licensee: record.licensee,
      fullAddress: [record.address, record.address2].filter(Boolean).join(' '),
      city: record.city,
      state: record.state,
      zip: record.zip,
      phoneFormatted: record.phoneFormatted,
      phoneNorm: record.phoneNorm,
      riskScore,
      riskTier,
      riskLabel,
      totalSearchResults: searchResult.totalResults,
      sharedPhone: record.sharedPhone,
      allLicensees: record.allLicensees,
      confirmedFlags: flags.map((f) => ({
        url: f.url,
        domain: f.domain,
        flagReason: f.flagReason,
        score: f.score,
        excerpt: f.excerpt,
      })),
      searchError: searchResult.error || null,
      processedAt: new Date().toISOString(),
    };
  });

  // Add runtime stats
  const runtimeStats = {
    ...stats,
    apiCalls,
    cachedSearches,
    pagesFetched,
  };

  // Write all outputs
  const csvResult = await writeCSV(finalResults, outputDir);
  const jsonResult = writeJSON(finalResults, outputDir);
  const summaryResult = writeSummary(finalResults, runtimeStats, outputDir);

  // ── Final Summary ────────────────────────────────────────────────────────

  const tiers = { HIGH: 0, MEDIUM: 0, LOW: 0, NONE: 0 };
  for (const r of finalResults) {
    tiers[r.riskTier] = (tiers[r.riskTier] || 0) + 1;
  }

  console.log('');
  console.log('╔═══════════════════════════════════════════════════╗');
  console.log('║                   RESULTS                        ║');
  console.log('╠═══════════════════════════════════════════════════╣');
  console.log(`║  ✅ ${csvResult.path}`);
  console.log(`║     ${csvResult.rowCount} rows, ${csvResult.maxFlags} URL/flag column pairs`);
  console.log(`║  ✅ ${jsonResult.path}`);
  console.log(`║  ✅ ${summaryResult.path}`);
  console.log('╠═══════════════════════════════════════════════════╣');
  console.log(`║  🔴 HIGH:   ${String(tiers.HIGH).padStart(5)}  (${((tiers.HIGH / finalResults.length) * 100).toFixed(1)}%)`);
  console.log(`║  🟡 MEDIUM: ${String(tiers.MEDIUM).padStart(5)}  (${((tiers.MEDIUM / finalResults.length) * 100).toFixed(1)}%)`);
  console.log(`║  🟢 LOW:    ${String(tiers.LOW).padStart(5)}  (${((tiers.LOW / finalResults.length) * 100).toFixed(1)}%)`);
  console.log(`║  ⚪ NONE:   ${String(tiers.NONE).padStart(5)}  (${((tiers.NONE / finalResults.length) * 100).toFixed(1)}%)`);
  console.log('╠═══════════════════════════════════════════════════╣');
  console.log(`║  API calls: ${apiCalls} searches + ${pagesFetched} page fetches`);
  console.log(`║  Cached:    ${cachedSearches} searches`);
  console.log('╚═══════════════════════════════════════════════════╝');
}

// Run
main().catch((err) => {
  console.error(`\n💥 Fatal error: ${err.message}`);
  console.error(err.stack);
  process.exit(1);
});
