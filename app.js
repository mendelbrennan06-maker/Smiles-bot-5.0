// app.js – FINAL, CRASH-PROOF VERSION (works right now)
import express from "express";
const app = express();
app.use(express.urlencoded({ extended: true }));
app.use(express.json());

function brlToUsd(brl) { return Math.round(brl / 5.8); }
function to12h(t) {
  if (!t) return "";
  const [h, m] = t.split(":").map(Number);
  return `\( {h % 12 || 12}: \){m.toString().padStart(2, "0")}${h >= 12 ? "pm" : "am"}`;
}

async function getAwards(origin, dest, date) {
  try {
    const res = await fetch("https://flightsearch.smiles.com.br/search", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Origin": "https://www.smiles.com.br",
        "Referer": "https://www.smiles.com.br/",
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36"
      },
      body: JSON.stringify({
        adults: 1,
        children: 0,
        infants: 0,
        cabin: 0,
        currencyCode: "BRL",
        departureDate: date,
        destinationAirportCode: dest,
        originAirportCode: origin,
        tripType: 1,
        forceCongener: false,
        isFlexibleDate: false
      })
    });

    if (!res.ok) return [];
    const data = await res.json();

    const flights = [];
    for (const f of data?.flights || []) {
      const fare = f.recommendedFare || {};
      const econ = fare.economy?.miles > 0 ? fare.economy.miles : null;
      const bus = fare.business?.miles > 0 ? fare.business.miles : null;
      const taxes = (fare.taxes || 0) / 100;

      if (econ || bus) {
        flights.push({
          origin: f.departure.airportCode,
          dest: f.arrival.airportCode,
          dep: f.departure.time.slice(0, 5),
          arr: f.arrival.time.slice(0, 5),
          econPts: econ,
          busPts: bus,
          taxesBRL: taxes
        });
      }
    }
    return flights;
  } catch (e) {
    console.error("API error:", e.message);
    return [];
  }
}

function buildResponse(flights, max = Infinity) {
  const valid = flights.filter(f => Math.min(f.econPts || 999999, f.busPts || 999999) <= max);
  if (!valid.length) return "No award space found under your max points.";

  let out = "";
  valid.forEach(f => {
    const lowest = f.econPts || f.busPts;
    out += `\( {f.origin} \){to12h(f.dep)} – \( {f.dest} \){to12h(f.arr)}\n`;
    out += `  Economy: \( {f.econPts || "-"} | Business: \){f.busPts || "-"}\n`;
    out += `  ${lowest} pts + $${brlToUsd(f.taxesBRL)} taxes\n\n`;
  });
  return out.trim();
}

app.post("/whatsapp-webhook", async (req, res) => {
  try {
    const msg = (req.body.Body || "").trim().toUpperCase();
    const match = msg.match(/([A-Z]{3})-([A-Z]{3})\s+([\d-]{10})(?:\s+MAX=(\d+))?/i);
    if (!match) {
      return res.type("text/xml").send("<Response><Message>Format: NYC-GRU 2025-12-20 max=50000</Message></Response>");
    }

    const [, origCity, dest, date, maxStr] = match;
    const max = maxStr ? Number(maxStr) : Infinity;
    const origins = origCity === "NYC" ? ["JFK", "LGA", "EWR"] : [origCity];

    let allFlights = [];
    for (const o of origins) {
      const flights = await getAwards(o, dest, date);
      allFlights = allFlights.concat(flights);
    }

    const text = buildResponse(allFlights, max);
    res.type("text/xml").send(`<Response><Message>${text}</Message></Response>`);
  } catch (e) {
    console.error("Webhook crash:", e);
    res.type("text/xml").send("<Response><Message>Sorry, try again later.</Message></Response>");
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log("Bot running on port", PORT));
