const express = require('express');
const path = require('path');
const app = express();

// Serve everything inside "public" folder (CSS, JS, HTML)
app.use(express.static('public'));

// If someone visits the root URL, send index.html
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

const PORT = 3000;
app.listen(PORT, () => {
  console.log(`✅ Server running at http://localhost:${PORT}`);
});