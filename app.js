// app.js - Smiles Bot: Fixed URL & Selectors (Nov 23 2025)
import express from "express";
import puppeteer from "puppeteer";

const app = express();
app.use(express.urlencoded({ extended: true }));
app.use(express.json());

const BRL_TO_USD_RATE = 5.8;

function brlToUsd(brl) {
  return Number((brl / BRL_TO_USD_RATE).toFixed(0));
}

function ptsValueUsd(points) {
  if (points <= 20000) return points * 0.005;
  if (points <= 40000) return points * 0.0045;
  if (points <= 60000) return points * 0.0043;
  return points * 0.004;
}

function to12Hour(time24) {
  if (!time24) return "";
  const [hh, mm] = time24.split(":").map(Number);
  const period = hh >= 12 ? "pm" : "am";
  const hh12 = hh % 12 || 12;
  return `\( {hh12}: \){String(mm).padStart(2, "0")}${period}`;
}

// Fixed scraper: Correct URL + current selectors
async function scrapeSmiles(origin, dest, dateISO) {
  const browser = await puppeteer.launch({
    headless: "new",
    args: [
      "--no-sandbox",
      "--disable-setuid-sandbox",
      "--disable-dev-shm-usage",
      "--disable-web-security",
    ],
  });
  const page = await browser.newPage();
  await page.setViewport({ width: 1366, height: 768 });
  await page.setUserAgent("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36");

  try {
    // Fixed URL (current live search page)
    await page.goto("https://www.smiles.com.br/emissao-passagem", { waitUntil: "networkidle2", timeout: 30000 });

    // Fixed origin selector (current data-testid)
    await page.waitForSelector("[data-testid='origin-airport'], input[placeholder*='de onde']", { timeout: 10000 });
    await page.fill("[data-testid='origin-airport'], input[placeholder*='de onde']", origin);
    await page.keyboard.press("Enter");
    await page.waitForTimeout(1500);

    // Fixed destination selector
    await page.waitForSelector("[data-testid='destination-airport'], input[placeholder*='para onde']", { timeout: 10000 });
    await page.fill("[data-testid='destination-airport'], input[placeholder*='para onde']", dest);
    await page.keyboard.press("Enter");
    await page.waitForTimeout(1500);

    // Fixed date selector
    await page.waitForSelector("[data-testid='departure-date'], input[placeholder*='ida']", { timeout: 10000 });
    await page.fill("[data-testid='departure-date'], input[placeholder*='ida']", dateISO);
    await page.waitForTimeout(1000);

    // Fixed submit button selector
    await page.waitForSelector("[data-testid='search-btn'], button[class*='pesquisar']", { timeout: 5000 });
    await page.click("[data-testid='search-btn'], button[class*='pesquisar']");

    // Wait for results (fixed selector)
    await page.waitForSelector("[data-testid='flight-list'], .flight-item, .no-results", { timeout: 30000 });

    // Check if no results
    const hasResults = await page.evaluate(() => !!document.querySelector("[data-testid='flight-list'], .flight-item"));
    if (!hasResults) return [];

    // Extract flights (fixed selectors)
    const flights = await page.evaluate(() => {
      const rows = document.querySelectorAll("[data-testid='flight-item'], .flight-item, .voo");
      return Array.from(rows).map(row => {
        const airline = row.querySelector("[data-testid='airline-name']")?.innerText?.trim() || "GOL";
        const dep = row.querySelector("[data-testid='dep-time']")?.innerText?.match(/(\d{1,2}:\d{2})/)?.[1] || "";
        const arr = row.querySelector("[data-testid='arr-time']")?.innerText?.match(/(\d{1,2}:\d{2})/)?.[1] || "";
        const econText = row.querySelector("[data-testid='econ-points']")?.innerText || "";
        const busText = row.querySelector("[data-testid='bus-points']")?.innerText || "";
        const econPts = econText.match(/(\d{1,5})/)?.[1] ? parseInt(econText.match(/(\d{1,5})/)[1]) : null;
        const busPts = busText.match(/(\d{1,5})/)?.[1] ? parseInt(busText.match(/(\d{1,5})/)[1]) : null;
        const taxesText = row.querySelector("[data-testid='taxes']")?.innerText || "";
        let taxesBRL = 0;
        const match = taxesText.match(/R\$\s*([\d.,]+)/i);
        if (match) {
          taxesBRL = parseFloat(match[1].replace(/\./g, '').replace(',', '.'));
        }

        return { airline, dep, arr, econPts, busPts, taxesBRL };
      }).filter(f => f.econPts || f.busPts);
    });

    return flights;
  } catch (e) {
    console.error("Scrape error:", e.message);
    return [];
  } finally {
    await browser.close();
  }
}

function buildResponse({ flights, maxPoints = Infinity }) {
  const valid = flights.filter(f => Math.min(f.econPts || Infinity, f.busPts || Infinity) <= maxPoints);
  if (!valid.length) return "No award space found under your max points.";

  let out = "";
  valid.forEach(f => {
    const dep12 = to12Hour(f.dep);
    const arr12 = to12Hour(f.arr);
    const econ = f.econPts ? `${f.econPts}` : "-";
    const bus = f.busPts ? `${f.busPts}` : "-";
    const taxesUSD = f.taxesBRL ? brlToUsd(f.taxesBRL) : "-";
    const lowestPts = econ !== "-" ? econ : bus;

    out += `JFK \( {dep12} - GRU \){arr12}\n`;
    out += `  Economy pts: \( {econ} | Business pts: \){bus}\n`;
    out += `  1=${lowestPts} (points)  2=\[ {taxesUSD} (USD taxes)\n`;
    if (f.econPts) out += `    (points value est: \]{ptsValueUsd(f.econPts).toFixed(2)})\n`;
    if (f.busPts) out += `    (points value est: $${ptsValueUsd(f.busPts).toFixed(2)})\n\n`;
  });
  return out;
}

app.post("/whatsapp-webhook", async (req, res) => {
  try {
    const incoming = (req.body.Body || "").trim().toUpperCase();
    const match = incoming.match(/([A-Z]{3})-([A-Z]{3})\s+([\d-]{10})(?:\s+MAX=(\d+))?/i);
    if (!match) {
      return res.type("text/xml").send("<Response><Message>Format: NYC-GRU 2025-12-20 max=50000</Message></Response>");
    }

    const [, originCity, dest, dateISO, maxStr] = match;
    const maxPoints = maxStr ? Number(maxStr) : Infinity;
    const originAirports = originCity === "NYC" ? ["JFK", "LGA", "EWR"] : [originCity];

    let allFlights = [];
    for (const o of originAirports) {
      const flights = await scrapeSmiles(o, dest, dateISO);
      allFlights.push(...flights);
    }

    const responseText = buildResponse({ flights: allFlights, maxPoints });

    res.type("text/xml").send(`
<Response>
  <Message>${responseText}</Message>
</Response>
    `.trim());
  } catch (err) {
    console.error(err);
    res.type("text/xml").send("<Response><Message>Sorry, try again later.</Message></Response>");
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log("Smiles Bot running on", PORT));
