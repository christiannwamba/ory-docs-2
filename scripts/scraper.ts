import { chromium } from '@playwright/test';
import { writeFileSync } from 'fs';

interface DocPage {
  url: string;
  title: string;
  summary: string;
  lastUpdated: string;
}

const results: DocPage[] = [];
const BASE_URL = 'http://localhost:3000';

async function crawlPage(url: string, page: any): Promise<string[]> {
  await page.goto(url);

  // Extract page content
  const content = await page.evaluate(() => ({
    title: document.title,
    body: Array.from(document.querySelectorAll('article p'))
      .map((p) => p.textContent)
      .join('\n'),
    // Also extract headings for better context
    headings: Array.from(document.querySelectorAll('article h1, article h2, article h3'))
      .map((h) => h.textContent)
      .join(' > '),
  }));

  // Simple summary generation (first paragraph + headings)
  const firstParagraph = content.body.split('\n')[0] || '';
  const summary = `${content.headings}\n${firstParagraph}`.slice(0, 300) + '...';

  // Store results
  results.push({
    url: url.replace(BASE_URL, ''),  // Store relative URL
    title: content.title,
    summary,
    lastUpdated: new Date().toISOString(),
  });

  // Find internal links - look for both absolute and relative paths
  const links = await page.$$eval(
    'a[href^="/docs/"], a[href*="localhost:3000/docs/"]',
    (links: HTMLAnchorElement[], baseUrl: string) => {
      const validLinks = links
        .map((link) => {
          const href = link.getAttribute('href');
          return href?.startsWith('http') ? href : `${baseUrl}${href}`;
        })
        .filter((href): href is string => 
          href !== null && 
          href !== undefined && 
          !href.includes('/v[0-9]+/')
        );
      return Array.from(new Set(validLinks));
    },
    BASE_URL
  );

  return links;
}

async function exportToCSV() {
  const csvHeader = 'URL,Title,Summary,Last Updated\n';
  const csvRows = results
    .map(
      (row) =>
        `"${row.url}","${row.title}","${row.summary}","${row.lastUpdated}"`
    )
    .join('\n');

  writeFileSync('docs.csv', csvHeader + csvRows);
  console.log(`Exported ${results.length} pages to docs.csv`);
}

async function main() {
  const browser = await chromium.launch();
  const context = await browser.newContext();
  const page = await context.newPage();
  
  const startUrl = `${BASE_URL}/docs/`;
  const visited = new Set<string>();
  const queue: string[] = [startUrl];

  // Set up incremental saves
  const saveInterval = setInterval(exportToCSV, 30000);

  try {
    while (queue.length > 0) {
      const url = queue.shift()!;
      
      if (visited.has(url)) continue;
      visited.add(url);

      console.log(`Crawling ${url}`);
      try {
        const newLinks = await crawlPage(url, page);
        queue.push(...newLinks.filter(link => !visited.has(link)));
      } catch (error) {
        console.error(`Error crawling ${url}:`, error);
      }

      // Progress update
      console.log(`Crawled ${results.length} pages (${queue.length} pending)`);
      
      // No need for aggressive rate limiting on local server
      await new Promise(resolve => setTimeout(resolve, 50));
    }
  } finally {
    clearInterval(saveInterval);
    await exportToCSV();
    await browser.close();
  }
}

main().catch(console.error);
