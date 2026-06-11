const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const https = require('https');
const nodemailer = require('nodemailer');

const app = express();
const PORT = process.env.PORT || 3000;
const DATA_DIR = path.join(__dirname, 'data');
const UPLOAD_DIR = path.join(DATA_DIR, 'uploads');
const DB_FILE = path.join(DATA_DIR, 'db.json');

// Ensure storage directories exist
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR, { recursive: true });

// Simple JSON file persistence
function loadDB() {
  try { return JSON.parse(fs.readFileSync(DB_FILE, 'utf8')); }
  catch (e) { return { users: {} }; }
}
function saveDB(db) {
  fs.writeFileSync(DB_FILE, JSON.stringify(db, null, 2));
}
function getUser(db, email) {
  if (!db.users[email]) db.users[email] = { email: email, folders: [] };
  return db.users[email];
}

app.use(express.json({ limit: '25mb' }));
app.use(express.static(path.join(__dirname, 'public')));
app.use('/uploads', express.static(UPLOAD_DIR));

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 25 * 1024 * 1024 } });

// ---- Auth (passwordless email login) ----
app.post('/api/login', (req, res) => {
  const email = (req.body.email || '').trim().toLowerCase();
  if (!email || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
    return res.status(400).json({ error: 'Please enter a valid email address.' });
  }
  const db = loadDB();
  getUser(db, email);
  saveDB(db);
  res.json({ ok: true, email: email });
});

// ---- Folders ----
app.get('/api/folders', (req, res) => {
  const email = (req.query.email || '').toLowerCase();
  const db = loadDB();
  res.json(getUser(db, email).folders);
});

app.post('/api/folders', (req, res) => {
  const email = (req.body.email || '').toLowerCase();
  const name = (req.body.name || '').trim();
  if (!email || !name) return res.status(400).json({ error: 'Email and folder name required.' });
  const db = loadDB();
  const user = getUser(db, email);
  const folder = { id: crypto.randomUUID(), name: name, createdAt: Date.now(), expenses: [] };
  user.folders.push(folder);
  saveDB(db);
  res.json(folder);
});

// ---- Expenses ----
app.post('/api/folders/:folderId/expenses', (req, res) => {
  const email = (req.body.email || '').toLowerCase();
  const db = loadDB();
  const user = getUser(db, email);
  const folder = user.folders.find(f => f.id === req.params.folderId);
  if (!folder) return res.status(404).json({ error: 'Folder not found.' });
  const exp = {
    id: crypto.randomUUID(),
    date: req.body.date || new Date().toISOString().slice(0, 10),
    cost: req.body.cost || 0,
    overview: req.body.overview || '',
    tag: req.body.tag || 'general',
    items: req.body.items || [],
    receiptUrl: req.body.receiptUrl || '',
    miles: req.body.miles || 0,
    mileageCost: req.body.mileageCost || 0,
    createdAt: Date.now()
  };
  folder.expenses.push(exp);
  saveDB(db);
  res.json(exp);
});

// ---- Update an expense (e.g. add the cost later) ----
app.patch('/api/folders/:folderId/expenses/:expenseId', (req, res) => {
  const email = (req.body.email || '').toLowerCase();
  const db = loadDB();
  const user = getUser(db, email);
  const folder = user.folders.find(f => f.id === req.params.folderId);
  if (!folder) return res.status(404).json({ error: 'Folder not found.' });
  const exp = (folder.expenses || []).find(e => e.id === req.params.expenseId);
  if (!exp) return res.status(404).json({ error: 'Expense not found.' });
  if (req.body.cost !== undefined) exp.cost = Number(req.body.cost) || 0;
  if (req.body.date !== undefined) exp.date = req.body.date;
  if (req.body.tag !== undefined) exp.tag = req.body.tag;
  if (req.body.overview !== undefined) exp.overview = req.body.overview;
  saveDB(db);
  res.json(exp);
});

// ---- Receipt upload ----
app.post('/api/upload', upload.single('file'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file uploaded.' });
  const ext = path.extname(req.file.originalname) || '.jpg';
  const fname = crypto.randomUUID() + ext;
  fs.writeFileSync(path.join(UPLOAD_DIR, fname), req.file.buffer);
  res.json({ url: '/uploads/' + fname });
});

// ---- AI receipt analysis ----
// Uses OpenAI vision if OPENAI_API_KEY is set; otherwise returns a heuristic stub.
app.post('/api/analyze', async (req, res) => {
  const imageDataUrl = req.body.image;
  if (!imageDataUrl) return res.status(400).json({ error: 'No image provided.' });
  const key = process.env.OPENAI_API_KEY;
  if (!key) {
    return res.json({
      date: new Date().toISOString().slice(0, 10),
      cost: 0,
      overview: 'Receipt captured. Add OPENAI_API_KEY in Render to enable automatic AI reading of the date, cost, items and tag.',
      tag: 'general',
      items: [],
      aiEnabled: false
    });
  }
  try {
    const result = await callOpenAI(key, imageDataUrl);
    res.json(Object.assign({ aiEnabled: true }, result));
  } catch (e) {
    res.status(500).json({ error: 'AI analysis failed: ' + e.message });
  }
});

function callOpenAI(key, imageDataUrl) {
  return new Promise((resolve, reject) => {
    const prompt = 'You are an expense receipt reader. Analyse this receipt image and respond ONLY with strict JSON: {"date":"YYYY-MM-DD","cost":number,"overview":"short summary","tag":"one word category like dinner, fuel, travel, groceries, office","items":["item1","item2"]}. If you read food items typical of an evening meal use tag "dinner". Use your best judgement for the tag.';
    const payload = JSON.stringify({
      model: 'gpt-4o-mini',
      messages: [{ role: 'user', content: [
        { type: 'text', text: prompt },
        { type: 'image_url', image_url: { url: imageDataUrl } }
      ]}],
      max_tokens: 500
    });
    const reqOpts = {
      hostname: 'api.openai.com',
      path: '/v1/chat/completions',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer ' + key,
        'Content-Length': Buffer.byteLength(payload)
      }
    };
    const r = https.request(reqOpts, (resp) => {
      let body = '';
      resp.on('data', (d) => body += d);
      resp.on('end', () => {
        try {
          const j = JSON.parse(body);
          const text = j.choices[0].message.content.replace(/```json|```/g, '').trim();
          resolve(JSON.parse(text));
        } catch (e) { reject(new Error('Could not parse AI response.')); }
      });
    });
    r.on('error', reject);
    r.write(payload);
    r.end();
  });
}

// ---- Email share ----
app.post('/api/share', async (req, res) => {
  const to = (req.body.to || '').trim();
  const subject = req.body.subject || 'Shared expenses from map16 Expenses';
  const html = req.body.html || '';
  if (!to || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(to)) {
    return res.status(400).json({ error: 'Valid recipient email required.' });
  }
  if (!process.env.SMTP_HOST) {
    return res.json({ ok: false, configured: false, message: 'Email is not configured yet. Add SMTP_HOST, SMTP_PORT, SMTP_USER and SMTP_PASS in Render to enable sending.' });
  }
  try {
    const transporter = nodemailer.createTransport({
      host: process.env.SMTP_HOST,
      port: parseInt(process.env.SMTP_PORT || '587', 10),
      secure: parseInt(process.env.SMTP_PORT || '587', 10) === 465,
      auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS }
    });
    await transporter.sendMail({
      from: process.env.SMTP_USER,
      to: to,
      subject: subject,
      html: html
    });
    res.json({ ok: true, configured: true });
  } catch (e) {
    res.status(500).json({ error: 'Failed to send email: ' + e.message });
  }
});

app.get('/api/health', (req, res) => res.json({ status: 'ok' }));

app.listen(PORT, () => console.log('map16 Expenses running on port ' + PORT));
