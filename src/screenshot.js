import puppeteer from 'puppeteer';
import path from 'path';
import { mkdirSync } from 'fs';
import { checkUrlSafety } from './fetcher.js';

/**
 * Capture a full-page screenshot of a URL.
 * @param {string} url - The URL to capture.
 * @param {string} outputPath - Directory to save the screenshot.
 * @param {string} filename - Output filename (e.g., 'ME0773_rubmaps_ch.png').
 * @returns {Promise<string|null>} - Returns the full path to the image, or null on error.
 */
export async function takeScreenshot(url, outputPath, filename) {
  const safety = await checkUrlSafety(url);
  if (!safety.ok) {
    console.error(`Screenshot blocked for ${url}: ${safety.reason}`);
    return null;
  }

  mkdirSync(outputPath, { recursive: true });
  const fullPath = path.join(outputPath, filename);

  let browser = null;
  try {
    browser = await puppeteer.launch({
      headless: 'new',
      args: ['--disable-dev-shm-usage', '--window-size=1920,1080']
    });
    
    const page = await browser.newPage();
    await page.setViewport({ width: 1920, height: 1080 });
    
    // Set user agent to avoid basic antibot blocks
    await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36');
    
    // Navigate with a timeout
    await page.goto(url, { waitUntil: 'networkidle2', timeout: 15000 });
    
    // Wait an extra second for any generic age gate overlays to render, or dynamic content
    await new Promise(resolve => setTimeout(resolve, 1000));
    
    // Full page screenshot
    await page.screenshot({ path: fullPath, fullPage: true });
    
    return fullPath;
  } catch (error) {
    console.error(`Screenshot failed for ${url}:`, error.message);
    return null;
  } finally {
    if (browser) {
      await browser.close();
    }
  }
}
