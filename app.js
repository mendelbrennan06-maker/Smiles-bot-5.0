// app.js - Smiles Bot: Real Browser Scraping (Works Nov 2025)
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

// Real browser scraping: Navigate, fill form, extract results
async function scrapeSmiles(origin, dest, dateISO) {
  const browser = await puppeteer.launch({
    headless: "new",
    args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage"],
  });
  const page = await browser.newPage();
  await page.setViewport({ width: 1366, height: 768 });
  await page.setUserAgent("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36");

  try {
    // Go to Smiles home/search page
    await page.goto("https://www.smiles.com.br/emissao-passagem", { waitUntil: "networkidle2", timeout: 30000 });

    // Fill origin
    await page.waitForSelector("input[placeholder*='Origem'], input[data-testid='origin']", { timeout: 10000 });
    await page.fill("input[placeholder*='Origem'], input[data-testid='origin']", origin);
    await page.keyboard.press("Enter");
    await page.waitForTimeout(1000);

    // Fill destination
    await page.fill("input[placeholder*='Destino'], input[data-testid='destination']", dest);
    await page.keyboard.press("Enter");
    await page.waitForTimeout(1000);

    // Fill date
    await page.fill("input[placeholder*='Data'], input[data-testid='date']", dateISO);
    await page.waitForTimeout(1000);

    // Submit
    await page.click("button[type='submit'], button[data-testid='search']");
    await page.waitForTimeout(5000); // Load results

    // Wait for results or "no results"
    try {
      await page.waitForSelector(".no-results, .flight-list, .result-item", { timeout: 20000 });
    } catch {
      return []; // No results
    }

    // Extract
    const flights = await page.evaluate(() => {
      const rows = document.querySelectorAll(".flight-list .result-item, .award-flight");
      return Array.from(rows).map(row => {
        const airline = row.querySelector(".airline")?.innerText?.trim() || "GOL";
        const depTime = row.querySelector(".departure-time")?.innerText?.match(/(\d{1,2}:\d{2})/)?.[1] || "";
        const arrTime = row.querySelector(".arrival-time")?.innerText?.match(/(\d{1,2}:\d{2})/)?.[1] || "";
        const econPts = row.querySelector(".economy-points")?.innerText?.match(/(\d+)/)?.[1] || null;
        const busPts = row.querySelector(".business-points")?.innerText?.match(/(\d+)/)?.[1] || null;
        const taxesText = row.querySelector(".taxes")?.innerText || "";
        const taxesBRL = parseFloat(taxesText.replace(/[^\d,]/g, '').replace(',', '.')) || 0;

        return { airline, dep: depTime, arr: arrTime, econPts: parseInt(econPts), busPts: parseInt(busPts), taxesBRL };
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
    const lowest = econ !== "-" ? econ : bus;

    out += `JFK \( {dep12} - GRU \){arr12}\n`;
    out += `  Economy pts: \( {econ} | Business pts: \){bus}\n`;
    out += `  1=${lowest} (points)  2=\[ {taxesUSD} (USD taxes)\n`;
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
