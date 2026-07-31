function getSimulatedAlerts() {
  return [
    {
      id: 'sys-offline-1',
      type: 'SYSTEM_WARNING',
      title: 'Device Offline',
      message: 'Device DL1P-1234 has been offline for more than 24 hours.',
      status: 'ACTIVE',
      isRead: false,
      createdAt: new Date(Date.now() - 3600000).toISOString()
    },
    {
      id: 'sys-warning-2',
      type: 'SYSTEM_WARNING',
      title: 'High Speed Alert',
      message: 'Bus DL1P-4321 exceeded speed limit (85 km/h).',
      status: 'ACTIVE',
      isRead: false,
      createdAt: new Date(Date.now() - 100000).toISOString()
    }
  ];
}

function getMockNotifications(userId) {
  return [
    {
      id: 'mock-notif-1',
      userId,
      title: 'New Leave Request',
      message: 'Rohan Sharma has submitted a leave application for tomorrow.',
      type: 'LEAVE',
      isRead: false,
      createdAt: new Date(Date.now() - 600000).toISOString()
    },
    {
      id: 'mock-notif-2',
      userId,
      title: 'Bus Delay Warning',
      message: 'Bus DL1P-1234 on Morning Route A is delayed by 15 minutes.',
      type: 'DELAY',
      isRead: false,
      createdAt: new Date(Date.now() - 1800000).toISOString()
    },
    {
      id: 'mock-notif-3',
      userId,
      title: 'SOS Active Alert',
      message: 'Driver Ashok Kumar triggered SOS alert on Route B.',
      type: 'SOS',
      isRead: false,
      createdAt: new Date(Date.now() - 3600000).toISOString()
    }
  ];
}

module.exports = {
  getSimulatedAlerts,
  getMockNotifications
};
