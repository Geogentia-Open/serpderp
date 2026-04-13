/**
 * SerpDerp — CSV Ingestion Module
 * Parses massage establishment CSV, filters CURRENT licenses,
 * normalizes phone numbers, and deduplicates.
 */

import { createReadStream } from 'fs';
import csvParser from 'csv-parser';

/**
 * Normalize a phone string to 10-digit US format
 * "210-732-1588" → "2107321588"
 * Returns null if not a valid 10-digit US number
 */
export function normalizePhone(raw) {
  if (!raw) return null;
  const digits = raw.replace(/\D/g, '');
  // Handle 11-digit with leading 1
  if (digits.length === 11 && digits.startsWith('1')) {
    return digits.slice(1);
  }
  if (digits.length === 10) return digits;
  return null;
}

/**
 * Format a 10-digit phone for display: "210-732-1588"
 */
export function formatPhone(digits) {
  if (!digits || digits.length !== 10) return digits || '';
  return `${digits.slice(0, 3)}-${digits.slice(3, 6)}-${digits.slice(6)}`;
}

/**
 * Parse and ingest the CSV file
 * @param {string} csvPath - Path to the CSV file
 * @param {object} opts
 * @param {boolean} opts.currentOnly - Filter to CURRENT license status (default: true)
 * @returns {Promise<{records: Array, stats: object}>}
 */
export async function ingestCSV(csvPath, opts = {}) {
  const { currentOnly = true } = opts;

  return new Promise((resolve, reject) => {
    const records = [];
    const stats = {
      totalRows: 0,
      filteredByStatus: 0,
      invalidPhone: 0,
      duplicatePhone: 0,
      validRecords: 0,
    };
    const seenPhones = new Map(); // phone → array of licensees

    createReadStream(csvPath)
      .on('error', (err) => reject(new Error(`Cannot read CSV: ${err.message}`)))
      .pipe(csvParser())
      .on('data', (row) => {
        stats.totalRows++;

        // Filter by license status
        const status = (row['License Status'] || '').trim().toUpperCase();
        if (currentOnly && status && status !== 'CURRENT') {
          stats.filteredByStatus++;
          return;
        }

        // Normalize phone
        const phoneRaw = (row['Phone'] || '').trim();
        const phoneNorm = normalizePhone(phoneRaw);
        if (!phoneNorm) {
          stats.invalidPhone++;
          return;
        }

        // Build record
        const record = {
          licenseNumber: (row['License Number'] || '').trim(),
          licensee: (row['Licensee'] || '').trim(),
          address: (row['Address 1'] || row['Address'] || '').trim(),
          address2: (row['Address 2'] || '').trim(),
          city: (row['City'] || '').trim(),
          state: (row['State'] || '').trim(),
          county: (row['County'] || '').trim(),
          zip: (row['Zip'] || '').trim(),
          phoneRaw: phoneRaw,
          phoneNorm: phoneNorm,
          phoneFormatted: formatPhone(phoneNorm),
          licenseStatus: status,
          licenseExpiration: (row['License Expiration Date'] || '').trim(),
        };

        // Deduplicate by phone
        if (seenPhones.has(phoneNorm)) {
          stats.duplicatePhone++;
          // Track all licensees sharing this phone
          seenPhones.get(phoneNorm).push(record.licensee);
          return;
        }

        seenPhones.set(phoneNorm, [record.licensee]);
        records.push(record);
      })
      .on('end', () => {
        // Attach shared-phone info
        for (const rec of records) {
          const allLicensees = seenPhones.get(rec.phoneNorm);
          rec.sharedPhone = allLicensees.length > 1;
          rec.allLicensees = allLicensees;
        }
        stats.validRecords = records.length;
        resolve({ records, stats });
      })
      .on('error', (err) => reject(err));
  });
}
