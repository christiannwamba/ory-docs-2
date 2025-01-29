import { chromium } from "@playwright/test"
import { writeFileSync } from "fs"
import ollama from "ollama"

interface DocPage {
  url: string
  title: string
  summary: string
  lastUpdated: string
}

const results: DocPage[] = []
const BASE_URL = "http://localhost:3000"

async function generateSummary(content: string): Promise<string> {
  const prompt = `
    Please provide a concise summary of the following documentation content.
    Focus only on the key technical points and implementation details.
    The summary will be added to spreadsheet for analysis so avoid any introductions, conclusions, or general statements in the summary.
    Keep the summary technical and specific. The summary must not contail the | character because it is used as a separator in the spreadsheet.

    Content:
    ${content}
  `

  try {
    const response = await ollama.chat({
      model: "llama3.2",
      messages: [{ role: "user", content: prompt }],
    })

    return response.message.content.trim()
  } catch (error) {
    console.error("Error generating summary:", error)
    return content.split("\n")[0] || "" // Fallback to first paragraph
  }
}

async function crawlPage(url: string, page: any): Promise<string[]> {
  await page.goto(url)

  // Extract page content
  const content = await page.evaluate(() => ({
    title: document.title,
    body: Array.from(document.querySelectorAll("article p"))
      .map((p) => p.textContent)
      .join("\n"),
    headings: Array.from(
      document.querySelectorAll("article h1, article h2, article h3"),
    )
      .map((h) => h.textContent)
      .join(" > "),
  }))

  // Generate AI summary
  const summary = await generateSummary(
    `${content.headings}\n\n${content.body}`,
  )

  // Store results
  results.push({
    url: url.replace(BASE_URL, ""), // Store relative URL
    title: content.title,
    summary,
    lastUpdated: new Date().toISOString(),
  })

  // Find internal links - look for both absolute and relative paths
  const links = await page.$$eval(
    'a[href^="/docs/"], a[href*="localhost:3000/docs/"]',
    (links: HTMLAnchorElement[], baseUrl: string) => {
      const validLinks = links
        .map((link) => {
          const href = link.getAttribute("href")
          return href?.startsWith("http") ? href : `${baseUrl}${href}`
        })
        .filter(
          (href): href is string =>
            href !== null && href !== undefined && !href.includes("/v[0-9]+/"),
        )
      return Array.from(new Set(validLinks))
    },
    BASE_URL,
  )

  return links
}

async function exportToCSV() {
  const separator = "|"
  const csvHeader = `URL${separator}Title${separator}Summary${separator}Last Updated\n`
  const csvRows = results
    .map(
      (row) =>
        `"${row.url}"${separator}"${row.title}"${separator}"${row.summary.replace(/"/g, '""')}"${separator}"${row.lastUpdated}"`,
    )
    .join("\n")

  writeFileSync("docs.csv", csvHeader + csvRows)
  console.log(`Exported ${results.length} pages to docs.csv`)
}

async function main() {
  // First verify Ollama is running
  try {
    const testResponse = await ollama.chat({
      model: "llama3.2",
      messages: [{ role: "user", content: "test" }],
    })
  } catch (error) {
    console.error("Error connecting to Ollama. Make sure it is running:")
    console.error("Run: ollama serve")
    process.exit(1)
  }

  const browser = await chromium.launch()
  const context = await browser.newContext()
  const page = await context.newPage()

  const startUrl = `${BASE_URL}/docs/`
  const visited = new Set<string>()
  const queue: string[] = [startUrl]

  // Set up incremental saves
  const saveInterval = setInterval(exportToCSV, 30000)

  try {
    while (queue.length > 0) {
      const url = queue.shift()!

      if (visited.has(url)) continue
      visited.add(url)

      console.log(`Crawling ${url}`)
      try {
        const newLinks = await crawlPage(url, page)
        queue.push(...newLinks.filter((link) => !visited.has(link)))
      } catch (error) {
        console.error(`Error crawling ${url}:`, error)
      }

      // Progress update
      console.log(`Crawled ${results.length} pages (${queue.length} pending)`)

      // Small delay between pages
      await new Promise((resolve) => setTimeout(resolve, 50))
    }
  } finally {
    clearInterval(saveInterval)
    await exportToCSV()
    await browser.close()
  }
}

main().catch(console.error)
