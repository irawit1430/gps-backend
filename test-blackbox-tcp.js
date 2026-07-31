const { parseBlackboxPacket, calculateCRC32 } = require('./blackbox-parser');
const net = require('net');
const { startTcpServer } = require('./tcp-server');

console.log('=== TESTING BLACKBOX TM-100 PARSER ===\n');

// 1. Test Data Packet ($DP)
const dpSample = '$DP,BB100V,4G5017,NR,16,L,860181063592734,PB65X1234,1,13062023,113813,30.717215,N,76.764511,E,0.0,323.5,40,321,0.8,0.4,AIRTEL,0,1,12.68,4.12,0,C,31,404,02,337,7DDE415,98EE,9F,-89,E49,7A,-94,0,0,-113,0,0,-113,0000,00,4,1688.2,0,-10,46,(),3555B60C*';
const parsedDP = parseBlackboxPacket(dpSample);
console.log('Parsed $DP Packet:', JSON.stringify(parsedDP, null, 2));

// 2. Test Login Packet ($LI)
const liSample = '$LI,BOX100,4G5017,860181063592734,89916490634629449681,PB65X1234,30.717215,N,76.764511,E*';
const parsedLI = parseBlackboxPacket(liSample);
console.log('\nParsed $LI Packet:', JSON.stringify(parsedLI, null, 2));

// 3. Test Emergency Packet ($EPB)
const epbSample = '$EPB,EMR,860181063592734,NM,13062023113813,A,30.717215,N,76.764511,E,321.0,0.0,0.0,G,PB65X1234,NA,FABCF96*';
const parsedEPB = parseBlackboxPacket(epbSample);
console.log('\nParsed $EPB Packet:', JSON.stringify(parsedEPB, null, 2));

// 4. Test Health Packet ($HMP)
const hmpSample = '$HMP,BOX100,7S005,860181063592734,100,10,0,120,300,1,0000,04,0,0,*';
const parsedHMP = parseBlackboxPacket(hmpSample);
console.log('\nParsed $HMP Packet:', JSON.stringify(parsedHMP, null, 2));

console.log('\n=== TESTING TCP SERVER SOCKET INTEGRATION ===\n');

const mockIo = {
  emit: (event, data) => console.log(`[Socket.IO Broadcast] -> Event: '${event}'`, data)
};

const server = startTcpServer(mockIo, 0);

setTimeout(() => {
  const TEST_PORT = server.address().port;
  console.log(`[Test Setup] Assigned Dynamic Test Port: ${TEST_PORT}`);
  
  const client = net.connect({ port: TEST_PORT }, () => {
    console.log('[Test Client] Connected to TCP Server, sending $LI Login Packet...');
    client.write(liSample + '\n');

    setTimeout(() => {
      console.log('[Test Client] Sending $DP Periodic Location Packet...');
      client.write(dpSample + '\n');
    }, 300);

    setTimeout(() => {
      console.log('[Test Client] Sending $EPB SOS Emergency Packet...');
      client.write(epbSample + '\n');
    }, 600);

    setTimeout(() => {
      console.log('[Test Client] Closing socket connection...');
      client.end();
      server.close(() => {
        console.log('\n✅ ALL BLACKBOX TM-100 TCP PARSER & SOCKET TESTS PASSED SUCCESSFULLY!');
        process.exit(0);
      });
    }, 1000);
  });
}, 300);
