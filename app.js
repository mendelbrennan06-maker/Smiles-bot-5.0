// app.js - Smiles Bot: Home Page + Dynamic Form Load (Final Nov 2025)
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

// Robust scraper: Home page + dynamic wait for form
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
    // Start at home page (form is embedded)
    await page.goto("https://www.smiles.com.br", { waitUntil: "networkidle2", timeout: 30000 });

    // Wait for form to load dynamically (generic selector for any input with placeholder)
    await page.waitForFunction(() => {
      const inputs = document.querySelectorAll("input[placeholder*='Origem'], input[placeholder*='de onde'], input[type='text']");
      return inputs.length > 0;
    }, { timeout: 15000 });

    // Fill origin (generic input)
    const originInput = await page.$("input[placeholder*='Origem'], input[placeholder*='de onde'], input[type='text']:first-of-type");
    if (originInput) {
      await originInput.type(origin);
      await page.keyboard.press("Enter");
      await page.waitForTimeout(1500);
    }

    // Fill destination (next input)
    const destInput = await page.$("input[placeholder*='Destino'], input[placeholder*='para onde'], input[type='text']:nth-of-type(2)");
    if (destInput) {
      await destInput.type(dest);
      await page.keyboard.press("Enter");
      await page.waitForTimeout(1500);
    }

    // Fill date (date input)
    const dateInput = await page.$("input[placeholder*='Data'], input[placeholder*='ida'], input[type='date']");
    if (dateInput) {
      await dateInput.type(dateISO);
      await page.waitForTimeout(1000);
    }

    // Submit (generic button)
    const submitBtn = await page.$("button[type='submit'], button[class*='search'], button[class*='buscar'], button[class*='btn']");
    if (submitBtn) {
      await submitBtn.click();
      await page.waitForTimeout(5000);
    }

    // Wait for results (generic selector)
    await page.waitForSelector(".result, .flight, .no-results, div[class*='result']", { timeout: 30000 });

    // Check if no results
    const hasResults = await page.evaluate(() => !!document.querySelector(".result, .flight, div[class*='result'] > div"));
    if (!hasResults) return [];

    // Extract flights (generic selectors)
    const flights = await page.evaluate(() => {
      const rows = document.querySelectorAll(".result, .flight, div[class*='result'] > div");
      return Array.from(rows).map(row => {
        const airline = row.querySelector(".airline, .carrier, .company")?.innerText?.trim() || "GOL";
        const dep = row.querySelector(".dep, .departure")?.innerText?.match(/(\d{1,2}:\d{2})/)?.[1] || "";
        const arr = row.querySelector(".arr, .arrival")?.innerText?.match(/(\d{1,2}:\d{2})/)?.[1] || "";
        const econText = row.querySelector(".econ, .economy")?.innerText || "";
        const busText = row.querySelector(".bus, .business")?.innerText || "";
        const econPts = econText.match(/(\d{1,5})/)?.[1] ? parseInt(econText.match(/(\d{1,5})/)[1]) : null;
        const busPts = busText.match(/(\d{1,5})/)?.[1] ? parseInt(busText.match(/(\d{1,5})/)[1]) : null;
        const taxesText = row.querySelector(".tax, .fee")?.innerText || "";
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
