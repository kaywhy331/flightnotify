/**
 * Airport suggestions for the tracker form.
 *
 * A curated list rather than a lookup API: a `<datalist>` costs a few KB
 * inlined into the form page, works with JavaScript disabled, and is advisory
 * only -- the input still accepts any IATA code, so an omission here never
 * blocks a tracker. The list is sized for a US-based leisure traveler: every
 * large US hub, the vacation destinations they actually fly to, and the major
 * international gateways.
 *
 * `label` is display-only ("City – Airport Name (CODE)"); `code` is what the
 * form submits.
 */

import { escapeHtml } from "./html.js";

export interface AirportSuggestion {
  readonly code: string;
  readonly label: string;
}

export const AIRPORTS: readonly AirportSuggestion[] = [
  // United States -- large hubs.
  { code: "ATL", label: "Atlanta – Hartsfield–Jackson Atlanta International (ATL)" },
  { code: "AUS", label: "Austin – Austin–Bergstrom International (AUS)" },
  { code: "BNA", label: "Nashville – Nashville International (BNA)" },
  { code: "BOS", label: "Boston – Logan International (BOS)" },
  { code: "BWI", label: "Baltimore – Baltimore/Washington International (BWI)" },
  { code: "CLT", label: "Charlotte – Charlotte Douglas International (CLT)" },
  { code: "DAL", label: "Dallas – Dallas Love Field (DAL)" },
  { code: "DCA", label: "Washington – Ronald Reagan Washington National (DCA)" },
  { code: "DEN", label: "Denver – Denver International (DEN)" },
  { code: "DFW", label: "Dallas – Dallas/Fort Worth International (DFW)" },
  { code: "DTW", label: "Detroit – Detroit Metropolitan Wayne County (DTW)" },
  { code: "EWR", label: "Newark – Newark Liberty International (EWR)" },
  { code: "FLL", label: "Fort Lauderdale – Fort Lauderdale–Hollywood International (FLL)" },
  { code: "HOU", label: "Houston – William P. Hobby (HOU)" },
  { code: "IAD", label: "Washington – Washington Dulles International (IAD)" },
  { code: "IAH", label: "Houston – George Bush Intercontinental (IAH)" },
  { code: "JFK", label: "New York – John F. Kennedy International (JFK)" },
  { code: "LAS", label: "Las Vegas – Harry Reid International (LAS)" },
  { code: "LAX", label: "Los Angeles – Los Angeles International (LAX)" },
  { code: "LGA", label: "New York – LaGuardia (LGA)" },
  { code: "MCI", label: "Kansas City – Kansas City International (MCI)" },
  { code: "MCO", label: "Orlando – Orlando International (MCO)" },
  { code: "MDW", label: "Chicago – Chicago Midway International (MDW)" },
  { code: "MIA", label: "Miami – Miami International (MIA)" },
  { code: "MSP", label: "Minneapolis – Minneapolis–Saint Paul International (MSP)" },
  { code: "MSY", label: "New Orleans – Louis Armstrong New Orleans International (MSY)" },
  { code: "ORD", label: "Chicago – O'Hare International (ORD)" },
  { code: "PDX", label: "Portland – Portland International (PDX)" },
  { code: "PHL", label: "Philadelphia – Philadelphia International (PHL)" },
  { code: "PHX", label: "Phoenix – Phoenix Sky Harbor International (PHX)" },
  { code: "RDU", label: "Raleigh–Durham – Raleigh–Durham International (RDU)" },
  { code: "RSW", label: "Fort Myers – Southwest Florida International (RSW)" },
  { code: "SAN", label: "San Diego – San Diego International (SAN)" },
  { code: "SEA", label: "Seattle – Seattle–Tacoma International (SEA)" },
  { code: "SFO", label: "San Francisco – San Francisco International (SFO)" },
  { code: "SJC", label: "San Jose – San Jose Mineta International (SJC)" },
  { code: "SLC", label: "Salt Lake City – Salt Lake City International (SLC)" },
  { code: "SMF", label: "Sacramento – Sacramento International (SMF)" },
  { code: "SNA", label: "Orange County – John Wayne (SNA)" },
  { code: "STL", label: "St. Louis – St. Louis Lambert International (STL)" },
  { code: "TPA", label: "Tampa – Tampa International (TPA)" },
  // United States -- leisure and regional.
  { code: "ABQ", label: "Albuquerque – Albuquerque International Sunport (ABQ)" },
  { code: "ANC", label: "Anchorage – Ted Stevens Anchorage International (ANC)" },
  { code: "HNL", label: "Honolulu – Daniel K. Inouye International (HNL)" },
  { code: "KOA", label: "Kona – Ellison Onizuka Kona International (KOA)" },
  { code: "LIH", label: "Kauai – Lihue (LIH)" },
  { code: "OGG", label: "Maui – Kahului (OGG)" },
  { code: "PBI", label: "West Palm Beach – Palm Beach International (PBI)" },
  // Canada.
  { code: "YUL", label: "Montreal – Montréal–Trudeau International (YUL)" },
  { code: "YVR", label: "Vancouver – Vancouver International (YVR)" },
  { code: "YYC", label: "Calgary – Calgary International (YYC)" },
  { code: "YYZ", label: "Toronto – Toronto Pearson International (YYZ)" },
  // Mexico.
  { code: "CUN", label: "Cancún – Cancún International (CUN)" },
  { code: "GDL", label: "Guadalajara – Miguel Hidalgo y Costilla International (GDL)" },
  { code: "MEX", label: "Mexico City – Benito Juárez International (MEX)" },
  { code: "PVR", label: "Puerto Vallarta – Licenciado Gustavo Díaz Ordaz International (PVR)" },
  { code: "SJD", label: "Los Cabos – Los Cabos International (SJD)" },
  // Caribbean.
  { code: "AUA", label: "Aruba – Queen Beatrix International (AUA)" },
  { code: "MBJ", label: "Montego Bay – Sangster International (MBJ)" },
  { code: "NAS", label: "Nassau – Lynden Pindling International (NAS)" },
  { code: "PUJ", label: "Punta Cana – Punta Cana International (PUJ)" },
  { code: "SJU", label: "San Juan – Luis Muñoz Marín International (SJU)" },
  { code: "STT", label: "St. Thomas – Cyril E. King (STT)" },
  { code: "SXM", label: "St. Maarten – Princess Juliana International (SXM)" },
  // Central America.
  { code: "LIR", label: "Liberia – Daniel Oduber Quirós International (LIR)" },
  { code: "PTY", label: "Panama City – Tocumen International (PTY)" },
  { code: "SJO", label: "San José – Juan Santamaría International (SJO)" },
  // South America.
  { code: "BOG", label: "Bogotá – El Dorado International (BOG)" },
  { code: "EZE", label: "Buenos Aires – Ministro Pistarini International (EZE)" },
  { code: "GRU", label: "São Paulo – São Paulo/Guarulhos International (GRU)" },
  { code: "LIM", label: "Lima – Jorge Chávez International (LIM)" },
  { code: "SCL", label: "Santiago – Arturo Merino Benítez International (SCL)" },
  // Europe.
  { code: "AMS", label: "Amsterdam – Amsterdam Airport Schiphol (AMS)" },
  { code: "ATH", label: "Athens – Athens International (ATH)" },
  { code: "BCN", label: "Barcelona – Barcelona–El Prat (BCN)" },
  { code: "BER", label: "Berlin – Berlin Brandenburg (BER)" },
  { code: "CDG", label: "Paris – Charles de Gaulle (CDG)" },
  { code: "CPH", label: "Copenhagen – Copenhagen Airport (CPH)" },
  { code: "DUB", label: "Dublin – Dublin Airport (DUB)" },
  { code: "FCO", label: "Rome – Leonardo da Vinci–Fiumicino (FCO)" },
  { code: "FRA", label: "Frankfurt – Frankfurt Airport (FRA)" },
  { code: "IST", label: "Istanbul – Istanbul Airport (IST)" },
  { code: "KEF", label: "Reykjavík – Keflavík International (KEF)" },
  { code: "LGW", label: "London – Gatwick (LGW)" },
  { code: "LHR", label: "London – Heathrow (LHR)" },
  { code: "LIS", label: "Lisbon – Humberto Delgado (LIS)" },
  { code: "MAD", label: "Madrid – Adolfo Suárez Madrid–Barajas (MAD)" },
  { code: "MUC", label: "Munich – Munich Airport (MUC)" },
  { code: "MXP", label: "Milan – Milan Malpensa (MXP)" },
  { code: "VCE", label: "Venice – Venice Marco Polo (VCE)" },
  { code: "VIE", label: "Vienna – Vienna International (VIE)" },
  { code: "ZRH", label: "Zurich – Zurich Airport (ZRH)" },
  // Asia-Pacific.
  { code: "BKK", label: "Bangkok – Suvarnabhumi (BKK)" },
  { code: "DEL", label: "Delhi – Indira Gandhi International (DEL)" },
  { code: "DPS", label: "Bali – I Gusti Ngurah Rai International (DPS)" },
  { code: "HKG", label: "Hong Kong – Hong Kong International (HKG)" },
  { code: "HKT", label: "Phuket – Phuket International (HKT)" },
  { code: "HND", label: "Tokyo – Haneda (HND)" },
  { code: "ICN", label: "Seoul – Incheon International (ICN)" },
  { code: "KIX", label: "Osaka – Kansai International (KIX)" },
  { code: "MNL", label: "Manila – Ninoy Aquino International (MNL)" },
  { code: "NRT", label: "Tokyo – Narita International (NRT)" },
  { code: "PEK", label: "Beijing – Beijing Capital International (PEK)" },
  { code: "PVG", label: "Shanghai – Shanghai Pudong International (PVG)" },
  { code: "SIN", label: "Singapore – Singapore Changi (SIN)" },
  { code: "TPE", label: "Taipei – Taiwan Taoyuan International (TPE)" },
  // Middle East.
  { code: "AUH", label: "Abu Dhabi – Zayed International (AUH)" },
  { code: "DOH", label: "Doha – Hamad International (DOH)" },
  { code: "DXB", label: "Dubai – Dubai International (DXB)" },
  { code: "TLV", label: "Tel Aviv – Ben Gurion (TLV)" },
  // Africa.
  { code: "CAI", label: "Cairo – Cairo International (CAI)" },
  { code: "CPT", label: "Cape Town – Cape Town International (CPT)" },
  { code: "JNB", label: "Johannesburg – O. R. Tambo International (JNB)" },
  // Oceania.
  { code: "AKL", label: "Auckland – Auckland Airport (AKL)" },
  { code: "MEL", label: "Melbourne – Melbourne Airport (MEL)" },
  { code: "NAN", label: "Nadi – Nadi International (NAN)" },
  { code: "SYD", label: "Sydney – Sydney Kingsford Smith (SYD)" },
];

/**
 * Raw markup for the caller to wrap in `raw()`. Values are escaped even
 * though the current list is plainly safe: the invariant belongs to the
 * renderer, not to whoever edits the list next.
 */
export function renderAirportDatalist(id: string): string {
  const options = AIRPORTS.map(
    (airport) =>
      `<option value="${escapeHtml(airport.code)}" label="${escapeHtml(airport.label)}">`,
  ).join("");
  return `<datalist id="${escapeHtml(id)}">${options}</datalist>`;
}
