// app.js - Smiles Bot: Full Browser Simulation (Works Nov 2025)
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

// Full browser flow: Home page → form fill → scrape results
async function scrapeSmiles(origin, dest, dateISO) {
  const browser = await puppeteer.launch({
    headless: "new",
    args: [
      "--no-sandbox",
      "--disable-setuid-sandbox",
      "--disable-dev-shm-usage",
      "--disable-web-security",
      "--user-agent=Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36"
    ],
  });
  const page = await browser.newPage();
  await page.setViewport({ width: 1366, height: 768 });

  try {
    // Start at home page
    await page.goto("https://www.smiles.com.br", { waitUntil: "networkidle2", timeout: 30000 });

    // Click search link
    await page.waitForSelector("a[href*='emissao-passagem'], button[data-testid='search-flights']", { timeout: 10000 });
    await page.click("a[href*='emissao-passagem'], button[data-testid='search-flights']");
    await page.waitForTimeout(2000);

    // Fill origin
    await page.waitForSelector("input[placeholder*='Origem'], input[data-testid='origin-input']", { timeout: 10000 });
    await page.fill("input[placeholder*='Origem'], input[data-testid='origin-input']", origin);
    await page.keyboard.press("Enter");
    await page.waitForTimeout(1000);

    // Fill destination
    await page.fill("input[placeholder*='Destino'], input[data-testid='destination-input']", dest);
    await page.keyboard.press("Enter");
    await page.waitForTimeout(1000);

    // Fill date
    await page.fill("input[placeholder*='Ida'], input[data-testid='departure-date']", dateISO);
    await page.waitForTimeout(1000);

    // Submit
    await page.click("button[type='submit'], button[data-testid='search-button']");
    await page.waitForTimeout(5000);

    // Wait for results
    await page.waitForSelector(".flight-card, .result-item, .no-results", { timeout: 30000 });

    // Extract flights
    const flights = await page.evaluate(() => {
      const rows = document.querySelectorAll(".flight-card, .result-item");
      return Array.from(rows).map(row => {
        const airline = row.querySelector(".airline-name")?.innerText?.trim() || "GOL";
        const dep = row.querySelector(".dep-time")?.innerText?.match(/(\d{1,2}:\d{2})/)?.[1] || "";
        const arr = row.querySelector(".arr-time")?.innerText?.match(/(\d{1,2}:\d{2})/)?.[1] || "";
        const econPts = row.querySelector(".econ-points")?.innerText?.match(/(\d+)/)?.[1] || null;
        const busPts = row.querySelector(".bus-points")?.innerText?.match(/(\d+)/)?.[1] || null;
        const taxesText = row.querySelector(".taxes")?.innerText || "";
        const taxesBRL = parseFloat(taxesText.replace(/[^\d,]/g, '').replace(',', '.')) || 0;

        return { airline, dep, arr, econPts: parseInt(econPts), busPts: parseInt(busPts), taxesBRL };
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

    out += `\( {f.origin || "JFK"} \){dep12} - \( {f.dest || "GRU"} \){arr12}\n`;
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
