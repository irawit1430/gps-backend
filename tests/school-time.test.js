const { calendarDate, dayBounds, dateValue, wallTime } = require('../schoolTime');

test('a UTC evening belongs to the next Indian school date', () => {
  expect(calendarDate(new Date('2026-09-18T20:00:00Z'), 'Asia/Kolkata')).toBe('2026-09-19');
});
test('legacy midnight timestamps retain their school date', () => {
  expect(dateValue('2026-09-17T18:30:00.000Z', 'Asia/Kolkata')).toBe('2026-09-18');
  expect(dateValue('2026-02-30', 'Asia/Kolkata')).toBeNull();
});
test('school day bounds work across daylight saving', () => {
  const { start, end } = dayBounds('2026-03-08', 'America/New_York');
  expect(start.toISOString()).toBe('2026-03-08T05:00:00.000Z');
  expect(end.getTime() - start.getTime()).toBe(23 * 3600000);
});
test('a scheduled Indian departure has the correct UTC instant', () => {
  expect(wallTime('2026-09-18', '07:15', 'Asia/Kolkata').toISOString()).toBe('2026-09-18T01:45:00.000Z');
});
