// Render by default sometimes looks for index.js
// Forwarding the execution to our actual main server file
const { server } = require('./server.js');
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Server running on port ${PORT}`));
