// Neige au Québec depuis 1990 — ERA5-Land (ECMWF) via l'API Open-Meteo.
// Script classique (sans import/export) pour fonctionner aussi en ouvrant index.html directement.

type LonLat = [number, number];
type Cell = { lat: number; lon: number; rect: L.Rectangle };

// ---------- Configuration ----------
const START_DATE = "1990-01-01";
const LAG_DAYS = 6; // ERA5-Land est publié avec ~5 jours de retard
const CELL_LAT = 1.0; // hauteur d'une cellule (degrés)
const CELL_LON = 1.5; // largeur d'une cellule (degrés)
const CHUNK = 50; // nombre de points par requête
const MAX_DEPTH_M = 1.5; // profondeur de neige = bleu le plus foncé
const ARCHIVE_URL = "https://archive-api.open-meteo.com/v1/archive";

// Contour APPROXIMATIF du Québec (lon, lat), tracé à la main : sert à filtrer la grille.
const QUEBEC: LonLat[] = [
  [-79.5, 46.9], [-79.5, 51.3], [-78.9, 51.6], [-78.8, 52.3], [-79.1, 53.2], [-78.9, 54.0],
  [-79.2, 54.9], [-77.7, 55.3], [-77.4, 56.5], [-78.1, 58.3], [-77.6, 59.5], [-77.3, 60.2],
  [-77.9, 62.4], [-76.0, 62.4], [-73.5, 62.2], [-71.8, 61.6], [-69.6, 61.0], [-69.8, 59.6],
  [-69.6, 58.8], [-68.3, 58.2], [-67.0, 58.6], [-65.6, 59.2], [-64.4, 60.3], [-64.7, 58.9],
  [-63.5, 57.4], [-64.6, 56.0], [-65.4, 54.7], [-64.3, 53.9], [-62.0, 53.5], [-60.4, 52.3],
  [-57.1, 52.0], [-57.1, 51.4], [-59.5, 50.4], [-61.8, 50.2], [-63.6, 50.2], [-66.4, 50.2],
  [-68.1, 49.2], [-69.7, 48.1], [-69.0, 48.4], [-67.5, 48.9], [-65.0, 49.2], [-64.2, 48.8],
  [-64.3, 48.3], [-65.5, 48.0], [-66.8, 48.0], [-67.8, 47.9], [-68.4, 47.3], [-69.2, 47.45],
  [-70.0, 46.5], [-70.3, 45.9], [-71.0, 45.3], [-71.5, 45.0], [-74.7, 45.0], [-74.5, 45.5],
  [-75.7, 45.4], [-77.1, 45.8], [-78.7, 46.3], [-79.5, 46.9],
];

// ---------- Utilitaires ----------
function pointInPolygon(lon: number, lat: number, poly: LonLat[]): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i];
    const [xj, yj] = poly[j];
    if (yi > lat !== yj > lat && lon < ((xj - xi) * (lat - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

function buildGrid(): { lat: number; lon: number }[] {
  const pts: { lat: number; lon: number }[] = [];
  for (let lat = 45.0 + CELL_LAT / 2; lat < 63; lat += CELL_LAT) {
    for (let lon = -80 + CELL_LON / 2; lon < -57; lon += CELL_LON) {
      if (pointInPolygon(lon, lat, QUEBEC)) pts.push({ lat, lon });
    }
  }
  return pts;
}

const BLUES = ["#eef6fc", "#c6dbef", "#9ecae1", "#6baed6", "#3182bd", "#08519c", "#08306b"];

function hexToRgb(h: string): [number, number, number] {
  return [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16)];
}

/** Profondeur (m) -> couleur : de très pâle (peu) à bleu marine (beaucoup). */
function snowColor(depthM: number): string {
  const t = Math.sqrt(Math.min(Math.max(depthM, 0) / MAX_DEPTH_M, 1)); // sqrt : détaille les faibles épaisseurs
  const x = t * (BLUES.length - 1);
  const i = Math.min(Math.floor(x), BLUES.length - 2);
  const f = x - i;
  const a = hexToRgb(BLUES[i]);
  const b = hexToRgb(BLUES[i + 1]);
  const c = a.map((v, k) => Math.round(v + (b[k] - v) * f));
  return `rgb(${c[0]},${c[1]},${c[2]})`;
}

const DAY_MS = 86_400_000;
const isoDate = (d: Date) => d.toISOString().slice(0, 10);
const addDays = (iso: string, n: number) => isoDate(new Date(Date.parse(iso + "T00:00:00Z") + n * DAY_MS));
const daysBetween = (a: string, b: string) => Math.round((Date.parse(b) - Date.parse(a)) / DAY_MS);
const monthOf = (iso: string) => iso.slice(0, 7);

function monthRange(month: string): { start: string; end: string } {
  const [y, m] = month.split("-").map(Number);
  const start = `${month}-01`;
  const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return { start, end: `${month}-${String(last).padStart(2, "0")}` };
}

// ---------- Données ----------
const points = buildGrid();
const monthCache = new Map<string, Map<string, (number | null)[]>>(); // mois -> date -> profondeur par point
const inflight = new Map<string, Promise<Map<string, (number | null)[]>>>();

async function fetchChunk(
  pts: { lat: number; lon: number }[],
  start: string,
  end: string,
): Promise<{ time: string[]; snow_depth: (number | null)[] }[]> {
  const q = new URLSearchParams({
    latitude: pts.map((p) => p.lat).join(","),
    longitude: pts.map((p) => p.lon).join(","),
    start_date: start,
    end_date: end,
    hourly: "snow_depth",
    models: "era5_land",
    timezone: "UTC",
  });
  const res = await fetch(`${ARCHIVE_URL}?${q}`);
  if (!res.ok) {
    let reason = "";
    try {
      reason = (await res.json()).reason ?? "";
    } catch {
      /* ignore */
    }
    throw new Error(`Open-Meteo ${res.status} ${reason}`.trim());
  }
  const json = await res.json();
  const arr = Array.isArray(json) ? json : [json];
  return arr.map((o: { hourly: { time: string[]; snow_depth: (number | null)[] } }) => o.hourly);
}

/** Charge un mois complet (valeur de midi UTC pour chaque jour) pour tous les points. */
function loadMonth(month: string): Promise<Map<string, (number | null)[]>> {
  const cached = monthCache.get(month);
  if (cached) return Promise.resolve(cached);
  const pending = inflight.get(month);
  if (pending) return pending;

  const p = (async () => {
    const { start, end } = monthRange(month);
    const byDate = new Map<string, (number | null)[]>();
    for (let c = 0; c < points.length; c += CHUNK) {
      const hourlies = await fetchChunk(points.slice(c, c + CHUNK), start, end);
      hourlies.forEach((h, k) => {
        h.time.forEach((t, i) => {
          if (!t.endsWith("T12:00")) return;
          const day = t.slice(0, 10);
          let row = byDate.get(day);
          if (!row) {
            row = new Array(points.length).fill(null);
            byDate.set(day, row);
          }
          row[c + k] = h.snow_depth[i];
        });
      });
    }
    monthCache.set(month, byDate);
    return byDate;
  })();
  inflight.set(month, p);
  p.then(
    () => inflight.delete(month),
    () => inflight.delete(month),
  );
  return p;
}

// ---------- Interface ----------
function $(id: string): HTMLElement {
  const el = document.getElementById(id);
  if (!el) throw new Error(`Élément #${id} introuvable`);
  return el;
}

const maxDate = addDays(isoDate(new Date()), -LAG_DAYS);
const totalDays = daysBetween(START_DATE, maxDate);

const map = L.map("map", { zoomControl: false, minZoom: 3, maxZoom: 9 });
L.control.zoom({ position: "topright" }).addTo(map);
L.control.scale({ position: "bottomright", imperial: false }).addTo(map);
L.tileLayer("https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png", {
  attribution: "&copy; OpenStreetMap &copy; CARTO | Neige : ERA5-Land (Copernicus/ECMWF) via Open-Meteo",
  subdomains: "abcd",
}).addTo(map);
map.fitBounds([[45, -79.8], [62.6, -57]]);

const cellsLayer = L.layerGroup().addTo(map);
const cells: Cell[] = points.map((p) => {
  const rect = L.rectangle(
    [[p.lat - CELL_LAT / 2, p.lon - CELL_LON / 2], [p.lat + CELL_LAT / 2, p.lon + CELL_LON / 2]],
    { stroke: false, fillColor: "#eef6fc", fillOpacity: 0.0 },
  ).addTo(cellsLayer);
  return { ...p, rect };
});
L.polygon(QUEBEC.map(([lon, lat]) => [lat, lon] as [number, number]), {
  fill: false, color: "#334155", weight: 1.2, interactive: false,
}).addTo(map);

const slider = $("slider") as HTMLInputElement;
const dateLabel = $("date-label");
const statusEl = $("status");
slider.max = String(totalDays);
slider.value = String(totalDays);

// Évite que le panneau déclenche le déplacement / zoom de la carte.
const panel = $("panel");
["mousedown", "dblclick", "wheel", "touchstart", "pointerdown", "click"].forEach((ev) =>
  panel.addEventListener(ev, (e) => e.stopPropagation(), { passive: true }),
);

// Légende
const legendBar = $("legend-bar");
legendBar.style.background = `linear-gradient(to right, ${[0, 0.1, 0.25, 0.5, 0.75, 1]
  .map((f) => snowColor(f * MAX_DEPTH_M))
  .join(",")})`;
$("legend-max").textContent = `${Math.round(MAX_DEPTH_M * 100)} cm +`;

let current = "";
let renderToken = 0;

function paint(day: string, rows: Map<string, (number | null)[]>): void {
  const row = rows.get(day);
  cells.forEach((c, i) => {
    const v = row ? row[i] : null;
    if (v == null) {
      c.rect.setStyle({ fillOpacity: 0 });
      c.rect.bindTooltip(`${day} : pas de donnée`);
      return;
    }
    c.rect.setStyle({ fillColor: snowColor(v), fillOpacity: v < 0.005 ? 0.12 : 0.8 });
    c.rect.bindTooltip(`${day} : ${(v * 100).toFixed(0)} cm de neige au sol`);
  });
}

async function show(day: string): Promise<void> {
  current = day;
  dateLabel.textContent = day;
  const token = ++renderToken;
  statusEl.textContent = monthCache.has(monthOf(day)) ? "" : "Chargement…";
  try {
    const rows = await loadMonth(monthOf(day));
    if (token !== renderToken) return; // une date plus récente a été demandée
    paint(day, rows);
    statusEl.textContent = "";
    // Précharge le mois suivant en arrière-plan.
    const next = monthOf(addDays(monthRange(monthOf(day)).end, 1));
    if (next <= monthOf(maxDate) && !monthCache.has(next)) void loadMonth(next).catch(() => undefined);
  } catch (err) {
    if (token !== renderToken) return;
    statusEl.textContent = `Erreur : ${(err as Error).message}. Limite de l'API gratuite ou réseau — réessaie plus tard.`;
  }
}

const dayFromSlider = () => addDays(START_DATE, Number(slider.value));
slider.addEventListener("input", () => (dateLabel.textContent = dayFromSlider())); // aperçu pendant le glissement
slider.addEventListener("change", () => void show(dayFromSlider())); // chargement au relâchement
$("prev").addEventListener("click", () => step(-1));
$("next").addEventListener("click", () => step(1));
$("prev-year").addEventListener("click", () => step(-365));
$("next-year").addEventListener("click", () => step(365));

function step(n: number): void {
  const v = Math.min(Math.max(Number(slider.value) + n, 0), totalDays);
  slider.value = String(v);
  void show(dayFromSlider());
}

// Date de départ : pic hivernal le plus récent (15 février), sinon la dernière date disponible.
function defaultDay(): string {
  const y = new Date().getUTCFullYear();
  const feb = `${y}-02-15`;
  return feb <= maxDate ? feb : `${y - 1}-02-15`;
}
const startDay = defaultDay();
slider.value = String(daysBetween(START_DATE, startDay));
void show(startDay);

// Exposé pour les tests.
(window as unknown as { __snow: object }).__snow = { snowColor, pointInPolygon, points, current: () => current };
