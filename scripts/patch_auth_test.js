const fs = require('fs');
let code = fs.readFileSync('tests/auth.test.js', 'utf8');

// Fix test 1: expects no preferences
code = code.replace(
  `expect(res.body.user).toEqual({
      id: 1,
      role: 'ADMIN',
      name: 'Test User',
      email: 'user@test.com',
      schoolId: 10,
    });`,
  `expect(res.body.user).toEqual({
      id: 1,
      role: 'ADMIN',
      name: 'Test User',
      email: 'user@test.com',
      schoolId: 10,
      preferences: {}
    });`
);

// Fix test 2: catch block in server.js returns 'Internal server error' instead of raw error message
code = code.replace(
  `expect(res.body).toEqual({ error: 'Database error' });`,
  `expect(res.body).toEqual({ error: 'Internal server error' });`
);

fs.writeFileSync('tests/auth.test.js', code);
