// app.js - Smiles WhatsApp Bot: Home Page Navigation + Puppeteer (Nov 2025)
import express from "express";
import puppeteer from "puppeteer";

const app = express();
app.use(express.urlencoded({ extended: true }));
app.use(express.json());

const BRL_TO_USD_RATE = 5.8;

/**
 * Helpers
 */
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

/**
 * Scrape Smiles: Navigate from home page, fill form, extract results
 * No hardcoded links — full browser flow.
 */
async function scrapeSmiles(origin, dest, dateISO) {
  const browser = await puppeteer.launch({
    headless: "new",
    args: [
      "--no-sandbox",
      "--disable-setuid-sandbox",
      "--disable-dev-shm-usage",
      "--disable-web-security",
      "--disable-features=VizDisplayCompositor",
      "--user-agent=Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36"
    ],
  });
  const page = await browser.newPage();
  await page.setViewport({ width: 1366, height: 768 });

  try {
    // Step 1: Go to Smiles home page
    await page.goto("https://www.smiles.com.br", { waitUntil: "networkidle2", timeout: 30000 });

    // Step 2: Click "Busca de Passagens" link to open search form (home has embedded search)
    await page.waitForSelector("a[href*='/busca-passagens'], button[data-testid='search-flights']", { timeout: 10000 });
    await page.click("a[href*='/busca-passagens'], button[data-testid='search-flights']");
    await page.waitForTimeout(2000); // Let overlay/form load

    // Step 3: Fill origin (type + select first suggestion)
    await page.waitForSelector("input[placeholder*='Origem'], input[data-testid='origin-input']", { timeout: 10000 });
    await page.fill("input[placeholder*='Origem'], input[data-testid='origin-input']", origin);
    await page.waitForSelector(".suggestion-item:first-child, [role='option']:first-child", { timeout: 5000 });
    await page.click(".suggestion-item:first-child, [role='option']:first-child");

    // Step 4: Fill destination
    await page.fill("input[placeholder*='Destino'], input[data-testid='destination-input']", dest);
    await page.waitForSelector(".suggestion-item:first-child, [role='option']:first-child", { timeout: 5000 });
    await page.click(".suggestion-item:first-child, [role='option']:first-child");

    // Step 5: Fill departure date (format YYYY-MM-DD)
    await page.fill("input[placeholder*='Ida'], input[data-testid='departure-date']", dateISO);
    await page.keyboard.press("Enter"); // Trigger date picker if needed

    // Step 6: Submit search
    await page.click("button[type='submit'], button[data-testid='search-button'], .search-btn");

    // Step 7: Wait for results (dynamic load)
    await page.waitForSelector(".flight-card, .search-result-item, [data-testid='flight-result']", { timeout: 30000 });

    // Step 8: Extract flights
    const flights = await page.evaluate(() => {
      const rows = document.querySelectorAll(".flight-card, .search-result-item, [data-testid='flight-result']");
      return Array.from(rows).map((row, index) => {
        // Airline
        const airline = row.querySelector(".airline-name, .carrier-code, [data-testid='airline']")?.innerText?.trim() || "GOL";

        // Times & Codes
        const originCode = row.querySelector(".origin-code, .dep-airport")?.innerText?.trim();
        const destCode = row.querySelector(".dest-code, .arr-airport")?.innerText?.trim();
        const dep = row.querySelector(".depart-time, [data-testid='dep-time']")?.innerText?.match(/(\d{1,2}:\d{2})/)?.[1] || "";
        const arr = row.querySelector(".arrival-time, [data-testid='arr-time']")?.innerText?.match(/(\d{1,2}:\d{2})/)?.[1] || "";

        // Points (economy/business)
        const econText = row.querySelector("[data-testid='economy-points'], .econ-miles")?.innerText || "";
        const busText = row.querySelector("[data-testid='business-points'], .bus-miles")?.innerText || "";
        const econPts = econText.match(/(\d{1,5})/)?.[1] ? parseInt(econText.match(/(\d{1,5})/)[1]) : null;
        const busPts = busText.match(/(\d{1,5})/)?.[1] ? parseInt(busText.match(/(\d{1,5})/)[1]) : null;

        // Taxes (BRL format R$ 123,45)
        const taxesText = row.querySelector(".taxes, [data-testid='tax-amount']")?.innerText || "";
        let taxesBRL = 0;
        const match = taxesText.match(/R\$\s*([\d.,]+)/i);
        if (match) {
          taxesBRL = parseFloat(match[1].replace(/\./g, '').replace(',', '.'));
        }

        return { airline, originCode: originCode || "ORIG", destCode: destCode || "DEST", dep, arr, econPts, busPts, taxesBRL };
      }).filter(f => f.econPts || f.busPts); // Only award space
    });

    return flights;
  } catch (error) {
    console.error(`Scrape failed for \( {origin}- \){dest}:`, error.message);
    return [];
  } finally {
    await browser.close();
  }
}

/**
 * Build response in your exact format
 */
function buildResponse({ flights, maxPoints = Infinity }) {
  const valid = flights.filter(f => Math.min(f.econPts || Infinity, f.busPts || Infinity) <= maxPoints);
  if (!valid.length) return "No award space found under your max points.";

  const both = valid.filter(f => f.econPts && f.busPts);
  const econOnly = valid.filter(f => f.econPts && !f.busPts);
  const busOnly = valid.filter(f => !f.econPts && f.busPts);

  function sortByDep(arr) {
    return arr.sort((a, b) => a.dep.localeCompare(b.dep));
  }

  const sections = [
    { title: "Both Economy & Business", items: sortByDep(both) },
    { title: "Economy only", items: sortByDep(econOnly) },
    { title: "Business only", items: sortByDep(busOnly) },
  ];

  let out = "";
  sections.forEach(sec => {
    if (!sec.items.length) return;
    out += `=== ${sec.title} ===\n`;

    // Group by origin -> airline
    const grouping = {};
    sec.items.forEach(f => {
      const origin = f.originCode;
      const airline = f.airline;
      grouping[origin] = grouping[origin] || {};
      grouping[origin][airline] = grouping[origin][airline] || [];
      grouping[origin][airline].push(f);
    });

    for (const origin of Object.keys(grouping)) {
      for (const airline of Object.keys(grouping[origin])) {
        out += `\n\( {airline} from \){origin}:\n`;
        grouping[origin][airline].forEach(f => {
          const dep12 = to12Hour(f.dep);
          const arr12 = to12Hour(f.arr);
          const econ = f.econPts ? `${f.econPts}` : "-";
          const bus = f.busPts ? `${f.busPts}` : "-";
          const taxesUSD = f.taxesBRL ? brlToUsd(f.taxesBRL) : "-";
          const lowestPts = econ !== "-" ? econ : bus;

          out += `\( {origin} \){dep12} - \( {f.destCode} \){arr12}\n`;
          out += `  Economy pts: \( {econ} | Business pts: \){bus}\n`;
          out += `  1=${lowestPts} (points)  2=\[ {taxesUSD} (USD taxes)\n`;
          if (f.econPts) out += `    (points value est: \]{ptsValueUsd(f.econPts).toFixed(2)})\n`;
          if (f.busPts) out += `    (points value est: $${ptsValueUsd(f.busPts).toFixed(2)})\n`;
        });
      }
    }
    out += "\n";
  });

  return out;
}

/**
 * WhatsApp Webhook
 */
app.post("/whatsapp-webhook", async (req, res) => {
  try {
    const incoming = (req.body.Body || "").trim().toUpperCase();
    const match = incoming.match(/([A-Z]{3})-([A-Z]{3})\s+([\d-]{10})(?:\s+max=(\d+))?/i);
    if (!match) {
      return res.type("text/xml").send("<Response><Message>Format: NYC-GRU 2025-12-20 max=50000</Message></Response>");
    }

    const [, originCity, dest, dateISO, maxStr] = match;
    const maxPoints = maxStr ? Number(maxStr) : Infinity;
    const originAirports = originCity === "NYC" ? ["JFK", "LGA", "EWR"] : [originCity];

    let allFlights = [];
    for (const o of originAirports) {
      console.log(`Searching \( {o}- \){dest} on ${dateISO}...`);
      const flights = await scrapeSmiles(o, dest, dateISO);
      allFlights.push(...flights);
    }

    const responseText = buildResponse({ flights: allFlights, maxPoints });

    res.type("text/xml").send(`
<Response>
  <Message>${responseText || "No flights found."}</Message>
</Response>
    `.trim());
  } catch (err) {
    console.error("Webhook error:", err);
    res.type("text/xml").send("<Response><Message>Sorry, something went wrong. Try again later.</Message></Response>");
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Smiles Bot running on port ${PORT}`));
