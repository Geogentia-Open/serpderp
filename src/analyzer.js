/**
 * SerpDerp — Content Analyzer & Risk Scorer
 * Analyzes fetched page text to confirm illicit service indicators.
 * Returns flag reasons and risk scores.
 */

import { getSourceType } from './fetcher.js';

// Source-type score multipliers
const SOURCE_MULTIPLIERS = { direct_ad: 1.5, review_site: 1.0, aggregator: 0.5, unknown: 1.0 };

// ─── Detection Patterns ──────────────────────────────────────────────────────

/**
 * Each pattern group has a category, weight, regex patterns, and label template.
 * Patterns are applied against the full extracted text of each URL.
 */
const DETECTION_PATTERNS = [
  {
    category: 'explicit_services',
    weight: 25,
    label: 'Explicit services advertised',
    patterns: [
      /\b(?:full\s*service|happy\s*ending|hand\s*job|blow\s*job)\b/gi,
      /\b(?:BBBJ|BBFS|BBBJnqns|BBBJTC|CIM|COB|COF|CIF)\b/g, // Common review abbreviations
      /\b(?:GFE|PSE|MSOG|DATY|DFK|TUMA)\b/g, // "Girlfriend experience", etc.
      /\b(?:extras|extra\s*services|special\s*services)\b/gi,
      /\bFS\b(?!\s*(?:GB|TB|MB|KB|port|filesystem|type))/g, // "FS" but not file system terms
      /\b(?:HE|HJ)\b(?=\s|,|\.|$)/g, // Happy ending / hand job abbreviations
      /\b(?:nuru\s*massage|body\s*to\s*body|b2b\s*massage)\b/gi,
      /\b(?:sensual\s*release|release\s*massage|tantric\s*massage)\b/gi,
    ],
  },
  {
    category: 'escort_terminology',
    weight: 20,
    label: 'Uses escort/trafficking terminology',
    patterns: [
      /\b(?:incall|in-call|outcall|out-call)\b/gi,
      /\b(?:hosting\s*now|available\s*now|ready\s*now)\b/gi,
      /\b(?:companionship|intimate\s*encounter|discrete|discreet\s*service)\b/gi,
      /\b(?:body\s*rub|sensual\s*massage|asian\s*massage)\b/gi,
      /\b(?:no\s*rush|no\s*clock|upscale\s*gentlemen)\b/gi,
      /\b(?:donation|roses|generous|tribute)\b/gi, // Payment euphemisms
      /\b(?:new\s*(?:in|to)\s*town|just\s*arrived|passing\s*through)\b/gi,
      /\bvisiting\s+(?:your|the|this)\s*(?:city|town|area)\b/gi, // "visiting" alone is too broad
    ],
  },
  {
    category: 'pricing_ads',
    weight: 15,
    label: 'Service ad with pricing/availability',
    patterns: [
      /\$\s*\d{2,3}\s*(?:\/|per)?\s*(?:hr|hour|hhr|half|30\s*min|15\s*min)/gi,
      /\b(?:rates?|pricing|specials?)\s*[:.]?\s*\$\d{2,}/gi,
      /\b(?:qv|quickie|quick\s*visit)\s*[:.]?\s*\$?\d{2,}/gi,
      /\b(?:half\s*hour|full\s*hour|hhr?|1hr?)\s*[:.]?\s*\$\d{2,}/gi,
      /\bcall\s*(?:me|now|today)\s*(?:at|for)?\s*\(?\d{3}\)?[\s-]?\d{3}[\s-]?\d{4}/gi,
    ],
  },
  {
    category: 'review_content',
    weight: 20,
    label: 'Review confirming illicit services',
    patterns: [
      /\b(?:review\s*of|visited\s*on|session\s*with|saw\s*her)\b/gi,
      /\b(?:highly\s*recommend|would\s*repeat|will\s*return|great\s*service)\b/gi,
      /\b(?:the\s*girl|the\s*lady|provider|she\s*was)\b.*\b(?:service|offered|provided)\b/gi,
      /\b(?:door\s*fee|house\s*fee|room\s*fee|tip)\s*[:.]?\s*\$?\d{2,}/gi,
      /\b(?:mamasan|mama-san|manager)\b.*\b(?:girl|room|service)\b/gi,
      /\b(?:lineup|line-up|choose|picked)\b.*\b(?:girl|provider|lady)\b/gi,
    ],
  },
  {
    category: 'rubmaps_specific',
    weight: 30,
    label: 'Listed on Rubmaps (massage parlor review site)',
    patterns: [
      /rubmaps/gi,
      /\brush\s*maps\b/gi,
    ],
  },
  {
    category: 'known_review_site',
    weight: 15,
    label: 'Present on known escort/review site',
    patterns: [
      /\b(?:eccie|usasexguide|eroticmonkey|tnaboard|erotic\s*review)\b/gi,
      /\b(?:escortbabylon|listcrawler|skipthegames|megapersonals)\b/gi,
      /\b(?:adultsearch|bedpage|backpage|cityxguide)\b/gi,
    ],
  },
  {
    category: 'age_appearance',
    weight: 15,
    label: 'Age/appearance marketing',
    patterns: [
      /\b(?:young|petite|tiny|spinner)\b.*\b(?:girl|asian|latina|blonde)\b/gi,
      /\bage\s*[:.]?\s*(?:1[89]|2[0-9])\b/gi,
      /\b(?:exotic|foreign|import)\b.*\b(?:beauty|girl|woman|babe)\b/gi,
      /\b(?:fresh\s*face|new\s*girl|brand\s*new)\b/gi,
    ],
  },
  {
    category: 'trafficking_indicators',
    weight: 25,
    label: 'Potential trafficking indicators',
    patterns: [
      /\b(?:new\s*girls?\s*(?:every|each)\s*(?:week|day|month))\b/gi, // High turnover
      /\b(?:multiple\s*girls?|variety\s*of\s*girls?|selection\s*of)\b/gi,
      /\b(?:open\s*(?:late|24|all\s*night)|24\s*(?:\/|-)?\s*7)\b/gi, // Unusual hours
      /\b(?:come\s*(?:in|see)\s*(?:us|our|the)\s*girls?)\b/gi,
      /\b(?:walk[\s-]?ins?\s*welcome|no\s*appointment)\b/gi,
    ],
  },
];

// ─── Analyzer ────────────────────────────────────────────────────────────────

/**
 * Analyze a single URL's text content for illicit indicators
 * @param {object} fetchResult - From fetcher module
 * @param {string} phoneNorm - The establishment phone number for context
 * @returns {object} Analysis result with flags and score
 */
export function analyzeContent(fetchResult, phoneNorm) {
  const { url, text, domain, serpSnippet = '', serpTitle = '' } = fetchResult;

  // Combine page text + SerpApi snippet for analysis
  const fullText = `${serpTitle}\n${serpSnippet}\n${text}`;

  if (!fullText.trim()) {
    return {
      url,
      domain,
      confirmed: false,
      flags: [],
      score: 0,
      flagReason: null,
      excerpt: null,
    };
  }

  const flags = [];
  let totalScore = 0;

  for (const patternGroup of DETECTION_PATTERNS) {
    const matchedTerms = [];

    for (const regex of patternGroup.patterns) {
      // Reset regex state
      regex.lastIndex = 0;
      const matches = fullText.match(regex);
      if (matches) {
        // Deduplicate matches (case-insensitive)
        const unique = [...new Set(matches.map((m) => m.toLowerCase().trim()))];
        matchedTerms.push(...unique);
      }
    }

    if (matchedTerms.length > 0) {
      const dedupedTerms = [...new Set(matchedTerms)].slice(0, 5); // Max 5 examples
      flags.push({
        category: patternGroup.category,
        weight: patternGroup.weight,
        label: patternGroup.label,
        matchedTerms: dedupedTerms,
      });
      totalScore += patternGroup.weight;
    }
  }

  // Check if the phone number itself appears on the page (confirms association)
  // Skip entirely when phoneNorm is null (address search mode — phone is irrelevant)
  if (phoneNorm) {
    const phoneOnPage = text.includes(phoneNorm);
    if (phoneOnPage) {
      flags.push({
        category: 'phone_confirmed',
        weight: 10,
        label: 'Establishment phone number found on page',
        matchedTerms: [phoneNorm],
      });
      totalScore += 10;
    } else if (flags.length > 0) {
      // DAMPENER: Phone NOT on page → match is circumstantial.
      // Google may have associated the URL with this phone via co-occurrence
      // in a regional listing, not because the business is actually listed there.
      // Reduce score to 30% of raw value when phone is absent.
      totalScore = Math.round(totalScore * 0.3);
    }
  }

  // Apply source-type multiplier
  const sourceType = getSourceType(url);
  const multiplier = SOURCE_MULTIPLIERS[sourceType] || 1.0;
  totalScore = Math.round(totalScore * multiplier);

  // Cap score at 100
  totalScore = Math.min(totalScore, 100);

  // Build human-readable flag reason
  const flagReason = flags.length > 0
    ? flags.map((f) => `${f.label}: ${f.matchedTerms.join(', ')}`).join(' | ')
    : null;

  // Extract the most relevant excerpt (first passage containing a matched term)
  let excerpt = null;
  if (flags.length > 0 && text) {
    const firstTerm = flags[0].matchedTerms[0];
    const idx = text.toLowerCase().indexOf(firstTerm.toLowerCase());
    if (idx !== -1) {
      const start = Math.max(0, idx - 80);
      const end = Math.min(text.length, idx + firstTerm.length + 120);
      excerpt = (start > 0 ? '...' : '') + text.slice(start, end).trim() + (end < text.length ? '...' : '');
    }
  }

  return {
    url,
    domain,
    confirmed: flags.length > 0,
    flags,
    score: totalScore,
    sourceType,
    flagReason,
    excerpt,
  };
}

/**
 * Analyze all fetched URLs for one establishment
 * Returns aggregated results sorted by score
 */
export function analyzeAll(fetchResults, phoneNorm) {
  const analyses = fetchResults
    .map((fr) => analyzeContent(fr, phoneNorm))
    .filter((a) => a.confirmed)
    .sort((a, b) => b.score - a.score);

  return analyses;
}

/**
 * Calculate the overall risk score for an establishment
 * @param {Array} confirmedAnalyses - Confirmed URL analyses
 * @param {number} serpTotalResults - Total SerpApi search results
 * @returns {{riskScore: number, riskTier: string}}
 */
export function calculateRisk(confirmedAnalyses, serpTotalResults) {
  if (confirmedAnalyses.length === 0 && serpTotalResults === 0) {
    return { riskScore: 0, riskTier: 'NONE', riskLabel: 'No results found' };
  }

  if (confirmedAnalyses.length === 0 && serpTotalResults > 0) {
    return { riskScore: 5, riskTier: 'LOW', riskLabel: 'Search hits but content unconfirmed' };
  }

  // Use the SUM of per-URL dampened scores as the base.
  // This respects the phone-absence dampener from analyzeContent().
  // A rubmaps age-gate with no phone → score 9 per URL, not 20+15=35.
  let score = 0;
  for (const a of confirmedAnalyses) {
    score += a.score;
  }

  // Bonus: phone-confirmed URLs get extra weight for corroborating categories
  const phoneConfirmed = confirmedAnalyses.some((a) =>
    a.flags.some((f) => f.category === 'phone_confirmed')
  );

  if (phoneConfirmed) {
    // Only add category bonuses when the phone is actually on the page
    const hasRubmaps = confirmedAnalyses.some((a) =>
      a.flags.some((f) => f.category === 'rubmaps_specific')
    );
    if (hasRubmaps) score += 15;

    const hasReviewSite = confirmedAnalyses.some((a) =>
      a.flags.some((f) => f.category === 'known_review_site')
    );
    if (hasReviewSite) score += 10;

    const hasExplicit = confirmedAnalyses.some((a) =>
      a.flags.some((f) => f.category === 'explicit_services')
    );
    if (hasExplicit) score += 10;

    const hasTrafficking = confirmedAnalyses.some((a) =>
      a.flags.some((f) => f.category === 'trafficking_indicators')
    );
    if (hasTrafficking) score += 15;
  }

  // Cap at 100
  score = Math.min(score, 100);

  let riskTier, riskLabel;
  if (score >= 60) {
    riskTier = 'HIGH';
    riskLabel = 'Strong trafficking indicators — prioritize investigation';
  } else if (score >= 30) {
    riskTier = 'MEDIUM';
    riskLabel = 'Moderate indicators — warrants review';
  } else {
    riskTier = 'LOW';
    riskLabel = 'Weak/ambiguous signals';
  }

  return { riskScore: score, riskTier, riskLabel };
}

export { DETECTION_PATTERNS };

/**
 * Quick-classify an establishment from search results alone (no deep scan).
 * Used to decide if address search is needed.
 * @param {object} searchResult - From searcher module
 * @returns {'NONE' | 'LOW' | 'PRELIMINARY_HIT'}
 */
export function quickClassify(searchResult) {
  if (searchResult.error || searchResult.totalResults === 0) return 'NONE';
  for (const r of searchResult.organicResults) {
    const st = getSourceType(r.link);
    if (st === 'direct_ad' || st === 'review_site') return 'PRELIMINARY_HIT';
  }
  return 'LOW';
}
