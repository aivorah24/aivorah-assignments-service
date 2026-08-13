require('dotenv').config();
const express = require('express');
const cors = require('cors');

const app = express();
app.use(cors());
app.use(express.json({ limit: '20mb' }));

app.get('/health', (_req, res) => res.json({ status: 'ok', service: 'aivorah-assignments-service' }));

app.use('/assignments', require('./routes/assignments'));

const PORT = process.env.PORT || 3015;
app.listen(PORT, () => {
  console.log(`Aivorah Assignments service running on http://localhost:${PORT}`);
});
