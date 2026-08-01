const fs = require('fs');
const content = fs.readFileSync('server.js', 'utf8');

const targetBlock = `app.post('/api/schools/:schoolId/drivers', async (req, res) => {
  try {
    const { name, email } = req.body;
    // For MVP, auto-generate a temporary password for the driver
    const tempPassword = crypto.randomBytes(16).toString('hex');
    const hashedPassword = await bcrypt.hash(tempPassword, 10);

    const driver = await prisma.user.create({
      data: {
        schoolId: req.params.schoolId,
        name,
        email,
        password: hashedPassword,
        role: "DRIVER"
      }
    });

    res.json({ driver, tempPassword });`;

const newBlock = `app.post('/api/schools/:schoolId/drivers', async (req, res) => {
  try {
    const { name, email, password } = req.body;
    const hashedPassword = await bcrypt.hash(password, 10);

    const driver = await prisma.user.create({
      data: {
        schoolId: req.params.schoolId,
        name,
        email,
        password: hashedPassword,
        role: "DRIVER"
      }
    });

    res.json(driver);`;

if (!content.includes(targetBlock)) {
  console.error("Target block not found");
  process.exit(1);
}

const updatedContent = content.replace(targetBlock, newBlock);
fs.writeFileSync('server.js', updatedContent, 'utf8');
console.log('Successfully patched server.js');
