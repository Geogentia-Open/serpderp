# SerpDerp

CTI-Ad triage tool for bulk phone-number and address searches against indicator domains used in commercial-sex trafficking advertising. Takes a CSV of licensed massage establishments, queries SerpApi for hits on known escort/review/ad platforms, fetches the resulting pages, scans the content, and produces a scored risk report.

Built for counter-trafficking analysts and licensing investigators. Runs locally — no data leaves your machine except the SerpApi search calls and the HTTP fetches to the flagged URLs.

## Quick start

```bash
npm install
npm run gui
```

Open the URL printed in the console (it includes a one-time auth token):

```
SerpDerp Dashboard → http://127.0.0.1:3456/?t=<random-token>
```

The token rotates on every server restart. The server binds to `127.0.0.1` only — nothing on your LAN can reach it.

## Requirements

- Node.js 18 or newer
- A [SerpApi](https://serpapi.com/) API key (free tier works for small runs)

## CSV format

The ingester expects these columns (case-sensitive headers):

**Required**
- `Phone` — any format; non-digits stripped, must produce 10 digits
- `License Status` — rows other than `CURRENT` are filtered out by default

**Recommended**
- `License Number`, `Licensee`, `Address 1`, `City`, `State`, `Zip`

**Optional**
- `Address 2`, `County`, `License Expiration Date`

Click **⬇ Download CSV template** in the dashboard for a ready-to-edit starter file, or see [src/template.csv](src/template.csv).

Rows with the same phone number are merged — the first row wins and subsequent licensees are attached as `allLicensees` + `sharedPhone: true`.

## Pipeline

The server runs a four-phase pipeline against the uploaded CSV:

1. **Phone search** — queries `"(phone)" ("girls" OR "escort" OR "rubmaps" OR "sex")` against Google via SerpApi
2. **Address search** — for any establishment that didn't hit on phone, queries by street address + city against the same keyword set (catches ads that list address but obfuscate phone)
3. **Deep scan** — fetches every non-skipped URL returned from phases 1 + 2, extracts visible text, runs keyword/phone/domain heuristics against it. Results are classified by source type: `direct_ad` (1.5× multiplier), `review_site` (1.0×), `aggregator` (0.5×)
4. **Score & output** — produces a CSV, a JSON, and a human-readable summary in the output directory, plus optional full-page screenshots for high-scoring flags

Results are tiered `HIGH / MEDIUM / LOW / NONE`. All phases cache to disk so re-running a file is cheap.

## Outputs

Written to `./output/` (configurable per run):

- `results-YYYYMMDD-HHmmss.csv` — wide-format spreadsheet with one row per establishment and one column pair per flag URL
- `results-YYYYMMDD-HHmmss.json` — full structured results with excerpts
- `summary-YYYYMMDD-HHmmss.txt` — human-readable top-line stats + a list of HIGH-tier hits
- `cache/search/`, `cache/search-addr/`, `cache/pages/` — disk caches (MD5 keyed) so re-runs don't re-hit SerpApi or re-fetch pages
- `screenshots/` — PNGs from Puppeteer, only if you enabled "Capture ads"

Click **📂 Open Output Folder** in the completion banner to jump directly to the run's output directory.

## CLI mode

For headless / scripted runs:

```bash
node src/cli.js --csv uploads/yourfile.csv [options]

Options:
  --csv <path>        Path to input CSV (required)
  --limit <n>         Max phone numbers to search (0 = all)
  --delay <ms>        Milliseconds between SerpApi calls (default 1500)
  --fetch-delay <ms>  Milliseconds between page fetches (default 500)
  --output <dir>      Output directory (default ./output)
  --no-cache          Bypass all caches
  --search-only       Run Phase 1 only (skip deep scan)
  --dry-run           Parse CSV + show stats, no API calls
```

In CLI mode the SerpApi key is read from `SERPAPI_KEY` in `.env`:

```
SERPAPI_KEY=your_key_here
```

The GUI mode accepts the key via the dashboard form instead — it's never written to disk in GUI mode.

## Security model

This tool handles sensitive investigative data and fetches URLs from disreputable sources. The GUI server was hardened after an internal review:

- **Loopback only** — binds to `127.0.0.1`, not `0.0.0.0`. LAN peers cannot reach it.
- **Per-session auth token** — random 192-bit token generated at startup, required on every `/api/*` route via `X-Auth-Token` header (or `?t=` query for SSE and the initial dashboard load). Constant-time compare.
- **Path confinement** — uploads clamped to `./uploads/`, outputs clamped to `./output/`. Traversal attempts (`../`, absolute paths, Windows drive prefixes) are rejected or coerced to the safe root.
- **SSRF guard** — every URL fetched by `fetcher.js` or navigated by Puppeteer is resolved via DNS and rejected if it points at loopback, RFC1918 private ranges, link-local (`169.254.0.0/16` — including cloud metadata), or IPv6 ULA / link-local. Only `http:` and `https:` schemes are allowed.
- **Body size cap** — HTML responses stream through a 2 MB hard limit to prevent slow-loris memory exhaustion.
- **XSS-safe rendering** — dashboard escapes all third-party strings (CSV fields, SerpApi result URLs, HTTP response snippets) before inserting them into the DOM.
- **Puppeteer sandbox on** — `--no-sandbox` was removed from the browser launch args.
- **No stack traces over SSE** — pipeline errors emit only `err.message`; stack traces stay in server logs.

**Residual risks worth knowing about**

- DNS rebinding between the SSRF safety check and the actual connect is theoretically possible but unmitigated. Acceptable for this offline triage use case.
- The auth token is a bearer token — anyone with local read access to your clipboard or browser history after following the initial URL can hijack the session until the server restarts. Close the tab when you're done.
- GUI mode doesn't use TLS. That's fine on loopback, but don't try to tunnel the dashboard over the open internet without putting it behind HTTPS + additional auth.

## Repository layout

```
src/
  server.js        GUI Express server + pipeline orchestration
  cli.js           Headless CLI runner
  ingest.js        CSV parsing + phone normalization
  searcher.js      SerpApi client (phone + address queries)
  fetcher.js       URL fetcher + SSRF guard + HTML→text extractor
  analyzer.js      Keyword/phone/domain scoring
  output.js        CSV/JSON/summary writers
  screenshot.js    Puppeteer wrapper for full-page screenshots
  dashboard.html   Single-page UI served at /
  template.csv     Starter CSV shipped via /api/template.csv
uploads/           User-uploaded CSVs land here (gitignore recommended)
output/            Pipeline output + cache (gitignore recommended)
```

## Troubleshooting

**"Upload failed: Invalid filename characters"**
Filenames can contain spaces, commas, parentheses, and dashes. Control characters and `\ / : * ? " < > |` are rejected.

**"Blocked: Private/loopback IP"**
The SSRF guard refused to fetch a URL because its hostname resolved to a private/loopback address. This is intentional — if you're testing against a local fixture, host it on a public-looking DNS name or disable the guard temporarily (not recommended for production runs).

**Puppeteer fails to launch**
Make sure Chromium's sandbox prerequisites are met on your OS. On Linux this may require `sudo apt install libatk-bridge2.0-0 libgbm1 libxkbcommon0` etc. (see [Puppeteer troubleshooting](https://pptr.dev/troubleshooting)). The `--no-sandbox` flag was intentionally removed for security reasons — do not re-add it.

**SerpApi errors / rate limiting**
Increase `--delay` (CLI) or the "Search Delay" field in the dashboard. The searcher already does exponential backoff on 429 responses, but a hard cap of 3 retries means a bad run will log errors and move on.

## License

Private / internal tool.
