// Google's polyline encoding, for building test roads. routePlan.js only decodes.
function encode(points) {
  let out = '', pLat = 0, pLng = 0;
  const chunk = (v) => {
    let n = v < 0 ? ~(v << 1) : v << 1, s = '';
    while (n >= 0x20) { s += String.fromCharCode((0x20 | (n & 0x1f)) + 63); n >>= 5; }
    return s + String.fromCharCode(n + 63);
  };
  for (const p of points) {
    const lat = Math.round(p.lat * 1e5), lng = Math.round(p.lng * 1e5);
    out += chunk(lat - pLat) + chunk(lng - pLng);
    pLat = lat; pLng = lng;
  }
  return out;
}
module.exports = { encode };
