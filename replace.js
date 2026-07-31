const fs = require('fs');
let code = fs.readFileSync('simulate.js', 'utf8');

const searchStr = `    for (let state of busStates) {
      // Move them slightly to simulate driving
      state.lat += (Math.random() - 0.5) * 0.001;
      state.lng += (Math.random() - 0.5) * 0.001;
      state.speed = 30 + Math.random() * 20; // 30 to 50 km/h

      try {
        await axios.post(API_URL, {
          deviceId: state.deviceId,
          lat: state.lat,
          lng: state.lng,
          speed: state.speed,
          timestamp: new Date().toISOString()
        });
        console.log(\`[Sent] Device: \${state.deviceId} | Lat: \${state.lat.toFixed(4)} | Lng: \${state.lng.toFixed(4)}\`);
      } catch (error) {
        console.error(\`[Error] Failed to send telemetry for \${state.deviceId}\`);
      }
    }`;

const replaceStr = `    // Update state and fire telemetry requests concurrently
    const promises = busStates.map(state => {
      // Move them slightly to simulate driving
      state.lat += (Math.random() - 0.5) * 0.001;
      state.lng += (Math.random() - 0.5) * 0.001;
      state.speed = 30 + Math.random() * 20; // 30 to 50 km/h

      return axios.post(API_URL, {
        deviceId: state.deviceId,
        lat: state.lat,
        lng: state.lng,
        speed: state.speed,
        timestamp: new Date().toISOString()
      })
      .then(() => {
        console.log(\`[Sent] Device: \${state.deviceId} | Lat: \${state.lat.toFixed(4)} | Lng: \${state.lng.toFixed(4)}\`);
      })
      .catch((error) => {
        console.error(\`[Error] Failed to send telemetry for \${state.deviceId}\`);
      });
    });

    await Promise.all(promises);`;

if (code.includes(searchStr)) {
  code = code.replace(searchStr, replaceStr);
  fs.writeFileSync('simulate.js', code);
  console.log("Successfully replaced");
} else {
  console.log("Could not find string to replace");
}
