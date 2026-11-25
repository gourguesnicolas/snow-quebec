// Neige au Québec depuis 1990 — ERA5-Land (ECMWF) via l'API Open-Meteo.
// Script classique (sans import/export) pour fonctionner aussi en ouvrant index.html directement.

type LonLat = [number, number];
type SnowPoint = { lat: number; lon: number };
type Cell = { lat: number; lon: number; marker: L.CircleMarker; tooltipBound: boolean };
type ChunkData = { days: string[]; values: (number | null)[][] };
type PendingRequest = {
  month: string;
  chunkIndex: number;
  points: SnowPoint[];
  start: string;
  end: string;
  attempts: number;
  retryAt: number | null;
  reason: string;
  retryable: boolean;
};

// ---------- Configuration ----------
const START_DATE = "1990-01-01";
const LAG_DAYS = 6; // ERA5-Land est publié avec ~5 jours de retard
const GRID_LAT_STEP = 0.5;
const GRID_LON_STEP = 0.75;
const CHUNK = 50; // nombre de points par requête
const MAX_DEPTH_M = 1.5; // profondeur de neige = bleu le plus foncé
const ARCHIVE_URL = "https://archive-api.open-meteo.com/v1/archive";
const CACHE_PREFIX = "snow-quebec:chunk:v1:";
const CACHE_INDEX_KEY = "snow-quebec:cache-index:v1";
const PENDING_KEY = "snow-quebec:pending:v1";
const CACHE_MONTH_LIMIT = 1;

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
  for (let lat = 45.0 + GRID_LAT_STEP / 2; lat < 63; lat += GRID_LAT_STEP) {
    for (let lon = -80 + GRID_LON_STEP / 2; lon < -57; lon += GRID_LON_STEP) {
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
const inflightControllers = new Map<string, AbortController>();
let activeMonth = "";
let cacheUnavailable = false;
let pendingRequests = readPendingRequests();

async function fetchChunk(
  pts: SnowPoint[],
  start: string,
  end: string,
  signal: AbortSignal,
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
  const res = await fetch(`${ARCHIVE_URL}?${q}`, { signal });
  if (!res.ok) {
    let reason = "";
    try {
      const body: unknown = await res.json();
      if (isRecord(body) && typeof body.reason === "string") reason = body.reason;
    } catch (error) {
      console.warn("Impossible de lire le détail de l’erreur Open-Meteo.", error);
    }
    const message = `Open-Meteo ${res.status} ${reason}`.trim();
    throw new ApiRequestError(message, res.status === 429 || res.status >= 500);
  }
  const json = await res.json();
  const arr = Array.isArray(json) ? json : [json];
  return arr.map((o: { hourly: { time: string[]; snow_depth: (number | null)[] } }) => o.hourly);
}

class ApiRequestError extends Error {
  constructor(message: string, readonly retryable: boolean) {
    super(message);
    this.name = "ApiRequestError";
  }
}

class PendingRequestError extends Error {
  constructor(readonly request: PendingRequest) {
    super(request.reason);
    this.name = "PendingRequestError";
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function cacheWarning(error: unknown): void {
  if (cacheUnavailable) return;
  cacheUnavailable = true;
  console.warn("Le cache local est indisponible; les données restent accessibles en mémoire.", error);
}

function storageGet(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch (error) {
    cacheWarning(error);
    return null;
  }
}

function storageSet(key: string, value: string): void {
  try {
    localStorage.setItem(key, value);
  } catch (error) {
    cacheWarning(error);
  }
}

function storageRemove(key: string): void {
  try {
    localStorage.removeItem(key);
  } catch (error) {
    cacheWarning(error);
  }
}

function readCacheIndex(): Record<string, number> {
  const raw = storageGet(CACHE_INDEX_KEY);
  if (!raw) return {};
  try {
    const value: unknown = JSON.parse(raw);
    if (isRecord(value) && Object.values(value).every((time) => typeof time === "number")) {
      return value as Record<string, number>;
    }
    throw new Error("Index de cache invalide");
  } catch (error) {
    console.warn("L’index du cache local est invalide et sera recréé.", error);
    storageRemove(CACHE_INDEX_KEY);
    return {};
  }
}

function touchCacheMonth(month: string): void {
  const index = readCacheIndex();
  index[month] = Date.now();
  const oldest = Object.keys(index).sort((a, b) => index[a] - index[b]);
  while (oldest.length > CACHE_MONTH_LIMIT) {
    const evicted = oldest.shift();
    if (!evicted) continue;
    delete index[evicted];
    try {
      for (let i = localStorage.length - 1; i >= 0; i--) {
        const key = localStorage.key(i);
        if (key?.startsWith(`${CACHE_PREFIX}${evicted}:`)) localStorage.removeItem(key);
      }
    } catch (error) {
      cacheWarning(error);
    }
  }
  storageSet(CACHE_INDEX_KEY, JSON.stringify(index));
}

function keepOnlyCachedMonth(month: string): void {
  try {
    for (let i = localStorage.length - 1; i >= 0; i--) {
      const key = localStorage.key(i);
      if (!key?.startsWith(CACHE_PREFIX)) continue;
      const cachedMonth = key.slice(CACHE_PREFIX.length).split(":")[0];
      if (cachedMonth !== month) localStorage.removeItem(key);
    }
  } catch (error) {
    cacheWarning(error);
  }
  storageSet(CACHE_INDEX_KEY, JSON.stringify({ [month]: Date.now() }));
}

function chunkCacheKey(month: string, chunkIndex: number): string {
  return `${CACHE_PREFIX}${month}:${chunkIndex}`;
}

function isChunkData(value: unknown, pointCount: number): value is ChunkData {
  return isRecord(value)
    && Array.isArray(value.days)
    && value.days.every((day) => typeof day === "string")
    && Array.isArray(value.values)
    && value.values.length === value.days.length
    && value.values.every((row) =>
      Array.isArray(row)
      && row.length === pointCount
      && row.every((depth) => depth === null || (typeof depth === "number" && Number.isFinite(depth))),
    );
}

function readChunkCache(month: string, chunkIndex: number, pointCount: number): ChunkData | null {
  const raw = storageGet(chunkCacheKey(month, chunkIndex));
  if (!raw) return null;
  try {
    const value: unknown = JSON.parse(raw);
    if (isChunkData(value, pointCount)) return value;
    throw new Error(`Cache invalide pour ${month}, lot ${chunkIndex + 1}`);
  } catch (error) {
    console.warn("Une entrée de données en cache est invalide et sera rechargée.", error);
    storageRemove(chunkCacheKey(month, chunkIndex));
    return null;
  }
}

function writeChunkCache(month: string, chunkIndex: number, data: ChunkData): void {
  storageSet(chunkCacheKey(month, chunkIndex), JSON.stringify(data));
}

function isPendingRequest(value: unknown): value is PendingRequest {
  return isRecord(value)
    && typeof value.month === "string"
    && /^\d{4}-\d{2}$/.test(value.month)
    && typeof value.chunkIndex === "number"
    && Number.isInteger(value.chunkIndex)
    && Array.isArray(value.points)
    && value.points.every((point) =>
      isRecord(point) && typeof point.lat === "number" && typeof point.lon === "number",
    )
    && typeof value.start === "string"
    && typeof value.end === "string"
    && typeof value.attempts === "number"
    && Number.isInteger(value.attempts)
    && (value.retryAt === null || typeof value.retryAt === "number")
    && typeof value.reason === "string"
    && typeof value.retryable === "boolean";
}

function readPendingRequests(): PendingRequest[] {
  const raw = storageGet(PENDING_KEY);
  if (!raw) return [];
  try {
    const value: unknown = JSON.parse(raw);
    if (Array.isArray(value) && value.every(isPendingRequest)) return value;
    throw new Error("File des requêtes en attente invalide");
  } catch (error) {
    console.warn("La file de requêtes en attente est invalide et sera réinitialisée.", error);
    storageRemove(PENDING_KEY);
    return [];
  }
}

function savePendingRequests(): void {
  storageSet(PENDING_KEY, JSON.stringify(pendingRequests));
  schedulePendingRetry();
}

function pendingRequestFor(month: string, chunkIndex: number): PendingRequest | undefined {
  return pendingRequests.find((request) => request.month === month && request.chunkIndex === chunkIndex);
}

function removePendingRequest(month: string, chunkIndex: number): void {
  const remaining = pendingRequests.filter(
    (request) => request.month !== month || request.chunkIndex !== chunkIndex,
  );
  if (remaining.length === pendingRequests.length) return;
  pendingRequests = remaining;
  savePendingRequests();
}

function rememberFailedRequest(
  month: string,
  chunkIndex: number,
  requestPoints: SnowPoint[],
  start: string,
  end: string,
  error: unknown,
): PendingRequest {
  const previous = pendingRequestFor(month, chunkIndex);
  const attempts = (previous?.attempts ?? 0) + 1;
  const retryable = error instanceof ApiRequestError ? error.retryable : true;
  const wait = Math.min(30_000 * 2 ** Math.min(attempts - 1, 6), 30 * 60_000);
  const request: PendingRequest = {
    month,
    chunkIndex,
    points: requestPoints,
    start,
    end,
    attempts,
    retryAt: retryable ? Date.now() + wait : null,
    reason: error instanceof Error ? error.message : String(error),
    retryable,
  };
  pendingRequests = [
    ...pendingRequests.filter((item) => item.month !== month || item.chunkIndex !== chunkIndex),
    request,
  ];
  savePendingRequests();
  return request;
}

function dailyValues(hourlies: { time: string[]; snow_depth: (number | null)[] }[]): ChunkData {
  const byDay = new Map<string, (number | null)[]>();
  hourlies.forEach((hourly, pointIndex) => {
    hourly.time.forEach((time, hourIndex) => {
      if (!time.endsWith("T12:00")) return;
      const day = time.slice(0, 10);
      let values = byDay.get(day);
      if (!values) {
        values = new Array(hourlies.length).fill(null);
        byDay.set(day, values);
      }
      values[pointIndex] = hourly.snow_depth[hourIndex];
    });
  });
  const days = [...byDay.keys()];
  return { days, values: days.map((day) => byDay.get(day) ?? []) };
}

function mergeChunk(
  byDate: Map<string, (number | null)[]>,
  chunk: ChunkData,
  firstPoint: number,
): void {
  chunk.days.forEach((day, dayIndex) => {
    let row = byDate.get(day);
    if (!row) {
      row = new Array(points.length).fill(null);
      byDate.set(day, row);
    }
    chunk.values[dayIndex].forEach((value, pointIndex) => {
      row[firstPoint + pointIndex] = value;
    });
  });
}

/** Charge un mois complet (valeur de midi UTC pour chaque jour) pour tous les points. */
function loadMonth(month: string): Promise<Map<string, (number | null)[]>> {
  const cached = monthCache.get(month);
  if (cached) return Promise.resolve(cached);
  const pending = inflight.get(month);
  if (pending) return pending;

  const controller = new AbortController();
  const p = (async () => {
    const { start, end } = monthRange(month);
    const byDate = new Map<string, (number | null)[]>();
    if (activeMonth === month) touchCacheMonth(month);
    for (let c = 0; c < points.length; c += CHUNK) {
      const chunkIndex = c / CHUNK;
      const chunkPoints = points.slice(c, c + CHUNK);
      let chunk = readChunkCache(month, chunkIndex, chunkPoints.length);
      if (!chunk) {
        const pending = pendingRequestFor(month, chunkIndex);
        if (pending && (pending.retryAt === null || pending.retryAt > Date.now())) {
          throw new PendingRequestError(pending);
        }
        try {
          const hourlies = await fetchChunk(
            pending?.points ?? chunkPoints,
            pending?.start ?? start,
            pending?.end ?? end,
            controller.signal,
          );
          chunk = dailyValues(hourlies);
          if (activeMonth === month) writeChunkCache(month, chunkIndex, chunk);
          removePendingRequest(month, chunkIndex);
        } catch (error) {
          if (error instanceof Error && error.name === "AbortError") throw error;
          rememberFailedRequest(month, chunkIndex, chunkPoints, start, end, error);
          throw error;
        }
      } else {
        removePendingRequest(month, chunkIndex);
      }
      mergeChunk(byDate, chunk, c);
    }
    if (activeMonth === month) monthCache.set(month, byDate);
    return byDate;
  })();
  inflight.set(month, p);
  inflightControllers.set(month, controller);
  p.then(
    () => {
      if (inflight.get(month) === p) inflight.delete(month);
      if (inflightControllers.get(month) === controller) inflightControllers.delete(month);
    },
    () => {
      if (inflight.get(month) === p) inflight.delete(month);
      if (inflightControllers.get(month) === controller) inflightControllers.delete(month);
    },
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
const dateFormatter = new Intl.DateTimeFormat("fr-CA", {
  day: "numeric",
  month: "long",
  year: "numeric",
  timeZone: "UTC",
});

const map = L.map("map", { zoomControl: false, minZoom: 3, maxZoom: 9 });
L.control.zoom({ position: "topright" }).addTo(map);
L.control.scale({ position: "bottomright", imperial: false }).addTo(map);
L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
  attribution: "&copy; OpenStreetMap contributors",
}).addTo(map);
map.fitBounds([[45, -79.8], [62.6, -57]]);

const snowRenderer = L.canvas({ padding: 0.5 });
const cellsLayer = L.layerGroup().addTo(map);
const cells: Cell[] = points.map((p) => {
  const marker = L.circleMarker([p.lat, p.lon], {
    radius: 6,
    stroke: false,
    fillColor: "#9ecae1",
    fillOpacity: 0,
    renderer: snowRenderer,
  }).addTo(cellsLayer);
  return { ...p, marker, tooltipBound: false };
});
function resizeMarkers(): void {
  const radius = Math.min(14, 6 + (map.getZoom() - 3) * 1.5);
  cells.forEach((cell) => cell.marker.setStyle({ radius }));
}
map.on("zoomend", resizeMarkers);
resizeMarkers();

L.polygon(QUEBEC.map(([lon, lat]) => [lat, lon] as [number, number]), {
  fill: false, color: "#fff", weight: 2, opacity: 0.9, interactive: false,
}).addTo(map);

const slider = $("slider") as HTMLInputElement;
const dateLabel = $("date-label");
const datePicker = $("date-picker") as HTMLInputElement;
const statusEl = $("status");
const retryButton = $("retry-button") as HTMLButtonElement;
slider.max = String(totalDays);
datePicker.min = START_DATE;
datePicker.max = maxDate;

// Évite que le panneau déclenche le déplacement / zoom de la carte.
const panel = $("panel");
["mousedown", "dblclick", "wheel", "touchstart", "pointerdown", "click"].forEach((event) => {
  panel.addEventListener(event, (e) => e.stopPropagation(), { passive: true });
  $("legend").addEventListener(event, (e) => e.stopPropagation(), { passive: true });
});

// Légende
const legendBar = $("legend-bar");
legendBar.style.background = `linear-gradient(to right, ${[0, 0.1, 0.25, 0.5, 0.75, 1]
  .map((f) => snowColor(f * MAX_DEPTH_M))
  .join(",")})`;
$("legend-max").textContent = `${Math.round(MAX_DEPTH_M * 100)} cm +`;

let current = "";
let renderToken = 0;
let retryTimer: number | undefined;

function activateMonth(month: string): void {
  if (activeMonth === month) return;
  activeMonth = month;
  monthCache.clear();

  for (const [inflightMonth, controller] of inflightControllers) {
    if (inflightMonth === month) continue;
    controller.abort();
    inflightControllers.delete(inflightMonth);
    inflight.delete(inflightMonth);
  }

  keepOnlyCachedMonth(month);
  const remainingRequests = pendingRequests.filter((request) => request.month === month);
  if (remainingRequests.length !== pendingRequests.length) {
    pendingRequests = remainingRequests;
    savePendingRequests();
  }
}

function paint(day: string, rows: Map<string, (number | null)[]>): void {
  const row = rows.get(day);
  cells.forEach((c, i) => {
    const v = row ? row[i] : null;
    const tooltip = v == null ? `${day} : pas de donnée` : `${day} : ${(v * 100).toFixed(0)} cm de neige au sol`;
    c.marker.setStyle(v == null
      ? { fillOpacity: 0 }
      : { fillColor: snowColor(v), fillOpacity: v < 0.005 ? 0.2 : 0.78 });
    if (c.tooltipBound) {
      c.marker.setTooltipContent(tooltip);
    } else {
      c.marker.bindTooltip(tooltip);
      c.tooltipBound = true;
    }
  });
}

function updateDateControls(day: string): void {
  dateLabel.textContent = dateFormatter.format(new Date(`${day}T00:00:00Z`));
  datePicker.value = day;
  slider.value = String(daysBetween(START_DATE, day));
  $("prev").toggleAttribute("disabled", day <= START_DATE);
  $("next").toggleAttribute("disabled", day >= maxDate);
}

function retryDescription(request: PendingRequest): string {
  if (request.retryAt === null) return "Réessai manuel requis.";
  const seconds = Math.max(1, Math.ceil((request.retryAt - Date.now()) / 1000));
  if (seconds < 60) return `Nouvel essai automatique dans ${seconds} s.`;
  return `Nouvel essai automatique dans ${Math.ceil(seconds / 60)} min.`;
}

function displayFailure(day: string, error: unknown): void {
  const request = pendingRequests.find((item) => item.month === monthOf(day));
  const reason = error instanceof Error ? error.message : String(error);
  const savedMessage = cacheUnavailable
    ? "Requête conservée en mémoire seulement; cache local indisponible."
    : "Requête conservée.";
  statusEl.dataset.state = "error";
  statusEl.textContent = request
    ? `${reason}. ${savedMessage} ${retryDescription(request)}`
    : `${reason}. La requête n’a pas pu être mise en attente.`;
  retryButton.hidden = !request;
}

function schedulePendingRetry(): void {
  if (retryTimer !== undefined) window.clearTimeout(retryTimer);
  retryTimer = undefined;
  const next = pendingRequests
    .filter((request) => request.retryable && request.retryAt !== null)
    .sort((a, b) => (a.retryAt ?? 0) - (b.retryAt ?? 0))[0];
  if (!next || next.retryAt === null) return;

  retryTimer = window.setTimeout(() => {
    retryTimer = undefined;
    if (!navigator.onLine) {
      next.retryAt = Date.now() + 60_000;
      storageSet(PENDING_KEY, JSON.stringify(pendingRequests));
      schedulePendingRetry();
      return;
    }

    next.retryAt = Date.now();
    storageSet(PENDING_KEY, JSON.stringify(pendingRequests));
    void loadMonth(next.month).then((rows) => {
      if (monthOf(current) !== next.month) return;
      paint(current, rows);
      statusEl.dataset.state = "";
      statusEl.textContent = cacheUnavailable ? "Le cache local est indisponible." : "";
      retryButton.hidden = true;
    }).catch((error: unknown) => {
      if (monthOf(current) === next.month) displayFailure(current, error);
    });
  }, Math.max(0, next.retryAt - Date.now()));
}

function retryCurrentMonth(): void {
  const month = monthOf(current);
  const request = pendingRequests.find((item) => item.month === month);
  if (!request) return;
  request.retryAt = Date.now();
  storageSet(PENDING_KEY, JSON.stringify(pendingRequests));
  if (retryTimer !== undefined) window.clearTimeout(retryTimer);
  retryTimer = undefined;
  void show(current);
}

async function show(day: string): Promise<void> {
  activateMonth(monthOf(day));
  current = day;
  updateDateControls(day);
  const token = ++renderToken;
  statusEl.dataset.state = "";
  statusEl.textContent = monthCache.has(monthOf(day)) ? "" : "Chargement des données…";
  const pending = pendingRequests.find((item) => item.month === monthOf(day));
  retryButton.hidden = !pending;
  if (pending) statusEl.textContent = retryDescription(pending);
  try {
    const rows = await loadMonth(monthOf(day));
    if (token !== renderToken) return;
    paint(day, rows);
    statusEl.dataset.state = "";
    statusEl.textContent = cacheUnavailable ? "Le cache local est indisponible." : "";
    retryButton.hidden = true;
  } catch (err) {
    if (token !== renderToken) return;
    displayFailure(day, err);
  }
}

const dayFromSlider = () => addDays(START_DATE, Number(slider.value));
slider.addEventListener("input", () => {
  const day = dayFromSlider();
  dateLabel.textContent = dateFormatter.format(new Date(`${day}T00:00:00Z`));
  datePicker.value = day;
});
slider.addEventListener("change", () => void show(dayFromSlider()));
$("prev").addEventListener("click", () => step(-1));
$("next").addEventListener("click", () => step(1));
datePicker.addEventListener("change", () => {
  if (datePicker.value >= START_DATE && datePicker.value <= maxDate) void show(datePicker.value);
});
retryButton.addEventListener("click", retryCurrentMonth);

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
updateDateControls(startDay);
schedulePendingRetry();
void show(startDay);

// Exposé pour les tests.
(window as unknown as { __snow: object }).__snow = {
  snowColor,
  pointInPolygon,
  points,
  current: () => current,
  pendingRequests: () => pendingRequests,
};
