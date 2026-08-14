module.exports = {
  testEnvironment: 'node',
  setupFiles: ['<rootDir>/jest.setup.js'],
  testMatch: ['<rootDir>/tests/**/*.test.js'],
  // Prevent open handles (sockets, prisma) from hanging the run
  forceExit: true,
  clearMocks: true,
};
