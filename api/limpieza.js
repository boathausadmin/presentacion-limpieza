// api/limpieza.js — Octorate real data for limpieza forecast
// Vercel serverless function (Node 20, CommonJS)

const BASE_URL = 'https://api.octorate.com/connect/rest/v1';
const ACCOMMODATION_ID = process.env.OCTORATE_ACCOMMODATION_ID || '452507';
const TOTAL_ROOMS = 18;
const HPB = 1.15; // hours per barco (limpieza)

let currentToken = null;

function getToken() {
  return currentToken || process.env.OCTORATE_ACCESS_TOKEN;
}

async function refreshToken() {
  const resp = await fetch(`${BASE_URL}/identity/refresh`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      refresh_token: process.env.OCTORATE_REFRESH_TOKEN,
      client_id: process.env.OCTORATE_CLIENT_ID,
      client_secret: process.env.OCTORATE_CLIENT_SECRET,
    }).toString(),
  });
  if (!resp.ok) throw new Error(`Token refresh failed: ${resp.status}`);
  const data = await resp.json();
  const token = data.access_token || data.accessToken;
  if (!token) throw new Error('No access_token in refresh response');
  currentToken = token;
  return token;
}

async function octoGet(path, params = {}) {
  const url = new URL(`${BASE_URL}${path}`);
  Object.entries(params).forEach(([k, v]) => url.searchParams.set(k, String(v)));

  let token = getToken();
  let resp = await fetch(url.toString(), {
    headers: { Authorization: `Bearer ${token}` },
  });

  if (resp.status === 403) {
    token = await refreshToken();
    resp = await fetch(url.toString(), {
      headers: { Authorization: `Bearer ${token}` },
    });
  }

  if (!resp.ok) throw new Error(`Octorate GET ${path} → ${resp.status}`);
  return resp.json();
}

async function fetchAllReservations(startDate, endDate) {
  const reservations = [];
  let page = 0;

  while (true) {
    const data = await octoGet(`/reservation/${ACCOMMODATION_ID}`, {
      startDate,
      endDate,
      size: 100,
      page,
    });

    // Octorate returns { data: [...] } or directly an array
    const items = Array.isArray(data) ? data : (data.data || []);
    if (!items.length) break;

    reservations.push(...items);
    page++;
    if (items.length < 100) break;
  }

  return reservations;
}

function daysInMonth(year, month) {
  return new Date(year, month, 0).getDate();
}

function getWeekdayInfo(year, month) {
  const days = daysInMonth(year, month);
  let weekdays = 0;
  let weekendDays = 0;
  for (let d = 1; d <= days; d++) {
    const dow = new Date(year, month - 1, d).getDay(); // 0=Sun, 6=Sat
    if (dow === 0 || dow === 6) weekendDays++;
    else weekdays++;
  }
  return { weekdays, weekendDays };
}

function computeMonthStats(reservations, year, month) {
  const days = daysInMonth(year, month);
  const monthStr = `${year}-${String(month).padStart(2, '0')}`;
  const { weekdays, weekendDays } = getWeekdayInfo(year, month);

  let roomNights = 0;
  let checkouts = 0;

  const monthStart = new Date(`${year}-${String(month).padStart(2, '0')}-01`);
  const monthEnd = new Date(`${year}-${String(month).padStart(2, '0')}-${String(days).padStart(2, '0')}`);
  // monthEnd is last day inclusive; for overlap calc, checkout day IS NOT a room night
  // so we use monthEnd + 1 as exclusive upper bound for room nights
  const monthEndExclusive = new Date(monthEnd);
  monthEndExclusive.setDate(monthEndExclusive.getDate() + 1);

  for (const res of reservations) {
    const status = (res.status || '').toUpperCase();
    if (status === 'CANCELLED' || status === 'CANCELED' || status === 'NO_SHOW') continue;

    const ci = res.checkin ? res.checkin.slice(0, 10) : null;
    const co = res.checkout ? res.checkout.slice(0, 10) : null;
    if (!ci || !co || ci >= co) continue;

    const ciDate = new Date(ci);
    const coDate = new Date(co);

    // Checkout falls in this month → cleaning event
    if (co.startsWith(monthStr)) {
      checkouts++;
    }

    // Room nights in this month = overlap of [ci, co) with [monthStart, monthEndExclusive)
    const overlapStart = ciDate > monthStart ? ciDate : monthStart;
    const overlapEnd = coDate < monthEndExclusive ? coDate : monthEndExclusive;

    if (overlapEnd > overlapStart) {
      const nights = Math.round((overlapEnd - overlapStart) / 86400000);
      roomNights += nights;
    }
  }

  const occ = roomNights / (TOTAL_ROOMS * days);
  const avgStay = checkouts > 0 ? roomNights / checkouts : 0;
  const cleaningsPerDay = checkouts / days;

  // LC hours needed
  // Weekday cap: Cinthia 6 + Hija 5 = 11/day. LC covers excess.
  // Weekend cap: 5/day (one person rotating). LC covers excess.
  const lcWeekday = Math.max(0, cleaningsPerDay - 11) * weekdays * HPB;
  const lcWeekend = Math.max(0, cleaningsPerDay - 5) * weekendDays * HPB;
  const lcTotal = Math.round(lcWeekday + lcWeekend);

  return {
    days,
    weekdays,
    weekendDays,
    roomNights,
    checkouts,
    occ,
    avgStay,
    cleaningsPerDay,
    lcWeekday: Math.round(lcWeekday),
    lcWeekend: Math.round(lcWeekend),
    lcTotal,
  };
}

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Cache-Control', 's-maxage=1800, stale-while-revalidate=3600');

  try {
    // Fetch wide range: Apr → Dec 2026
    // This captures any reservation checking in from April that might checkout in June+
    const reservations = await fetchAllReservations('2026-04-01', '2026-12-31');

    const months = [
      { year: 2026, month: 6,  name: 'Junio' },
      { year: 2026, month: 7,  name: 'Julio' },
      { year: 2026, month: 8,  name: 'Agosto' },
      { year: 2026, month: 9,  name: 'Septiembre' },
      { year: 2026, month: 10, name: 'Octubre' },
      { year: 2026, month: 11, name: 'Noviembre' },
      { year: 2026, month: 12, name: 'Diciembre' },
    ];

    const stats = months.map(({ year, month, name }) => ({
      name,
      ...computeMonthStats(reservations, year, month),
    }));

    // Aggregate totals
    const totalRN = stats.reduce((s, m) => s + m.roomNights, 0);
    const totalCO = stats.reduce((s, m) => s + m.checkouts, 0);
    const totalDays = stats.reduce((s, m) => s + m.days, 0);
    const totalOcc = totalRN / (TOTAL_ROOMS * totalDays);
    const totalAvg = totalCO > 0 ? totalRN / totalCO : 0;
    const lcTotal = stats.reduce((s, m) => s + m.lcTotal, 0);

    res.json({
      fetchedAt: new Date().toISOString(),
      totalReservations: reservations.length,
      months: stats,
      totals: {
        occ: totalOcc,
        roomNights: totalRN,
        checkouts: totalCO,
        avgStay: totalAvg,
        cleaningsPerDay: totalCO / totalDays,
        lcTotal,
      },
    });
  } catch (err) {
    console.error('[limpieza] error:', err.message);
    res.status(500).json({ error: err.message });
  }
};
