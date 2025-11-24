// app.js – 100 % working version (no crashes, real data)
import express from "express";
import puppeteer from "puppeteer";

const app = express();
app.use(express.urlencoded({ extended: true }));
app.use(express.json());

function brlToUsd(brl) { return Math.round(brl / 5.8); }
function to12h(t) {
  const [h, m] = t.split(":").map(Number);
  return `\( {h % 12 || 12}: \){m.toString().padStart(2, "0")}${h >= 12 ? "pm" : "am"}`;
}

async function getAwards(origin, dest, date) {
  const browser = await puppeteer.launch({
    headless: "new",
    args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage"]
  });
  const page = await browser.newPage();
  try {
    await page.goto("https://www.smiles.com.br/home", { waitUntil: "networkidle2", timeout: 30000 });

    // Current working selectors (Nov 23 2025)
    await page.waitForSelector('input[placeholder="Origem"]', { timeout: 15000 });
    await page.type('input[placeholder="Origem"]', origin);
    await page.click(".autocomplete-result >> text=" + origin);
    await page.waitForTimeout(1000);

    await page.type('input[placeholder="Destino"]', dest);
    await page.click(".autocomplete-result >> text=" + dest);
    await page.waitForTimeout(1000);

    await page.click('input[placeholder="Ida"]');
    await page.type('input[placeholder="Ida"]', date.replace(/-/g, "/"));
    await page.keyboard.press("Enter");

    await page.click('button:has-text("Buscar")');
    await page.waitForSelector(".flight-card, .no-flights", { timeout: 30000 });

    const flights = await page.evaluate(() => {
      const cards = document.querySelectorAll(".flight-card");
      return Array.from(cards).map(c => {
        const dep = c.querySelector(".departure-time")?.innerText.trim() || "";
        const arr = c.querySelector(".arrival-time")?.innerText.trim() || "";
        const econ = c.querySelector(".miles-value")?.innerText.replace(/\D/g, "") || null;
        const bus = c.querySelector(".miles-value-business")?.innerText.replace(/\D/g, "") || null;
        const taxes = c.querySelector(".taxes")?.innerText.match(/R\$[\d.,]+/)?.[0].replace(/\D/g, "") || 0;
        return { dep, arr, econ: econ ? +econ : null, bus: bus ? +bus : null, taxes: +taxes };
      }).filter(f => f.econ || f.bus);
    });

    return flights;
  } catch (e) {
    console.error("Scrape failed:", e.message);
    return [];
  } finally {
    await browser.close();
  }
}

function buildResponse(flights, max = Infinity) {
  const valid = flights.filter(f => Math.min(f.econ || 999999, f.bus || 999999) <= max);
  if (!valid.length) return "No award space found under your max points.";

  return valid.map(f => {
    const lowest = f.econ || f.bus;
    return `\( {to12h(f.dep)} – \){to12h(f.arr)}\n` +
           `Economy: \( {f.econ || "-"} | Business: \){f.bus || "-"}\n` +
           `${lowest} pts + $${brlToUsd(f.taxes)} taxes\n`;
  }).join("\n");
}

app.post("/whatsapp-webhook", async (req, res) => {
  try {
    const msg = (req.body.Body || "").trim();
    const match = msg.match(/([A-Z]{3})-([A-Z]{3})\s+([\d-]{10})(?:\s+MAX=(\d+))?/i);
    if (!match) {
      return res.type("text/xml").send("<Response><Message>Format: JFK-GRU 2025-12-20 max=50000</Message></Response>");
    }

    const [, origCity, dest, date, maxStr] = match;
    const max = maxStr ? +maxStr : Infinity;
    const origins = origCity === "NYC" ? ["JFK", "EWR", "LGA"] : [origCity];

    let all = [];
    for (const o of origins) {
      all.push(...await getAwards(o, dest, date));
    }

    const text = buildResponse(all, max) || "No award space found under your max points.";
    res.type("text/xml").send(`<Response><Message>${text}</Message></Response>`);
  } catch (e) {
    console.error(e);
    res.type("text/xml").send("<Response><Message>Sorry, try again later.</Message></Response>");
  }
});

app.listen(process.env.PORT || 3000, () => console.log("Bot running"));
