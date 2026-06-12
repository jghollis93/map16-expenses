const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const https = require('https');
const nodemailer = require('nodemailer');
const zlib = require('zlib');

const app = express();
const PORT = process.env.PORT || 3000;
const DATA_DIR = path.join(__dirname, 'data');
const UPLOAD_DIR = path.join(DATA_DIR, 'uploads');
const DB_FILE = path.join(DATA_DIR, 'db.json');

// ---- Access control ----
// Only these email addresses may sign in. Override via ALLOWED_EMAILS env
// (comma-separated) if you need to change them without editing code.
const ALLOWED_EMAILS = (process.env.ALLOWED_EMAILS ||
  'jamie.hollis@map16.co.uk,roberto.bello@map16.co.uk,josh.harris@map16.co.uk,emma.clark@map16.co.uk,ashley.rymer@map16.co.uk,will.wrist@map16.co.uk,matthew.kelley@map16.co.uk')
  .split(',').map(e => e.trim().toLowerCase()).filter(Boolean);
// These managers can browse and export every user's expenses and receipts.
const MANAGER_EMAILS = (process.env.MANAGER_EMAILS || 'roberto.bello@map16.co.uk,jamie.hollis@map16.co.uk')
  .split(',').map(e => e.trim().toLowerCase()).filter(Boolean);

function isAllowed(email) { return ALLOWED_EMAILS.includes((email || '').trim().toLowerCase()); }
function isManager(email) { return MANAGER_EMAILS.includes((email || '').trim().toLowerCase()); }

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

// ---- Auth (passwordless email login, restricted to the allow-list) ----
app.post('/api/login', (req, res) => {
const email = (req.body.email || '').trim().toLowerCase();
if (!email || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
return res.status(400).json({ error: 'Please enter a valid email address.' });
}
if (!isAllowed(email)) {
return res.status(403).json({ error: 'This email is not authorised to access map16 Expenses. Please contact your manager.' });
}
const db = loadDB();
getUser(db, email);
saveDB(db);
res.json({ ok: true, email: email, isManager: isManager(email) });
});

// ---- Folders ----
app.get('/api/folders', (req, res) => {
const email = (req.query.email || '').toLowerCase();
if (!isAllowed(email)) return res.status(403).json({ error: 'Not authorised.' });
const db = loadDB();
res.json(getUser(db, email).folders);
});

// Manager-only: every user's folders, each tagged with the uploader email.
app.get('/api/all-folders', (req, res) => {
const email = (req.query.email || '').toLowerCase();
if (!isManager(email)) return res.status(403).json({ error: 'Only managers can view all folders.' });
const db = loadDB();
const all = [];
Object.values(db.users || {}).forEach(u => {
(u.folders || []).forEach(f => {
all.push(Object.assign({}, f, { uploader: u.email }));
});
});
res.json(all);
});

app.post('/api/folders', (req, res) => {
const email = (req.body.email || '').toLowerCase();
const name = (req.body.name || '').trim();
if (!isAllowed(email)) return res.status(403).json({ error: 'Not authorised.' });
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
if (!isAllowed(email)) return res.status(403).json({ error: 'Not authorised.' });
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
if (!isAllowed(email)) return res.status(403).json({ error: 'Not authorised.' });
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

// ---- Manager exports (CSV + ZIP of all users' expenses/receipts) ----
function gatherRows() {
const db = loadDB();
const rows = [];
Object.values(db.users || {}).forEach(u => {
(u.folders || []).forEach(f => {
(f.expenses || []).forEach(e => {
rows.push({ user: u.email, folder: f.name, exp: e });
});
});
});
return rows;
}
function csvEscape(v) {
const s = (v === undefined || v === null) ? '' : String(v);
return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}

app.get('/api/export/csv', (req, res) => {
const email = (req.query.email || '').toLowerCase();
if (!isManager(email)) return res.status(403).json({ error: 'Only the manager can export.' });
const rows = gatherRows();
const header = ['User', 'Folder', 'Date', 'Tag', 'Overview', 'Cost (GBP)', 'Miles', 'Mileage Cost (GBP)', 'Total (GBP)'];
const lines = [header.map(csvEscape).join(',')];
rows.forEach(r => {
const e = r.exp;
const total = (Number(e.cost) || 0) + (Number(e.mileageCost) || 0);
lines.push([r.user, r.folder, e.date, e.tag, e.overview, Number(e.cost || 0).toFixed(2), e.miles || 0, Number(e.mileageCost || 0).toFixed(2), total.toFixed(2)].map(csvEscape).join(','));
});
const csv = lines.join('\r\n');
res.setHeader('Content-Type', 'text/csv; charset=utf-8');
res.setHeader('Content-Disposition', 'attachment; filename="map16-expenses.csv"');
res.send(csv);
});

// Build an uncompressed (STORED) ZIP with no external dependency.
function buildZip(files) {
const enc = (s) => Buffer.from(s, 'utf8');
const chunks = [];
const central = [];
let offset = 0;
files.forEach(f => {
const nameBuf = enc(f.name);
const data = f.data;
const crc = crc32(data);
const local = Buffer.alloc(30);
local.writeUInt32LE(0x04034b50, 0);
local.writeUInt16LE(20, 4);
local.writeUInt16LE(0, 6);
local.writeUInt16LE(0, 8); // stored
local.writeUInt16LE(0, 10);
local.writeUInt16LE(0, 12);
local.writeUInt32LE(crc >>> 0, 14);
local.writeUInt32LE(data.length, 18);
local.writeUInt32LE(data.length, 22);
local.writeUInt16LE(nameBuf.length, 26);
local.writeUInt16LE(0, 28);
chunks.push(local, nameBuf, data);
const cen = Buffer.alloc(46);
cen.writeUInt32LE(0x02014b50, 0);
cen.writeUInt16LE(20, 4);
cen.writeUInt16LE(20, 6);
cen.writeUInt16LE(0, 8);
cen.writeUInt16LE(0, 10);
cen.writeUInt16LE(0, 12);
cen.writeUInt16LE(0, 14);
cen.writeUInt32LE(crc >>> 0, 16);
cen.writeUInt32LE(data.length, 20);
cen.writeUInt32LE(data.length, 24);
cen.writeUInt16LE(nameBuf.length, 28);
cen.writeUInt16LE(0, 30);
cen.writeUInt16LE(0, 32);
cen.writeUInt16LE(0, 34);
cen.writeUInt16LE(0, 36);
cen.writeUInt32LE(0, 38);
cen.writeUInt32LE(offset, 42);
central.push(Buffer.concat([cen, nameBuf]));
offset += local.length + nameBuf.length + data.length;
});
const centralBuf = Buffer.concat(central);
const end = Buffer.alloc(22);
end.writeUInt32LE(0x06054b50, 0);
end.writeUInt16LE(0, 4);
end.writeUInt16LE(0, 6);
end.writeUInt16LE(files.length, 8);
end.writeUInt16LE(files.length, 10);
end.writeUInt32LE(centralBuf.length, 12);
end.writeUInt32LE(offset, 16);
end.writeUInt16LE(0, 20);
return Buffer.concat([...chunks, centralBuf, end]);
}

let CRC_TABLE;
function crc32(buf) {
if (!CRC_TABLE) {
CRC_TABLE = [];
for (let n = 0; n < 256; n++) {
let c = n;
for (let k = 0; k < 8; k++) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
CRC_TABLE[n] = c >>> 0;
}
}
let crc = 0xffffffff;
for (let i = 0; i < buf.length; i++) crc = (CRC_TABLE[(crc ^ buf[i]) & 0xff] ^ (crc >>> 8)) >>> 0;
return (crc ^ 0xffffffff) >>> 0;
}

app.get('/api/export/zip', (req, res) => {
const email = (req.query.email || '').toLowerCase();
if (!isManager(email)) return res.status(403).json({ error: 'Only the manager can export.' });
const rows = gatherRows();
const files = [];
const used = {};
rows.forEach(r => {
const e = r.exp;
let url = e.receiptUrl || '';
if (!url || !url.startsWith('/uploads/')) return; // skip data-url/no-image entries
const fpath = path.join(UPLOAD_DIR, path.basename(url));
if (!fs.existsSync(fpath)) return;
const ext = path.extname(fpath) || '.jpg';
let base = (r.user.split('@')[0] + '_' + (r.folder || 'folder') + '_' + (e.date || '') + '_' + (e.tag || 'receipt')).replace(/[^a-z0-9_\-]+/gi, '-');
let name = base + ext;
let i = 1;
while (used[name]) { name = base + '-' + (i++) + ext; }
used[name] = true;
try { files.push({ name: name, data: fs.readFileSync(fpath) }); } catch (err) {}
});
if (!files.length) return res.status(404).json({ error: 'No receipt files are available to download.' });
const zip = buildZip(files);
res.setHeader('Content-Type', 'application/zip');
res.setHeader('Content-Disposition', 'attachment; filename="map16-receipts.zip"');
res.send(zip);
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
const text = j.choices[0].message.content.replace(/(```)json|(```)/g, '').trim();
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
if (!to || !/^[^@s]+@[^@s]+.[^@s]+$/.test(to)) {
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
