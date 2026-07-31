const axios = require('axios');
const API_URL = 'http://localhost:3000/api/telemetry';

// Mock server for testing
const express = require('express');
const app = express();
app.post('/api/telemetry', (req, res) => {
  setTimeout(() => res.sendStatus(200), 50); // Simulate network latency
});
let server;

// Mock buses
const buses = [];
for (let i = 1; i <= 50; i++) {
  buses.push({
    deviceId: `TM100-SIM-${i}`,
    lat: 18.5204 + (Math.random() * 0.05),
    lng: 73.8567 + (Math.random() * 0.05),
    speed: 40
  });
}

const busStates = buses;

async function sequentialRequests() {
  const start = Date.now();
  for (let state of busStates) {
    try {
      await axios.post(API_URL, {
        deviceId: state.deviceId,
        lat: state.lat,
        lng: state.lng,
        speed: state.speed,
        timestamp: new Date().toISOString()
      });
    } catch (error) {
    }
  }
  return Date.now() - start;
}

async function parallelRequests() {
  const start = Date.now();
  const promises = busStates.map(state => {
    return axios.post(API_URL, {
      deviceId: state.deviceId,
      lat: state.lat,
      lng: state.lng,
      speed: state.speed,
      timestamp: new Date().toISOString()
    }).catch(() => {});
  });
  await Promise.all(promises);
  return Date.now() - start;
}

async function runBenchmark() {
  console.log('Starting server...');
  server = app.listen(3000, async () => {
    console.log('Server running.');

    console.log('Running sequential test (simulating current loop)...');
    const seqTime = await sequentialRequests();
    console.log(`Sequential time: ${seqTime}ms`);

    console.log('Running parallel test (simulating proposed change)...');
    const parTime = await parallelRequests();
    console.log(`Parallel time: ${parTime}ms`);

    console.log(`Speedup: ${(seqTime / parTime).toFixed(2)}x`);

    server.close();
  });
}

runBenchmark();
