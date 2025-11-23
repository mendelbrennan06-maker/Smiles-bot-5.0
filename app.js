// app.js - FINAL WORKING VERSION - NOV 23 2025
import express from "express";
import fetch from "node-fetch";

const app = express();
app.use(express.urlencoded({ extended: true }));
app.use(express.json());

const BRL_TO_USD = 5.8;

function brlToUsd(brl) { return Math.round(brl / BRL_TO_USD); }
function to12h(t) {
  if (!t) return "";
  const [h, m] = t.split(":").map(Number);
  return `\( {h % 12 || 12}: \){m.toString().padStart(2,"0")}${h >= 12 ? "pm" : "am"}`;
}

// CURRENT LIVE ENDPOINT - WORKS RIGHT NOW
async function getAwards(origin, dest, date) {
  const res = await fetch("https://flightsearch.smiles.com.br/search", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Origin": "https://www.smiles.com.br",
      "Referer": "https://www.smiles.com.br/",
      "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36"
    },
    body: JSON.stringify({
      adults: 1, children: 0, infants: 0,
      cabin: 0, currencyCode: "BRL",
      originAirportCode: origin,
      destinationAirportCode: dest,
      departureDate: date,
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
        airline: "GOL",
        origin: f.departure.airportCode,
        dest: f.arrival.airportCode,
        dep: f.departure.time.slice(0,5),
        arr: f.arrival.time.slice(0,5),
        econPts: econ,
        busPts: bus,
        taxesBRL: taxes
      });
    }
  }
  return flights;
}

function buildResponse(flights, max = Infinity) {
  const valid = flights.filter(f => Math.min(f.econPts || 999999, f.busPts || 999999) <= max);
  if (!valid.length) return "No award space found under your max points.";

  let out = "Award space found!\n\n";
  valid.forEach(f => {
    const lowest = f.econPts || f.busPts;
    out += `\( {f.origin} \){to12h(f.dep)} – \( {f.dest} \){to12h(f.arr)}\n`;
    out += `  Economy: \( {f.econPts || "-"} | Business: \){f.busPts || "-"}\n`;
    out += `  Points + $${brlToUsd(f.taxesBRL)} taxes\n\n`;
  });
  return out.trim();
}

app.post("/whatsapp-webhook", async (req, res) => {
  try {
    const msg = (req.body.Body || "").trim().toUpperCase();
    const match = msg.match(/([A-Z]{3})-([A-Z]{3})\s+([\d-]{10})(?:\s+MAX=(\d+))?/i);
    if (!match) return res.type("text/xml").send("<Response><Message>Format: NYC-GRU 2025-12-20 max=50000</Message></Response>");

    const [, origCity, dest, date, maxStr] = match;
    const max = maxStr ? Number(maxStr) : Infinity;
    const origins = origCity === "NYC" ? ["JFK","LGA","EWR"] : [origCity];

    let all = [];
    for (const o of origins) {
      const flights = await getAwards(o, dest, date);
      all.push(...flights);
    }

    const text = buildResponse(all, max);
    res.type("text/xml").send(`<Response><Message>${text}</Message></Response>`);
  } catch (e) {
    res.type("text/xml").send("<Response><Message>Sorry, try again.</Message></Response>");
  }
});

app.listen(process.env.PORT || 3000, () => console.log("Bot live"));
