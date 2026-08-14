const localtunnel = require('localtunnel');

async function startTunnel() {
  try {
    const tunnel = await localtunnel({ port: 3000, subdomain: 'fleet-api-anurag-v4' });
    console.log(`Tunnel successfully started at: ${tunnel.url}`);

    tunnel.on('close', () => {
      console.log('Tunnel closed by remote server. Restarting in 2 seconds...');
      setTimeout(startTunnel, 2000);
    });
    
    tunnel.on('error', (err) => {
      console.error('Tunnel error:', err);
      tunnel.close();
    });
  } catch (err) {
    console.error('Failed to start tunnel:', err);
    setTimeout(startTunnel, 2000);
  }
}

console.log('Starting Auto-Reconnect Tunnel Manager...');
startTunnel();
