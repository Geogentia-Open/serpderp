/**
 * SerpDerp — Output Generator
 * Writes results to CSV, JSON, and summary text.
 * CSV includes all establishments, with repeating URL/FlagReason columns for flagged ones.
 */

import { createObjectCsvWriter } from 'csv-writer';
import { writeFileSync, mkdirSync } from 'fs';
import path from 'path';

/**
 * Sanitize text to remove UTF-8/Windows-1252 encoding artifacts.
 * Strips mojibake like â€", â€™, Ã©, etc. and any non-ASCII garbage.
 */
function sanitizeText(str) {
  if (!str || typeof str !== 'string') return str || '';
  return str
    // Mojibake: UTF-8 bytes misread as Windows-1252
    .replace(/\u00e2\u0080\u0093/g, '-')       // â€" → -
    .replace(/\u00e2\u0080\u0094/g, '-')       // â€" → -
    .replace(/\u00e2\u0080\u0099/g, "'")       // â€™ → '
    .replace(/\u00e2\u0080\u009c/g, '"')       // â€œ → "
    .replace(/\u00e2\u0080\u009d/g, '"')       // â€ → "
    .replace(/\u00e2\u0080\u00a6/g, '...')     // â€¦ → ...
    .replace(/\u00c3\u00a9/g, 'e')             // Ã© → e
    .replace(/\u00c3\u00b1/g, 'n')             // Ã± → n
    // Literal mojibake strings
    .replace(/â€"/g, '-')
    .replace(/â€™/g, "'")
    .replace(/â€œ/g, '"')
    .replace(/â€\u009d/g, '"')
    .replace(/â€¦/g, '...')
    .replace(/Ã©/g, 'e')
    .replace(/Ã±/g, 'n')
    .replace(/Ã¡/g, 'a')
    .replace(/Ã³/g, 'o')
    .replace(/Ã¼/g, 'u')
    // Smart quotes/dashes → plain ASCII
    .replace(/[\u2018\u2019\u201A]/g, "'")
    .replace(/[\u201C\u201D\u201E]/g, '"')
    .replace(/[\u2013\u2014]/g, '-')
    .replace(/\u2026/g, '...')
    .replace(/\u00A0/g, ' ')                   // non-breaking space
    // Strip control chars and remaining non-ASCII that would corrupt CSV
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, '')
    // Collapse excess whitespace
    .replace(/\s{2,}/g, ' ')
    .trim();
}

/**
 * Produce a clean, short flag reason for CSV output.
 * Instead of dumping raw pattern matches, creates a concise human-readable label.
 * e.g. "Rubmaps listing" or "Escort ad terms found" or "Review site match"
 */
function cleanFlagReason(flagReason, domain) {
  if (!flagReason) return '';

  // Build a short summary from the flag categories present
  const parts = flagReason.split(' | ');
  const labels = [];

  for (const part of parts) {
    if (/rubmaps/i.test(part)) {
      labels.push('Rubmaps listing');
    } else if (/explicit.services/i.test(part)) {
      labels.push('Explicit services advertised');
    } else if (/escort.*terminology/i.test(part)) {
      labels.push('Escort terminology');
    } else if (/pricing/i.test(part)) {
      labels.push('Service pricing found');
    } else if (/review.*illicit/i.test(part)) {
      labels.push('Illicit service review');
    } else if (/known.*(?:escort|review)/i.test(part)) {
      labels.push('Known review site');
    } else if (/age.*appearance/i.test(part)) {
      labels.push('Age/appearance marketing');
    } else if (/trafficking/i.test(part)) {
      labels.push('Trafficking indicators');
    } else if (/phone.*confirmed/i.test(part)) {
      labels.push('Phone confirmed on page');
    }
  }

  if (labels.length === 0) {
    // Fallback: take first 80 chars of raw reason
    return sanitizeText(flagReason).slice(0, 80);
  }

  let result = labels.join('; ');
  if (domain) result += ` (${domain})`;
  return result;
}

/**
 * Determine the max number of URL/FlagReason pairs across all results
 */
function getMaxFlags(results) {
  let max = 0;
  for (const r of results) {
    if (r.confirmedFlags && r.confirmedFlags.length > max) {
      max = r.confirmedFlags.length;
    }
  }
  return Math.min(max, 10); // Cap at 10 pairs
}

/**
 * Write the results CSV with repeating URL/FlagReason columns
 * Every establishment gets a row, even if no results found.
 */
export async function writeCSV(results, outputDir) {
  mkdirSync(outputDir, { recursive: true });
  const csvPath = path.join(outputDir, 'results.csv');
  const maxFlags = getMaxFlags(results);

  // Build CSV headers
  const headers = [
    { id: 'licenseNumber', title: 'License Number' },
    { id: 'licensee', title: 'Licensee' },
    { id: 'address', title: 'Address' },
    { id: 'city', title: 'City' },
    { id: 'state', title: 'State' },
    { id: 'zip', title: 'Zip' },
    { id: 'phone', title: 'Phone' },
    { id: 'riskScore', title: 'Risk Score' },
    { id: 'riskTier', title: 'Risk Tier' },
    { id: 'riskLabel', title: 'Risk Detail' },
    { id: 'totalSearchResults', title: 'Total Search Results' },
    { id: 'confirmedFlagCount', title: 'Confirmed Flags' },
  ];

  // Add repeating URL/FlagReason/Score triples
  // Add repeating URL/FlagReason/Score/Screenshot columns
  for (let i = 1; i <= maxFlags; i++) {
    headers.push({ id: `url_${i}`, title: `URL_${i}` });
    headers.push({ id: `flag_reason_${i}`, title: `Flag_Reason_${i}` });
    headers.push({ id: `flag_score_${i}`, title: `Flag_Score_${i}` });
    headers.push({ id: `screenshot_${i}`, title: `Screenshot_${i}` });
  }

  // Build rows
  const rows = results.map((r) => {
    const row = {
      licenseNumber: sanitizeText(r.licenseNumber),
      licensee: sanitizeText(r.licensee),
      address: sanitizeText(r.fullAddress),
      city: sanitizeText(r.city),
      state: sanitizeText(r.state),
      zip: sanitizeText(r.zip),
      phone: sanitizeText(r.phoneFormatted),
      riskScore: r.riskScore,
      riskTier: r.riskTier,
      riskLabel: sanitizeText(r.riskLabel),
      totalSearchResults: r.totalSearchResults,
      confirmedFlagCount: r.confirmedFlags ? r.confirmedFlags.length : 0,
    };

    // Add URL/FlagReason/Score triples
    // Add URL/FlagReason/Score/Screenshot triples
    if (r.confirmedFlags) {
      for (let i = 0; i < maxFlags; i++) {
        const flag = r.confirmedFlags[i];
        row[`url_${i + 1}`] = flag ? flag.url : '';
        row[`flag_reason_${i + 1}`] = flag ? cleanFlagReason(flag.flagReason, flag.domain) : '';
        row[`flag_score_${i + 1}`] = flag ? flag.score : '';
        row[`screenshot_${i + 1}`] = flag ? (flag.screenshotPath || '') : '';
      }
    } else {
      for (let i = 0; i < maxFlags; i++) {
        row[`url_${i + 1}`] = '';
        row[`flag_reason_${i + 1}`] = '';
        row[`flag_score_${i + 1}`] = '';
        row[`screenshot_${i + 1}`] = '';
      }
    }

    return row;
  });

  // Sort: HIGH first, then MEDIUM, LOW, NONE
  const tierOrder = { HIGH: 0, MEDIUM: 1, LOW: 2, NONE: 3 };
  rows.sort((a, b) => {
    const tierDiff = (tierOrder[a.riskTier] ?? 4) - (tierOrder[b.riskTier] ?? 4);
    if (tierDiff !== 0) return tierDiff;
    return (b.riskScore || 0) - (a.riskScore || 0);
  });

  const csvWriter = createObjectCsvWriter({ path: csvPath, header: headers });
  await csvWriter.writeRecords(rows);

  return { path: csvPath, rowCount: rows.length, maxFlags };
}

/**
 * Write full JSON output
 */
export function writeJSON(results, outputDir) {
  mkdirSync(outputDir, { recursive: true });
  const jsonPath = path.join(outputDir, 'results.json');

  const output = results.map((r) => ({
    licenseNumber: r.licenseNumber,
    licensee: r.licensee,
    address: r.fullAddress,
    city: r.city,
    state: r.state,
    zip: r.zip,
    phone: r.phoneFormatted,
    phoneNorm: r.phoneNorm,
    riskScore: r.riskScore,
    riskTier: r.riskTier,
    riskLabel: r.riskLabel,
    totalSearchResults: r.totalSearchResults,
    sharedPhone: r.sharedPhone,
    allLicensees: r.allLicensees,
    confirmedFlags: r.confirmedFlags || [],
    searchError: r.searchError || null,
    processedAt: r.processedAt,
  }));

  writeFileSync(jsonPath, JSON.stringify(output, null, 2));
  return { path: jsonPath };
}

/**
 * Write executive summary
 */
export function writeSummary(results, stats, outputDir) {
  mkdirSync(outputDir, { recursive: true });
  const summaryPath = path.join(outputDir, 'summary.txt');

  const tiers = { HIGH: 0, MEDIUM: 0, LOW: 0, NONE: 0 };
  let totalFlags = 0;

  for (const r of results) {
    tiers[r.riskTier] = (tiers[r.riskTier] || 0) + 1;
    totalFlags += (r.confirmedFlags || []).length;
  }

  const total = results.length;
  const pct = (n) => total > 0 ? ((n / total) * 100).toFixed(1) : '0.0';

  const lines = [
    `SerpDerp CTI-Ad Triage Report`,
    `Generated: ${new Date().toISOString()}`,
    `${'='.repeat(50)}`,
    ``,
    `Input Statistics:`,
    `  Total CSV rows:            ${stats.totalRows}`,
    `  Filtered by status:        ${stats.filteredByStatus}`,
    `  Invalid phone numbers:     ${stats.invalidPhone}`,
    `  Duplicate phone numbers:   ${stats.duplicatePhone}`,
    `  Establishments searched:   ${stats.validRecords}`,
    ``,
    `Risk Distribution:`,
    `  🔴 HIGH risk:    ${tiers.HIGH} (${pct(tiers.HIGH)}%)`,
    `  🟡 MEDIUM risk:  ${tiers.MEDIUM} (${pct(tiers.MEDIUM)}%)`,
    `  🟢 LOW risk:     ${tiers.LOW} (${pct(tiers.LOW)}%)`,
    `  ⚪ NONE:         ${tiers.NONE} (${pct(tiers.NONE)}%)`,
    ``,
    `Confirmed illicit URLs:      ${totalFlags}`,
    `API calls (search):          ${stats.apiCalls || 0}`,
    `Cached searches:             ${stats.cachedSearches || 0}`,
    `Pages fetched (deep scan):   ${stats.pagesFetched || 0}`,
    ``,
    `${'='.repeat(50)}`,
    ``,
  ];

  // Top flagged establishments
  const flagged = results
    .filter((r) => r.riskTier === 'HIGH')
    .sort((a, b) => b.riskScore - a.riskScore)
    .slice(0, 20);

  if (flagged.length > 0) {
    lines.push(`Top HIGH-risk establishments:`);
    lines.push(`${'─'.repeat(50)}`);
    for (const r of flagged) {
      lines.push(`  [${r.riskScore}] ${r.licensee}`);
      lines.push(`       ${r.phoneFormatted} | ${r.fullAddress}`);
      if (r.confirmedFlags) {
        for (const f of r.confirmedFlags.slice(0, 3)) {
          lines.push(`       → ${f.url}`);
          lines.push(`         ${f.flagReason.slice(0, 100)}`);
        }
      }
      lines.push('');
    }
  }

  writeFileSync(summaryPath, lines.join('\n'));
  return { path: summaryPath };
}
