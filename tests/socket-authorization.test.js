const jwt = require('jsonwebtoken');
const { logoutToken } = require('../middleware/auth');
const { attachSocketAuth } = require('../middleware/socketAuth');

function fakeIo() {
  const io = {
    middleware: null,
    connectionHandler: null,
    use: jest.fn((fn) => { io.middleware = fn; }),
    on: jest.fn((event, fn) => {
      if (event === 'connection') io.connectionHandler = fn;
    }),
    disconnectSockets: jest.fn(),
    in: jest.fn(() => ({ disconnectSockets: io.disconnectSockets })),
  };
  return io;
}

function fakeSocket(token) {
  return {
    handshake: { auth: { token }, query: {} },
    data: {},
    join: jest.fn(),
    on: jest.fn(),
    id: 'socket-1',
  };
}

function runMiddleware(io, socket) {
  return new Promise((resolve) => io.middleware(socket, resolve));
}

describe('Socket.IO authorization', () => {
  const SECRET = process.env.JWT_SECRET;

  it('rejects a JWT that was revoked through the HTTP logout path', async () => {
    const token = jwt.sign({ id: 'revoked-user', role: 'PARENT', schoolId: 'school-1' }, SECRET);
    logoutToken(token);
    const io = fakeIo();
    attachSocketAuth(io);

    const error = await runMiddleware(io, fakeSocket(token));
    expect(error).toBeInstanceOf(Error);
    expect(error.message).toMatch(/revoked/i);
  });

  it('disconnects an already-connected user when their token is revoked', () => {
    const token = jwt.sign({ id: 'active-user', role: 'SCHOOL_ADMIN', schoolId: 'school-1' }, SECRET);
    const io = fakeIo();
    attachSocketAuth(io);

    logoutToken(token);

    expect(io.in).toHaveBeenCalledWith('user:active-user');
    expect(io.disconnectSockets).toHaveBeenCalledWith(true);
  });

  it('keeps parents out of the admin-only school room', async () => {
    const token = jwt.sign({ id: 'parent-1', role: 'PARENT', schoolId: 'school-1' }, SECRET);
    const io = fakeIo();
    const socket = fakeSocket(token);
    attachSocketAuth(io);

    expect(await runMiddleware(io, socket)).toBeUndefined();
    expect(socket.join).toHaveBeenCalledWith('user:parent-1');
    expect(socket.join).not.toHaveBeenCalledWith('school-admin:school-1');
  });

  it('rejects bearer tokens supplied in the URL query string', async () => {
    const token = jwt.sign({ id: 'parent-query', role: 'PARENT', schoolId: 'school-1' }, SECRET);
    const io = fakeIo();
    const socket = fakeSocket(undefined);
    socket.handshake.query.token = token;
    attachSocketAuth(io);

    const error = await runMiddleware(io, socket);
    expect(error).toBeInstanceOf(Error);
    expect(error.message).toMatch(/missing token/i);
  });

  it('joins a school admin to the tenant admin room', async () => {
    const token = jwt.sign({ id: 'admin-1', role: 'SCHOOL_ADMIN', schoolId: 'school-1' }, SECRET);
    const io = fakeIo();
    const socket = fakeSocket(token);
    attachSocketAuth(io);

    expect(await runMiddleware(io, socket)).toBeUndefined();
    expect(socket.join).toHaveBeenCalledWith('user:admin-1');
    expect(socket.join).toHaveBeenCalledWith('school-admin:school-1');
  });
});
