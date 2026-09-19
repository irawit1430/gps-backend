const DEFAULT_ZONE = 'Asia/Kolkata';
function validZone(zone) {
  try { new Intl.DateTimeFormat('en', { timeZone: zone }).format(); return true; } catch { return false; }
}
function calendarDate(value = new Date(), zone = DEFAULT_ZONE) {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: zone, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date(value));
  const get = (key) => parts.find(p => p.type === key).value;
  return `${get('year')}-${get('month')}-${get('day')}`;
}
function dateValue(value, zone = DEFAULT_ZONE) {
  if (typeof value !== 'string') return null;
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    const d = new Date(`${value}T00:00:00Z`);
    return Number.isFinite(+d) && d.toISOString().slice(0, 10) === value ? value : null;
  }
  if (!/^\d{4}-\d{2}-\d{2}T.*(?:Z|[+-]\d{2}:\d{2})$/.test(value) || !Number.isFinite(+new Date(value))) return null;
  return calendarDate(value, zone);
}
function addDate(day, count) {
  const d = new Date(`${day}T00:00:00Z`); d.setUTCDate(d.getUTCDate() + count);
  return d.toISOString().slice(0, 10);
}
function wallTime(day, time, zone = DEFAULT_ZONE) {
  const target = Date.parse(`${day}T${time}:00Z`);
  let instant = target;
  const formatter = new Intl.DateTimeFormat('en-GB', { timeZone: zone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' });
  for (let i = 0; i < 4; i++) {
    const p = Object.fromEntries(formatter.formatToParts(new Date(instant)).map(x => [x.type, x.value]));
    const rendered = Date.parse(`${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}:${p.second}Z`);
    const correction = target - rendered;
    if (!correction) return new Date(instant);
    instant += correction;
  }
  throw new Error('Local time does not exist in school timezone');
}
function dayBounds(day, zone = DEFAULT_ZONE) {
  return { start: wallTime(day, '00:00', zone), end: wallTime(addDate(day, 1), '00:00', zone) };
}
module.exports = { DEFAULT_ZONE, validZone, calendarDate, dateValue, addDate, wallTime, dayBounds };
