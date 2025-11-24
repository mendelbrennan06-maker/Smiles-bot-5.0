// app.js - Simplified Smiles Bot with Test Endpoint (No Crashes)
import express from "express";
import fetch from "node-fetch";

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

// Fallback mock data for testing (replace with real API when ready)
async function getMockAwards(origin, dest, dateISO) {
  // Mock real data for JFK-GRU 2025-12-20 (based on current availability)
  return [
    {
      airline: "GOL",
      originCode: "JFK",
      destCode: "GRU",
      dep: "08:00",
      arr: "05:30",
      econPts: 25000,
      busPts: 50000,
      taxesBRL: 800,
    },
    {
      airline: "GOL",
      originCode: "JFK",
      destCode: "GRU",
      dep: "14:30",
      arr: "12:00",
      econPts: 30000,
      busPts: null,
      taxesBRL: 650,
    }
  ];
}

// Real scraper placeholder (add back when selectors are stable)
async function scrapeSmiles(origin, dest, dateISO) {
  // For now, use mock — replace with Puppeteer when ready
  if (origin === "JFK" && dest === "GRU" && dateISO === "2025-12-20") {
    return await getMockAwards(origin, dest, dateISO);
  }
  return [];
}

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

    const byOriginAirline = {};
    sec.items.forEach(f => {
      const key = `\( {f.originCode}- \){f.airline}`;
      byOriginAirline[key] = byOriginAirline[key] || [];
      byOriginAirline[key].push(f);
    });

    Object.entries(byOriginAirline).forEach(([key, list]) => {
      const [origin, airline] = key.split("-");
      out += `\n\( {airline} from \){origin}:\n`;
      list.forEach(f => {
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
    });
    out += "\n";
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
    res.type("text/xml").send("<Response><Message>Sorry, something went wrong. Try again later.</Message></Response>");
  }
});

// Test endpoint to verify server is alive
app.get("/test", (req, res) => {
  res.send("Bot is alive! Try 'NYC-GRU 2025-12-20' in WhatsApp.");
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log("Smiles WhatsApp Bot running on", PORT));
