/**
 * Blackbox TM-100 AIS-140 TCP Message Protocol Parser
 * Official Specification Date: June 2023
 */

function calculateCRC32(msgStr) {
  let crc = 0xFFFFFFFF;
  // Per spec: loop starts from index 1 (skipping initial '$')
  for (let i = 1; i < msgStr.length; i++) {
    let byte = msgStr.charCodeAt(i);
    crc = (crc ^ byte) >>> 0;
    for (let j = 0; j < 8; j++) {
      let mask = (crc & 1) ? 0xFFFFFFFF : 0;
      crc = ((crc >>> 1) ^ (0xEDB88320 & mask)) >>> 0;
    }
  }
  return (~crc >>> 0).toString(16).toUpperCase().padStart(8, '0');
}

/**
 * Parses raw ASCII packet string sent by Blackbox TM-100 device over TCP/IP.
 * Sample packets start with '$' and end with '*'
 * @param {string} rawString 
 * @returns {object|null} Parsed packet details
 */
function parseBlackboxPacket(rawString, { verifyCrc = false } = {}) {
  if (!rawString || typeof rawString !== 'string') return null;

  // Clean string
  const cleaned = rawString.trim();
  if (!cleaned.startsWith('$')) return null;

  // Strip trailing '*' or newline
  const content = cleaned.endsWith('*') ? cleaned.slice(0, -1) : cleaned;
  const parts = content.split(',');
  if (parts.length === 0) return null;

  // Optional CRC32 verification: last field is expected checksum
  if (verifyCrc && parts.length >= 2) {
    const receivedCrc = parts[parts.length - 1];
    const signedContent = parts.slice(0, -1).join(',');
    const expected = calculateCRC32(signedContent);
    if (String(receivedCrc).toUpperCase() !== expected) {
      return { __crcFailed: true, expected, received: receivedCrc };
    }
  }

  const header = parts[0];

  switch (header) {
    case '$DP':
      return parseDataPacket(parts, content);
    case '$LI':
      return parseLoginPacket(parts, content);
    case '$EPB':
      return parseEmergencyPacket(parts, content);
    case '$HMP':
      return parseHealthPacket(parts, content);
    default:
      console.log(`[Blackbox Parser] Unknown header packet type: ${header}`);
      return null;
  }
}

/**
 * Parse Periodic Data Packet ($DP)
 */
function parseDataPacket(parts, fullContent) {
  if (parts.length < 28) {
    console.warn('[Blackbox Parser] Malformed $DP packet: length too short');
    return null;
  }

  const vendorId = parts[1];
  const firmwareVer = parts[2];
  const packetType = parts[3]; // NR, HP, BD, BL, IN, IF, EA, HA, HB, RT, DT, OS, TR
  const alertId = parts[4];   // 01-18
  const packetStatus = parts[5]; // L = Live, H = History
  const imei = parts[6];
  const vehicleRegNo = parts[7];
  const gpsFix = parts[8] === '1';

  // Parse Date (DDMMYYYY) & Time (HHMMSS)
  const dateStr = parts[9];
  const timeStr = parts[10];
  let timestamp = new Date();
  if (dateStr && dateStr.length === 8 && timeStr && timeStr.length >= 6) {
    const day = parseInt(dateStr.substring(0, 2));
    const month = parseInt(dateStr.substring(2, 4)) - 1;
    const year = parseInt(dateStr.substring(4, 8));
    const hour = parseInt(timeStr.substring(0, 2));
    const minute = parseInt(timeStr.substring(2, 4));
    const second = parseInt(timeStr.substring(4, 6));
    timestamp = new Date(Date.UTC(year, month, day, hour, minute, second));
  }

  // Latitude & Longitude
  let lat = parseFloat(parts[11]) || 0.0;
  if (parts[12] === 'S') lat = -lat;

  let lng = parseFloat(parts[13]) || 0.0;
  if (parts[14] === 'W') lng = -lng;

  const speed = parseFloat(parts[15]) || 0.0; // km/h
  const heading = parseFloat(parts[16]) || 0.0;
  const satellites = parseInt(parts[17]) || 0;
  const altitude = parseFloat(parts[18]) || 0.0;
  const operatorName = parts[21] || 'Unknown';
  const ignition = parts[22] === '1';
  const mainPowerConnected = parts[23] === '1';
  const mainInputVoltage = parseFloat(parts[24]) || 0.0;
  const internalBatteryVoltage = parseFloat(parts[25]) || 0.0;
  const emergencyActive = parts[26] === '1' || alertId === '10' || packetType === 'EA';
  const tamperActive = parts[27] === 'O' || alertId === '09' || alertId === '16';
  const gsmSignal = parseInt(parts[28]) || 0;

  return {
    packetType: 'PERIODIC_DATA',
    header: '$DP',
    vendorId,
    firmwareVer,
    subPacketType: packetType,
    alertId,
    isLive: packetStatus === 'L',
    imei,
    vehicleRegNo,
    gpsFix,
    timestamp,
    lat,
    lng,
    speed,
    heading,
    satellites,
    altitude,
    operatorName,
    ignition,
    mainPowerConnected,
    mainInputVoltage,
    internalBatteryVoltage,
    emergencyActive,
    tamperActive,
    gsmSignal,
    rawText: fullContent
  };
}

/**
 * Parse Login Packet ($LI)
 */
function parseLoginPacket(parts, fullContent) {
  const vendorId = parts[1];
  const firmwareVer = parts[2];
  const imei = parts[3];
  const iccid = parts[4];
  const vehicleRegNo = parts[5];
  
  let lat = parseFloat(parts[6]) || 0.0;
  if (parts[7] === 'S') lat = -lat;

  let lng = parseFloat(parts[8]) || 0.0;
  if (parts[9] && parts[9].startsWith('W')) lng = -lng;

  return {
    packetType: 'LOGIN',
    header: '$LI',
    vendorId,
    firmwareVer,
    imei,
    iccid,
    vehicleRegNo,
    lat,
    lng,
    rawText: fullContent
  };
}

/**
 * Parse Emergency Data Packet ($EPB)
 */
function parseEmergencyPacket(parts, fullContent) {
  const msgType = parts[1]; // EMR = Emergency Message, SEM = Stop Message
  const imei = parts[2];
  const packetType = parts[3]; // NM = Normal, SP = Stored
  const dtStr = parts[4]; // DDMMYYYYhhmmss
  
  let timestamp = new Date();
  if (dtStr && dtStr.length >= 14) {
    const day = parseInt(dtStr.substring(0, 2));
    const month = parseInt(dtStr.substring(2, 4)) - 1;
    const year = parseInt(dtStr.substring(4, 8));
    const hour = parseInt(dtStr.substring(8, 10));
    const minute = parseInt(dtStr.substring(10, 12));
    const second = parseInt(dtStr.substring(12, 14));
    timestamp = new Date(Date.UTC(year, month, day, hour, minute, second));
  }

  const gpsFix = parts[5] === 'A';
  let lat = parseFloat(parts[6]) || 0.0;
  if (parts[7] === 'S') lat = -lat;

  let lng = parseFloat(parts[8]) || 0.0;
  if (parts[9] === 'W') lng = -lng;

  const altitude = parseFloat(parts[10]) || 0.0;
  const speed = parseFloat(parts[11]) || 0.0;
  const vehicleRegNo = parts[14];

  return {
    packetType: 'EMERGENCY',
    header: '$EPB',
    msgType,
    imei,
    isStored: packetType === 'SP',
    timestamp,
    gpsFix,
    lat,
    lng,
    altitude,
    speed,
    vehicleRegNo,
    emergencyActive: true,
    rawText: fullContent
  };
}

/**
 * Parse Health Monitoring Packet ($HMP)
 */
function parseHealthPacket(parts, fullContent) {
  const vendorId = parts[1];
  const firmwareVer = parts[2];
  const imei = parts[3];
  const batteryPct = parseInt(parts[4]) || 0;
  const lowBatteryThreshold = parseInt(parts[5]) || 10;
  const updateRateIgnitionON = parseInt(parts[7]) || 120;
  const updateRateIgnitionOFF = parseInt(parts[8]) || 300;
  const ignitionOff = parts[9] === '1'; // 1 = OFF, 0 = ON per spec

  return {
    packetType: 'HEALTH',
    header: '$HMP',
    vendorId,
    firmwareVer,
    imei,
    batteryPct,
    lowBatteryThreshold,
    updateRateIgnitionON,
    updateRateIgnitionOFF,
    ignition: !ignitionOff,
    rawText: fullContent
  };
}

module.exports = {
  parseBlackboxPacket,
  calculateCRC32
};
