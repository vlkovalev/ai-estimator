const express = require('express');
const multer = require('multer');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { S3Client, PutObjectCommand, GetObjectCommand } = require('@aws-sdk/client-s3');
const { getSignedUrl } = require('@aws-sdk/s3-request-presigner');
const { Storage } = require('@google-cloud/storage');
const { Readable } = require('stream');
const _pdfParse = require('pdf-parse');
const PDFParse = _pdfParse?.PDFParse || _pdfParse?.default || _pdfParse;
const csv = require('csv-parser');
const { createObjectCsvWriter } = require('csv-writer');
const ExcelJS = require('exceljs');
const cron = require('node-cron');
const { GoogleGenAI } = require("@google/genai");

require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3000;
const AUDIT_LOG_DIR = path.join(process.cwd(), 'logs');
const AUDIT_LOG_PATH = path.join(AUDIT_LOG_DIR, 'input-uploads.log');
const LOCAL_OUTPUTS_DIR = path.join(process.cwd(), 'outputs');
const STORAGE_PROVIDER = process.env.STORAGE_PROVIDER || (process.env.S3_BUCKET ? 's3' : (process.env.GCS_BUCKET ? 'gcs' : 'local'));
const ACCEPTABLE_TERMS_PATH = path.join(process.cwd(), 'data', 'acceptable_terms.json');
const DOCUMENT_TASKS_DIR = path.join(process.cwd(), 'data', 'document_tasks');
const PROJECT_INDEX_OUTPUT_DIR = path.join(process.cwd(), 'outputs', '_ai');
const auditStore = require('./lib/auditStore');

function ensureDirSync(dir) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function loadAcceptableTerms() {
  try {
    ensureDirSync(path.dirname(ACCEPTABLE_TERMS_PATH));
    return JSON.parse(fs.readFileSync(ACCEPTABLE_TERMS_PATH, 'utf8'));
  } catch (err) {
    console.warn('Failed to load acceptable terms, using defaults.', err.message);
    return {
      liquidatedDamages: 'Cap at 10% of contract sum; daily rate ≤ 0.1% of contract sum.',
      consequentialLoss: 'Exclude entirely for both parties; no recovery of indirect, special, or consequential loss.',
      liabilityCap: 'Limited to contract sum or £/€5,000,000, whichever is lower.',
      paymentTerms: 'Monthly applications with payment due within 30 days.',
      retention: '5% maximum retention, with half released at practical completion.',
      noticePeriods: '7 days for minor delays; 14 days for material breach.',
      disputeResolution: 'Adjudication first, then arbitration; avoid court litigation where possible.',
      riseAndFall: 'Required for projects lasting longer than 12 months.',
      forceMajeure: 'Standard force majeure definition including pandemic and supply chain disruption.',
      governingLaw: 'Governing law should be mutually acceptable and neutral where possible.'
    };
  }
}

const acceptableTerms = loadAcceptableTerms();

function normalizeText(text) {
  return (text || '').replace(/\s+/g, ' ').trim().toLowerCase();
}

function findClauseSnippet(text, patterns, window = 300) {
  if (!text) return null;
  for (const pattern of patterns) {
    const match = text.match(pattern);
    if (match && typeof match.index === 'number') {
      const start = Math.max(0, match.index - window);
      const end = Math.min(text.length, match.index + match[0].length + window);
      return text.slice(start, end).replace(/[\r\n]+/g, ' ').trim();
    }
  }
  return null;
}

function clauseReference(snippet, fallback) {
  if (!snippet) return fallback;
  const match = snippet.match(/(?:Clause|Cl\.|section|Section)\s*([0-9]+(?:\.[0-9]+)*)/i);
  return match ? match[1] : fallback;
}

function clauseAssessment(type, snippet) {
  const norm = normalizeText(snippet || '');
  switch (type) {
    case 'liquidatedDamages': {
      const rule = acceptableTerms.liquidatedDamages;
      if (!snippet) return { acceptablePosition: rule, contractPosition: 'Not found', deviation: 'Clause missing or unclear', riskLevel: 'Negotiable', suggestedAction: 'Confirm a 10% cap and 0.1% daily rate in the contract' };
      const matched = norm.match(/(\d+(?:\.\d+)?)\s*%/);
      if (/no cap|without cap|unlimited/.test(norm)) {
        return { acceptablePosition: rule, contractPosition: snippet, deviation: 'No cap / unlimited liability', riskLevel: 'Critical', suggestedAction: 'Negotiate a 10% cap on contract sum' };
      }
      if (matched) {
        const pct = parseFloat(matched[1]);
        if (pct > 10) {
          return { acceptablePosition: rule, contractPosition: snippet, deviation: 'Higher cap', riskLevel: 'Critical', suggestedAction: 'Negotiate down to 10% or less' };
        }
        return { acceptablePosition: rule, contractPosition: snippet, deviation: 'Acceptable cap', riskLevel: 'Acceptable', suggestedAction: 'No change required' };
      }
      return { acceptablePosition: rule, contractPosition: snippet, deviation: 'Unclear cap', riskLevel: 'Negotiable', suggestedAction: 'Clarify the liquidated damages cap and daily rate' };
    }
    case 'consequentialLoss': {
      const rule = acceptableTerms.consequentialLoss;
      if (!snippet) return { acceptablePosition: rule, contractPosition: 'Not found', deviation: 'No consequential loss clause found', riskLevel: 'Negotiable', suggestedAction: 'Add a mutual consequential loss waiver' };
      if (/exclude|excluded|waive|waived|disclaim|disclaimed/.test(norm)) {
        return { acceptablePosition: rule, contractPosition: snippet, deviation: 'Matches standard exclusion', riskLevel: 'Acceptable', suggestedAction: 'No change required' };
      }
      return { acceptablePosition: rule, contractPosition: snippet, deviation: 'Consequential loss not excluded', riskLevel: 'Negotiable', suggestedAction: 'Recommend exclusion of consequential loss for both parties' };
    }
    case 'liabilityCap': {
      const rule = acceptableTerms.liabilityCap;
      if (!snippet) return { acceptablePosition: rule, contractPosition: 'Not found', deviation: 'No liability cap clause found', riskLevel: 'Critical', suggestedAction: 'Add a liability cap limited to contract sum or lower' };
      if (/no cap|without cap|unlimited/.test(norm)) {
        return { acceptablePosition: rule, contractPosition: snippet, deviation: 'Unlimited liability', riskLevel: 'Critical', suggestedAction: 'Negotiate liability cap to contract sum or £/€5M' };
      }
      if (/contract sum/.test(norm) || /£\s*5,?000,?000|€\s*5,?000,?000/.test(norm)) {
        return { acceptablePosition: rule, contractPosition: snippet, deviation: 'Matches acceptable cap', riskLevel: 'Acceptable', suggestedAction: 'No change required' };
      }
      return { acceptablePosition: rule, contractPosition: snippet, deviation: 'Cap needs review', riskLevel: 'Negotiable', suggestedAction: 'Confirm the cap is limited to contract sum or £/€5M' };
    }
    case 'paymentTerms': {
      const rule = acceptableTerms.paymentTerms;
      if (!snippet) return { acceptablePosition: rule, contractPosition: 'Not found', deviation: 'Payment terms missing', riskLevel: 'Negotiable', suggestedAction: 'Define monthly applications and 30-day payment terms' };
      if (/30 days/.test(norm) && /monthly/.test(norm)) {
        return { acceptablePosition: rule, contractPosition: snippet, deviation: 'Matches standard terms', riskLevel: 'Acceptable', suggestedAction: 'No change required' };
      }
      if (/60 days|45 days|payment within/.test(norm)) {
        return { acceptablePosition: rule, contractPosition: snippet, deviation: 'Longer payment period', riskLevel: 'Negotiable', suggestedAction: 'Aim for 30 days payment terms' };
      }
      return { acceptablePosition: rule, contractPosition: snippet, deviation: 'Payment terms differ', riskLevel: 'Negotiable', suggestedAction: 'Review payment timing and application frequency' };
    }
    case 'retention': {
      const rule = acceptableTerms.retention;
      if (!snippet) return { acceptablePosition: rule, contractPosition: 'Not found', deviation: 'Retention clause missing', riskLevel: 'Negotiable', suggestedAction: 'Add a 5% retention clause with half released at practical completion' };
      const matched = norm.match(/(\d+(?:\.\d+)?)\s*%/);
      if (matched) {
        const pct = parseFloat(matched[1]);
        if (pct > 5) {
          return { acceptablePosition: rule, contractPosition: snippet, deviation: 'High retention rate', riskLevel: 'Negotiable', suggestedAction: 'Negotiate retention down to 5%' };
        }
        return { acceptablePosition: rule, contractPosition: snippet, deviation: 'Retention within standard limits', riskLevel: 'Acceptable', suggestedAction: 'No change required' };
      }
      if (/practical completion/.test(norm) && /half|50%/.test(norm)) {
        return { acceptablePosition: rule, contractPosition: snippet, deviation: 'Retention release acceptable', riskLevel: 'Acceptable', suggestedAction: 'No change required' };
      }
      return { acceptablePosition: rule, contractPosition: snippet, deviation: 'Retention wording needs review', riskLevel: 'Negotiable', suggestedAction: 'Confirm 5% maximum retention and release terms' };
    }
    case 'noticePeriods': {
      const rule = acceptableTerms.noticePeriods;
      if (!snippet) return { acceptablePosition: rule, contractPosition: 'Not found', deviation: 'Notice periods not specified', riskLevel: 'Negotiable', suggestedAction: 'Adopt 7-day minor and 14-day material breach notice periods' };
      if (/7 days/.test(norm) && /14 days/.test(norm)) {
        return { acceptablePosition: rule, contractPosition: snippet, deviation: 'Matches standard notice periods', riskLevel: 'Acceptable', suggestedAction: 'No change required' };
      }
      return { acceptablePosition: rule, contractPosition: snippet, deviation: 'Notice periods differ', riskLevel: 'Negotiable', suggestedAction: 'Review and align notice periods to standard thresholds' };
    }
    case 'disputeResolution': {
      const rule = acceptableTerms.disputeResolution;
      if (!snippet) return { acceptablePosition: rule, contractPosition: 'Not found', deviation: 'No dispute resolution path defined', riskLevel: 'Negotiable', suggestedAction: 'Add adjudication then arbitration rather than court litigation' };
      if (/adjudication/.test(norm) && /arbitration/.test(norm) && !/court|litigation/.test(norm)) {
        return { acceptablePosition: rule, contractPosition: snippet, deviation: 'Matches preferred dispute resolution', riskLevel: 'Acceptable', suggestedAction: 'No change required' };
      }
      if (/court|litigation/.test(norm)) {
        return { acceptablePosition: rule, contractPosition: snippet, deviation: 'Court-based dispute path', riskLevel: 'Critical', suggestedAction: 'Move dispute resolution to adjudication then arbitration' };
      }
      return { acceptablePosition: rule, contractPosition: snippet, deviation: 'Dispute resolution needs review', riskLevel: 'Negotiable', suggestedAction: 'Prefer adjudication before arbitration' };
    }
    case 'riseAndFall': {
      const rule = acceptableTerms.riseAndFall;
      if (!snippet) return { acceptablePosition: rule, contractPosition: 'Not found', deviation: 'No rise and fall clause found', riskLevel: 'Negotiable', suggestedAction: 'Add a rise and fall clause for long-duration projects' };
      if (/rise and fall|price fluctuation|escalation/.test(norm)) {
        return { acceptablePosition: rule, contractPosition: snippet, deviation: 'Rise and fall clause present', riskLevel: 'Acceptable', suggestedAction: 'No change required' };
      }
      return { acceptablePosition: rule, contractPosition: snippet, deviation: 'Rise and fall clause unclear', riskLevel: 'Negotiable', suggestedAction: 'Confirm standard rise and fall protections for >12-month projects' };
    }
    case 'forceMajeure': {
      const rule = acceptableTerms.forceMajeure;
      if (!snippet) return { acceptablePosition: rule, contractPosition: 'Not found', deviation: 'Force majeure clause not identified', riskLevel: 'Negotiable', suggestedAction: 'Add a standard force majeure clause including pandemic and supply chain disruption' };
      if (/force majeure/.test(norm) && /pandemic|supply chain|supply-chain|supply chain disruption/.test(norm)) {
        return { acceptablePosition: rule, contractPosition: snippet, deviation: 'Standard force majeure language', riskLevel: 'Acceptable', suggestedAction: 'No change required' };
      }
      return { acceptablePosition: rule, contractPosition: snippet, deviation: 'Force majeure wording needs review', riskLevel: 'Negotiable', suggestedAction: 'Expand force majeure language to cover pandemic and supply chain disruption' };
    }
    default:
      return { acceptablePosition: '', contractPosition: snippet || 'Not found', deviation: 'Unknown clause type', riskLevel: 'Negotiable', suggestedAction: 'Review manually' };
  }
}

const CLAUSE_DEFINITIONS = [
  { type: 'liquidatedDamages', title: 'Liquidated damages', patterns: [/liquidated damages?/i, /delay damages?/i] },
  { type: 'consequentialLoss', title: 'Consequential loss', patterns: [/consequential loss/i, /indirect loss/i, /special damages/i] },
  { type: 'liabilityCap', title: 'Liability cap', patterns: [/liability cap/i, /limit(?:ed)? liability/i, /aggregate liability/i] },
  { type: 'paymentTerms', title: 'Payment terms', patterns: [/payment terms?/i, /30 days/i, /monthly applications?/i] },
  { type: 'retention', title: 'Retention', patterns: [/retention/i] },
  { type: 'noticePeriods', title: 'Notice periods', patterns: [/notice period/i, /notice is given/i, /days notice/i] },
  { type: 'disputeResolution', title: 'Dispute resolution', patterns: [/dispute resolution/i, /adjudication/i, /arbitration/i, /court/i] },
  { type: 'riseAndFall', title: 'Rise and fall', patterns: [/rise and fall/i, /price fluctuation/i, /escalation/i] },
  { type: 'forceMajeure', title: 'Force majeure', patterns: [/force majeure/i] }
];

function buildContractReviewRows(text) {
  return CLAUSE_DEFINITIONS.map(rule => {
    const snippet = findClauseSnippet(text, rule.patterns) || '';
    const assessment = clauseAssessment(rule.type, snippet);
    return {
      clauseRef: clauseReference(snippet, rule.title),
      clauseSummary: rule.title,
      acceptablePosition: assessment.acceptablePosition,
      contractPosition: assessment.contractPosition,
      deviation: assessment.deviation,
      riskLevel: assessment.riskLevel,
      suggestedAction: assessment.suggestedAction
    };
  });
}

function buildExecutiveSummary(rows) {
  const critical = rows.filter(r => r.riskLevel === 'Critical');
  const negotiable = rows.filter(r => r.riskLevel === 'Negotiable');
  const bullets = [];
  critical.slice(0, 3).forEach(r => bullets.push(`Critical: ${r.clauseSummary} - ${r.deviation}. ${r.suggestedAction}.`));
  if (bullets.length < 3) {
    negotiable.slice(0, 3 - bullets.length).forEach(r => bullets.push(`Review: ${r.clauseSummary} - ${r.deviation}. ${r.suggestedAction}.`));
  }
  if (!bullets.length) {
    bullets.push('No material departures identified. Contract terms align with the acceptable terms library.');
  }
  const recommendedAction = critical.length ? 'No-Go' : (negotiable.length ? 'Negotiate' : 'Go');
  return { bullets, recommendedAction };
}

async function writeContractReviewWorkbook(rows, summary) {
  ensureDirSync(LOCAL_OUTPUTS_DIR);
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet('Departures Register');
  sheet.columns = [
    { header: 'Clause Ref', key: 'clauseRef', width: 18 },
    { header: 'Clause Summary', key: 'clauseSummary', width: 28 },
    { header: 'Acceptable Position', key: 'acceptablePosition', width: 36 },
    { header: 'Contract Position', key: 'contractPosition', width: 48 },
    { header: 'Deviation', key: 'deviation', width: 24 },
    { header: 'Risk Level', key: 'riskLevel', width: 14 },
    { header: 'Suggested Action', key: 'suggestedAction', width: 36 }
  ];
  rows.forEach(row => sheet.addRow(row));
  const summarySheet = workbook.addWorksheet('Summary');
  summarySheet.addRow(['Critical Findings']);
  summary.bullets.forEach(b => summarySheet.addRow([b]));
  summarySheet.addRow([]);
  summarySheet.addRow(['Recommended Action', summary.recommendedAction]);
  const fileName = `contract-review_${Date.now()}.xlsx`;
  const outPath = path.join(LOCAL_OUTPUTS_DIR, fileName);
  await workbook.xlsx.writeFile(outPath);
  return { fileName, outPath };
}

async function documentControllerTask() {
  ensureDirSync(DOCUMENT_TASKS_DIR);
  const taskFiles = fs.readdirSync(DOCUMENT_TASKS_DIR).filter(file => file.endsWith('.json'));
  if (!taskFiles.length) return;
  console.log(`📆 document controller task runner found ${taskFiles.length} task(s)`);
  for (const fileName of taskFiles) {
    const filePath = path.join(DOCUMENT_TASKS_DIR, fileName);
    try {
      const task = JSON.parse(fs.readFileSync(filePath, 'utf8'));
      if (task.type === 'project-indexer' && task.folderPath) {
        console.log(`Processing scheduled project indexer task for ${task.folderPath}`);
        await generateProjectIndex(task.folderPath, true);
      }
      fs.renameSync(filePath, `${filePath}.processed`);
    } catch (err) {
      console.error('Failed to process document task', fileName, err);
    }
  }
}

cron.schedule('*/30 * * * *', async () => {
  try {
    await documentControllerTask();
  } catch (err) {
    console.error('Scheduled document controller failed', err);
  }
});

function appendAuditEntry(entry) {
  try {
    if (!fs.existsSync(AUDIT_LOG_DIR)) fs.mkdirSync(AUDIT_LOG_DIR, { recursive: true });
    const line = JSON.stringify(Object.assign({ ts: new Date().toISOString() }, entry)) + '\n';
    fs.appendFileSync(AUDIT_LOG_PATH, line);
    // also insert into sqlite audit DB (best-effort)
    auditStore.insertAudit(entry).catch(err => console.error('DB audit insert failed', err));
  } catch (e) {
    console.error('Failed to write audit log', e);
  }
}

// Middleware
app.use(cors());
app.use(express.json());

const reactBuildPath = path.join(__dirname, 'frontend', 'dist');
const hasReactBuild = fs.existsSync(reactBuildPath);
if (hasReactBuild) {
  app.use(express.static(reactBuildPath));
}
app.use(express.static('public'));

// Multer config for file uploads
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    const uploadDir = path.join(os.tmpdir(), 'uploads');
    if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir, { recursive: true });
    cb(null, uploadDir);
  },
  filename: (req, file, cb) => {
    const unique = Date.now() + '-' + Math.round(Math.random() * 1e9);
    cb(null, unique + '-' + file.originalname);
  }
});
const upload = multer({ storage });

// Initialize the new Google Gen AI client
const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });

// Helper: parse CSV file to JSON
function parseCSV(input) {
  return new Promise((resolve, reject) => {
    const results = [];
    let stream;
    if (Buffer.isBuffer(input)) {
      stream = Readable.from(input);
    } else {
      stream = fs.createReadStream(input);
    }
    stream
      .pipe(csv())
      .on('data', (data) => results.push(data))
      .on('end', () => resolve(results))
      .on('error', reject);
  });
}

// Helper: extract text from PDF
async function extractPDFText(input) {
  let dataBuffer;
  if (Buffer.isBuffer(input)) {
    dataBuffer = input;
  } else {
    dataBuffer = fs.readFileSync(input);
  }

  let data;
  if (typeof PDFParse === 'function') {
    const parser = new PDFParse({ data: dataBuffer });
    if (typeof parser.getText === 'function') {
      data = await parser.getText();
    } else {
      data = await parser;
    }
  } else {
    data = await PDFParse(dataBuffer);
  }

  if (typeof data === 'string') {
    return data;
  }
  return data?.text || '';
}

async function streamToBuffer(stream) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    stream.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
    stream.on('end', () => resolve(Buffer.concat(chunks)));
    stream.on('error', reject);
  });
}

async function fetchS3Object(s3, bucket, key) {
  const res = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
  const body = res.Body;
  // Body can be a stream
  const buffer = await streamToBuffer(body);
  return buffer;
}

async function fetchObject(provider, client, bucket, key) {
  if (provider === 's3') {
    return await fetchS3Object(client, bucket, key);
  }
  if (provider === 'gcs') {
    const file = client.bucket(bucket).file(key);
    const [buffer] = await file.download();
    return buffer;
  }
  throw new Error('Unsupported storage provider');
}

// Presign endpoint: returns a presigned PUT URL and the S3 key to use
app.post('/api/presign-upload', async (req, res) => {
  try {
    const { filename, contentType } = req.body || {};
    if (!filename) return res.status(400).json({ error: 'filename is required' });

    const provider = STORAGE_PROVIDER;
    if (provider === 'local') return res.status(400).json({ error: 'Local storage mode does not support presigned uploads. Use multipart upload instead.' });

    const key = `uploads/${Date.now()}-${Math.round(Math.random() * 1e9)}-${path.basename(filename)}`;
    const expiry = parseInt(process.env.SIGNED_URL_EXPIRY_UPLOAD || '900', 10); // default 15 minutes

    if (provider === 's3') {
      if (!process.env.S3_BUCKET || !process.env.AWS_REGION) return res.status(400).json({ error: 'S3_BUCKET and AWS_REGION must be configured' });
      const s3 = new S3Client({ region: process.env.AWS_REGION });
      const putCmd = new PutObjectCommand({ Bucket: process.env.S3_BUCKET, Key: key, ContentType: contentType || 'application/octet-stream' });
      const url = await getSignedUrl(s3, putCmd, { expiresIn: expiry });
      return res.json({ url, key, expiresIn: expiry });
    }

    if (provider === 'gcs') {
      if (!process.env.GCS_BUCKET) return res.status(400).json({ error: 'GCS_BUCKET must be configured' });
      const storage = new Storage();
      const file = storage.bucket(process.env.GCS_BUCKET).file(key);
      const [url] = await file.getSignedUrl({ version: 'v4', action: 'write', expires: Date.now() + expiry * 1000, contentType: contentType || 'application/octet-stream' });
      return res.json({ url, key, expiresIn: expiry });
    }

    res.status(400).json({ error: 'Unsupported storage provider' });
  } catch (err) {
    console.error('Presign error:', err);
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/config', (req, res) => {
  res.json({ provider: STORAGE_PROVIDER, bucket: STORAGE_PROVIDER === 's3' ? process.env.S3_BUCKET : (STORAGE_PROVIDER === 'gcs' ? process.env.GCS_BUCKET : null) });
});

app.get('/api/acceptable-terms', (req, res) => {
  res.json({ acceptableTerms });
});

function sanitizeRelativeFolderPath(folderPath) {
  const resolved = path.resolve(process.cwd(), folderPath || path.join('uploads', 'project-documents'));
  if (!resolved.startsWith(path.resolve(process.cwd()))) {
    throw new Error('Invalid folder path');
  }
  return resolved;
}

async function listFilesRecursive(dir, depth = 0, maxDepth = 3) {
  if (depth > maxDepth) return [];
  const entries = await fs.promises.readdir(dir, { withFileTypes: true });
  const results = [];
  for (const entry of entries) {
    const entryPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      results.push(...await listFilesRecursive(entryPath, depth + 1, maxDepth));
    } else if (entry.isFile()) {
      results.push(entryPath);
    }
  }
  return results;
}

function classifyProjectFile(filePath) {
  const name = path.basename(filePath);
  const extension = path.extname(name).toLowerCase();
  const drawingHint = /\bGA\b|\bplan\b|\belevation\b|\bsection\b|[ASMEP]-/i;
  if (extension === '.pdf' && drawingHint.test(name)) return 'drawing';
  if (['.pdf', '.txt', '.md'].includes(extension)) return 'document';
  return 'other';
}

async function summarizeProjectFile(filePath) {
  const extension = path.extname(filePath).toLowerCase();
  const name = path.basename(filePath);
  if (extension === '.pdf') {
    try {
      const text = await extractPDFText(filePath);
      return { fileName: name, summary: text ? text.slice(0, 400).replace(/\s+/g, ' ') : 'PDF text extraction returned no text.' };
    } catch (err) {
      return { fileName: name, summary: 'PDF parsing failed or image-based PDF.' };
    }
  }
  if (extension === '.txt' || extension === '.md') {
    const text = await fs.promises.readFile(filePath, 'utf8');
    return { fileName: name, summary: text.slice(0, 400).replace(/\s+/g, ' ') };
  }
  return { fileName: name, summary: `${extension.slice(1).toUpperCase()} file` };
}

async function generateProjectIndex(folderPath, isScheduled = false) {
  const rootFolder = sanitizeRelativeFolderPath(folderPath);
  if (!fs.existsSync(rootFolder)) {
    throw new Error(`Project folder not found: ${rootFolder}`);
  }
  const allFiles = await listFilesRecursive(rootFolder);
  const drawings = [];
  const documents = [];
  const other = [];
  for (const filePath of allFiles) {
    const type = classifyProjectFile(filePath);
    const summary = await summarizeProjectFile(filePath);
    if (type === 'drawing') drawings.push({ path: path.relative(process.cwd(), filePath), ...summary });
    else if (type === 'document') documents.push({ path: path.relative(process.cwd(), filePath), ...summary });
    else other.push({ path: path.relative(process.cwd(), filePath), ...summary });
  }
  ensureDirSync(PROJECT_INDEX_OUTPUT_DIR);
  const outputFile = path.join(PROJECT_INDEX_OUTPUT_DIR, `claude_${Date.now()}.md`);
  const projectName = path.basename(rootFolder);
  const folderLines = [
    `# Project: ${projectName}`,
    '',
    '## Folder Structure',
    `- ` + path.relative(process.cwd(), rootFolder) + ` – contains ${drawings.length + documents.length + other.length} files`,
    `- \`drawings/\` – contains ${drawings.length} drawings`,
    `- \`documents/\` – contains ${documents.length} documents`,
    `- \`other/\` – contains ${other.length} other files`,
    ''
  ];
  const drawingLines = [
    '## Drawings Index',
    '| Drawing No | Title | Summary (key info) |',
    '|------------|-------|---------------------|'
  ];
  drawings.forEach(item => {
    drawingLines.push(`| ${path.basename(item.fileName)} | ${item.fileName} | ${item.summary.slice(0, 120)} |`);
  });
  const documentLines = [
    '',
    '## Document Index',
    '| File | Type | Summary |',
    '|------|------|---------|'
  ];
  documents.forEach(item => {
    documentLines.push(`| ${item.fileName} | document | ${item.summary.slice(0, 120)} |`);
  });
  other.forEach(item => {
    documentLines.push(`| ${item.fileName} | other | ${item.summary.slice(0, 120)} |`);
  });
  const howToLines = [
    '',
    '## How to Answer Questions',
    'When asked about this project, first read this `claude.md` file. For detailed drawing info, refer to the individual `.md` summaries in the `_ai/` folder.',
    ''
  ];
  await fs.promises.writeFile(outputFile, folderLines.concat(drawingLines, documentLines, howToLines).join('\n'), 'utf8');
  return { outputFile: path.relative(process.cwd(), outputFile), drawings: drawings.length, documents: documents.length, other: other.length };
}

app.post('/api/document-tasks', async (req, res) => {
  try {
    const { type, folderPath } = req.body || {};
    if (!type) return res.status(400).json({ error: 'Task type is required' });
    ensureDirSync(DOCUMENT_TASKS_DIR);
    const taskFile = `task_${Date.now()}_${Math.round(Math.random() * 1e9)}.json`;
    const task = { type, folderPath: folderPath || 'uploads/project-documents', createdAt: new Date().toISOString() };
    fs.writeFileSync(path.join(DOCUMENT_TASKS_DIR, taskFile), JSON.stringify(task, null, 2), 'utf8');
    res.json({ queued: true, taskFile, task });
  } catch (err) {
    console.error('Failed to queue document task', err);
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/document-tasks', (req, res) => {
  ensureDirSync(DOCUMENT_TASKS_DIR);
  const tasks = fs.readdirSync(DOCUMENT_TASKS_DIR)
    .filter(file => file.endsWith('.json'))
    .map(file => ({ file, path: path.join(DOCUMENT_TASKS_DIR, file) }));
  res.json({ tasks });
});

app.post('/api/project-indexer', async (req, res) => {
  try {
    const folderPath = req.body.folderPath || path.join('uploads', 'project-documents');
    const result = await generateProjectIndex(folderPath);
    res.json({ success: true, indexFile: result.outputFile, counts: { drawings: result.drawings, documents: result.documents, other: result.other } });
  } catch (err) {
    console.error('Project indexer error', err);
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/procurement-packages', upload.none(), (req, res) => {
  res.status(501).json({
    error: 'Procurement packages endpoint is reserved for future implementation.',
    message: 'Use /api/project-indexer or /api/contract-review for current document skills.'
  });
});

app.post('/api/contract-review', upload.single('contract'), async (req, res) => {
  try {
    const provider = STORAGE_PROVIDER;
    const useStorage = provider === 's3' || provider === 'gcs';
    let s3 = null;
    let gcs = null;
    if (provider === 's3') s3 = new S3Client({ region: process.env.AWS_REGION });
    if (provider === 'gcs') gcs = new Storage();
    const bucketName = provider === 's3' ? process.env.S3_BUCKET : (provider === 'gcs' ? process.env.GCS_BUCKET : null);

    let contractText = '';
    if (req.body.contractKey) {
      if (!useStorage) return res.status(400).json({ error: 'Local storage mode does not support object keys. Use multipart upload instead.' });
      const contractBuf = await fetchObject(provider, provider === 's3' ? s3 : gcs, bucketName, req.body.contractKey);
      contractText = await extractPDFText(contractBuf);
      appendAuditEntry({ action: 'contract-review-use-key', provider, bucket: bucketName, contractKey: req.body.contractKey, ip: req.ip });
    } else if (req.file) {
      const ext = path.extname(req.file.originalname).toLowerCase();
      if (ext === '.pdf') {
        contractText = await extractPDFText(req.file.path);
      } else {
        contractText = fs.readFileSync(req.file.path, 'utf8');
      }
      if (useStorage) {
        const key = `uploads/${Date.now()}-${Math.round(Math.random() * 1e9)}-${path.basename(req.file.originalname)}`;
        if (provider === 's3') {
          await s3.send(new PutObjectCommand({ Bucket: process.env.S3_BUCKET, Key: key, Body: fs.createReadStream(req.file.path), ContentType: req.file.mimetype || 'application/pdf' }));
        } else if (provider === 'gcs') {
          await gcs.bucket(process.env.GCS_BUCKET).upload(req.file.path, { destination: key, contentType: req.file.mimetype || 'application/pdf' });
        }
        appendAuditEntry({ action: 'contract-review-upload', provider, bucket: bucketName, contractKey: key, ip: req.ip });
      }
    } else {
      return res.status(400).json({ error: 'Contract file or contractKey is required' });
    }

    const rows = buildContractReviewRows(contractText);
    const summary = buildExecutiveSummary(rows);
    const workbook = await writeContractReviewWorkbook(rows, summary);

    let downloadPath = `/downloads/${workbook.fileName}`;
    if (useStorage) {
      const key = `contract-reviews/${workbook.fileName}`;
      if (provider === 's3') {
        await s3.send(new PutObjectCommand({ Bucket: process.env.S3_BUCKET, Key: key, Body: fs.createReadStream(workbook.outPath), ContentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }));
        downloadPath = await getSignedUrl(s3, new GetObjectCommand({ Bucket: process.env.S3_BUCKET, Key: key }), { expiresIn: parseInt(process.env.SIGNED_URL_EXPIRY || '604800', 10) });
      } else if (provider === 'gcs') {
        await gcs.bucket(process.env.GCS_BUCKET).upload(workbook.outPath, { destination: key, contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
        const file = gcs.bucket(process.env.GCS_BUCKET).file(key);
        const [url] = await file.getSignedUrl({ version: 'v4', action: 'read', expires: Date.now() + parseInt(process.env.SIGNED_URL_EXPIRY || '604800', 10) * 1000 });
        downloadPath = url;
      }
    }

    if (!process.env.S3_BUCKET && !process.env.GCS_BUCKET) {
      ensureDirSync(LOCAL_OUTPUTS_DIR);
      downloadPath = `/downloads/${workbook.fileName}`;
    }

    if (req.file && req.file.path) {
      fs.unlink(req.file.path, () => {});
    }

    res.json({
      success: true,
      departuresRegister: rows,
      criticalFindings: summary.bullets,
      recommendedAction: summary.recommendedAction,
      excelDownloadPath: downloadPath
    });
  } catch (err) {
    console.error('Contract review error:', err);
    res.status(500).json({ error: err.message });
  }
});

// Main estimation endpoint
app.post('/api/estimate', upload.fields([
  { name: 'drawings', maxCount: 5 },
  { name: 'costCodes', maxCount: 1 },
  { name: 'sampleEstimate', maxCount: 1 },
  { name: 'projectNotes', maxCount: 1 }
]), async (req, res) => {
  try {
    const projectNotes = req.body.projectNotes || '';

    // Support direct storage workflow: client uploads files to storage using presigned PUT URLs
    // then sends keys in the request body. Fallback to multipart upload via multer.
    const provider = STORAGE_PROVIDER;
    const useStorage = provider === 's3' || provider === 'gcs';
    let s3 = null;
    let gcs = null;
    if (provider === 's3') s3 = new S3Client({ region: process.env.AWS_REGION });
    if (provider === 'gcs') gcs = new Storage();
    const bucketName = provider === 's3' ? process.env.S3_BUCKET : (provider === 'gcs' ? process.env.GCS_BUCKET : null);

    let costCodes;
    let sampleEstimate;
    let drawingsText = '';
    let drawingFiles, costCodeFile, sampleEstimateFile;

    if (req.body.costCodeKey && req.body.sampleEstimateKey) {
      // Client supplied storage keys
      if (!useStorage) return res.status(400).json({ error: 'Local storage mode does not support object keys. Use multipart file upload instead.' });
      const costBuf = await fetchObject(provider, provider === 's3' ? s3 : gcs, bucketName, req.body.costCodeKey);
      const sampleBuf = await fetchObject(provider, provider === 's3' ? s3 : gcs, bucketName, req.body.sampleEstimateKey);
      costCodes = await parseCSV(costBuf);
      sampleEstimate = await parseCSV(sampleBuf);

      const drawingKeys = req.body.drawingKeys ? JSON.parse(req.body.drawingKeys) : [];
      for (const key of drawingKeys.slice(0, 3)) {
        const pdfBuf = await fetchObject(provider, provider === 's3' ? s3 : gcs, bucketName, key);
        const text = await extractPDFText(pdfBuf);
        drawingsText += `\n--- ${key} ---\n${text.slice(0, 8000)}`;
      }
    } else {
      // Fallback to multer file uploads
      drawingFiles = req.files['drawings'] || [];
      costCodeFile = req.files['costCodes'] ? req.files['costCodes'][0] : null;
      sampleEstimateFile = req.files['sampleEstimate'] ? req.files['sampleEstimate'][0] : null;

      if (!costCodeFile || !sampleEstimateFile) {
        return res.status(400).json({ error: 'Cost codes and sample estimate are required' });
      }

      costCodes = await parseCSV(costCodeFile.path);
      sampleEstimate = await parseCSV(sampleEstimateFile.path);

      for (const file of drawingFiles.slice(0, 3)) {
        const text = await extractPDFText(file.path);
        drawingsText += `\n--- ${file.originalname} ---\n${text.slice(0, 8000)}`;
      }

      // Persist incoming multipart uploads to storage so inputs are retained for auditing
      if (useStorage) {
        const uploadedInputKeys = { costCodeKey: null, sampleEstimateKey: null, drawingKeys: [] };

        const uploadFileToStorage = async (filePath, originalname, contentType) => {
          const key = `uploads/${Date.now()}-${Math.round(Math.random() * 1e9)}-${path.basename(originalname)}`;
          if (provider === 's3') {
            await s3.send(new PutObjectCommand({ Bucket: process.env.S3_BUCKET, Key: key, Body: fs.createReadStream(filePath), ContentType: contentType || 'application/octet-stream' }));
            return key;
          }
          if (provider === 'gcs') {
            await gcs.bucket(process.env.GCS_BUCKET).upload(filePath, { destination: key, contentType: contentType || 'application/octet-stream' });
            return key;
          }
          throw new Error('Unsupported provider for upload');
        };

        try {
          uploadedInputKeys.costCodeKey = await uploadFileToStorage(costCodeFile.path, costCodeFile.originalname, 'text/csv');
          uploadedInputKeys.sampleEstimateKey = await uploadFileToStorage(sampleEstimateFile.path, sampleEstimateFile.originalname, 'text/csv');
          for (const f of drawingFiles) {
            const k = await uploadFileToStorage(f.path, f.originalname, 'application/pdf');
            uploadedInputKeys.drawingKeys.push(k);
          }
          // Attach the uploaded input keys so client or logs can reference them
          req.uploadedInputKeys = uploadedInputKeys;
          // Audit log the persisted input keys
          appendAuditEntry({ action: 'persist-inputs', provider, bucket: bucketName, keys: uploadedInputKeys, ip: req.ip });
        } catch (uploadErr) {
          console.error('Failed to upload input files to storage:', uploadErr);
        }
      }
    }

    // If client supplied keys, audit their usage
    if (req.body.costCodeKey && req.body.sampleEstimateKey) {
      appendAuditEntry({ action: 'use-input-keys', provider, bucket: bucketName, costCodeKey: req.body.costCodeKey, sampleEstimateKey: req.body.sampleEstimateKey, drawingKeys: req.body.drawingKeys ? JSON.parse(req.body.drawingKeys) : [], ip: req.ip });
    }

    // System prompt (10-step estimator process)
    const prompt = `You are an expert residential construction estimator with 21+ years of experience.
Follow this EXACT 10-step estimating process:

1. Analyze drawings and ask qualifying questions (size, complexity, finishes)
2. Break project into scope categories: Sitework, Foundation, Framing, Exterior Finish, Roofing, Rough-ins (Plumbing/Electrical/HVAC), Insulation, Drywall, Interior Trim, Cabinets, Flooring, Paint, Fixtures, Final Trades, Cleanup
3. Write scope descriptions using the six writing styles from the sample estimate
4. Use the provided cost codes (CSV) with COG column (labor/material/trade)
5. Perform quantity takeoffs directly from drawings (linear feet, square feet, each)
6. Generate a structured estimate table with: Cost Code, Scope Description, Quantity, Unit, Unit Cost, Total, COG
7. Create an allowances list for selections not specified
8. Create Inclusions, Exclusions & Assumptions document
9. Output format: Return ONLY valid JSON with three keys: "estimate" (array of rows), "allowances" (array of strings), "iea" (object with inclusions, exclusions, assumptions arrays)
10. Use realistic unit costs based on national averages (adjust +/- 15% by project complexity)

CRITICAL: Do not add any text outside the JSON. Use real numbers.

Here is the project data:

DRAWINGS TEXT (extracted from PDFs):
${drawingsText || 'No drawings provided. Generate a generic 2,500 sq ft custom home estimate.'}

PROJECT NOTES FROM BUILDER:
${projectNotes || 'Standard custom home, mid-grade finishes, typical local codes.'}

COST CODES (CSV data):
${JSON.stringify(costCodes.slice(0, 20), null, 2)}

SAMPLE ESTIMATE (my writing style reference):
${JSON.stringify(sampleEstimate.slice(0, 10), null, 2)}

Now, follow the 10-step process and generate the estimate in JSON format.
Return ONLY valid JSON.`;

    // Call the new Gemini API with a supported free model, or use mock when configured
    let responseText;
    if (process.env.MOCK_GENAI === 'true') {
      // Return a simple deterministic fake JSON matching expected format
      const fake = {
        estimate: [
          { CostCode: '100', Scope: 'Excavation', Quantity: 100, Unit: 'CY', UnitCost: 15, Total: 1500, COG: 'labor' }
        ],
        allowances: ['Allowance for windows: $5,000'],
        iea: { inclusions: ['Site cleanup'], exclusions: ['Permit fees'], assumptions: ['Standard soil conditions'] }
      };
      responseText = JSON.stringify(fake);
    } else {
      const response = await ai.models.generateContent({ model: 'gemini-1.5-flash', contents: [{ role: 'user', parts: [{ text: prompt }] }], });
      responseText = response.text;
    }

    // Parse JSON
    let parsed;
    try {
      const jsonMatch = responseText.match(/```json\n([\s\S]*?)\n```/) || responseText.match(/(\{[\s\S]*\})/);
      const jsonStr = jsonMatch ? (jsonMatch[1] || jsonMatch[0]) : responseText;
      parsed = JSON.parse(jsonStr);
    } catch (e) {
      console.error('Failed to parse Gemini response:', responseText);
      return res.status(500).json({ error: 'Gemini returned invalid JSON', raw: responseText });
    }

    // Generate CSV file. Use a local outputs folder for persistent local mode, and fallback to the same folder for cloud uploads.
    const csvOutputDir = LOCAL_OUTPUTS_DIR;
    if (!fs.existsSync(csvOutputDir)) fs.mkdirSync(csvOutputDir, { recursive: true });
    const csvPath = path.join(csvOutputDir, `estimate_${Date.now()}.csv`);

    if (parsed.estimate && parsed.estimate.length > 0) {
      const csvWriter = createObjectCsvWriter({
        path: csvPath,
        header: Object.keys(parsed.estimate[0]).map(key => ({ id: key, title: key }))
      });
      await csvWriter.writeRecords(parsed.estimate);
    }
    // Upload the generated CSV to storage (if configured) and return a presigned download URL.
    let csvDownloadPath = null;
    if (useStorage) {
      const key = `estimates/${path.basename(csvPath)}`;
      if (provider === 's3') {
        await s3.send(new PutObjectCommand({ Bucket: process.env.S3_BUCKET, Key: key, Body: fs.createReadStream(csvPath), ContentType: 'text/csv' }));
        const expiry = parseInt(process.env.SIGNED_URL_EXPIRY || '604800', 10);
        csvDownloadPath = await getSignedUrl(s3, new GetObjectCommand({ Bucket: process.env.S3_BUCKET, Key: key }), { expiresIn: expiry });
      } else if (provider === 'gcs') {
        await gcs.bucket(process.env.GCS_BUCKET).upload(csvPath, { destination: key, contentType: 'text/csv' });
        const expiry = parseInt(process.env.SIGNED_URL_EXPIRY || '604800', 10);
        const file = gcs.bucket(process.env.GCS_BUCKET).file(key);
        const [url] = await file.getSignedUrl({ version: 'v4', action: 'read', expires: Date.now() + expiry * 1000 });
        csvDownloadPath = url;
      }
    } else {
      // Fallback: serve from local outputs folder (local/dev mode)
      csvDownloadPath = `/downloads/${path.basename(csvPath)}`;
    }

    // Determine input keys to return
    let inputKeys = null;
    if (req.body.costCodeKey && req.body.sampleEstimateKey) {
      inputKeys = { costCodeKey: req.body.costCodeKey, sampleEstimateKey: req.body.sampleEstimateKey, drawingKeys: req.body.drawingKeys ? JSON.parse(req.body.drawingKeys) : [] };
    } else if (req.uploadedInputKeys) {
      inputKeys = req.uploadedInputKeys;
    }

    res.json({
      success: true,
      estimate: parsed.estimate || [],
      allowances: parsed.allowances || [],
      iea: parsed.iea || { inclusions: [], exclusions: [], assumptions: [] },
      csvDownloadPath,
      inputKeys
    });

    // Cleanup uploaded files
    setTimeout(() => {
      [drawingFiles, costCodeFile, sampleEstimateFile].flat().forEach(f => {
        if (f && f.path) fs.unlink(f.path, () => {});
      });

      // Remove local CSV only when it was uploaded to cloud storage
      if (useStorage && fs.existsSync(csvPath)) {
        fs.unlink(csvPath, () => {});
      }
    }, 5000);

  } catch (error) {
    console.error('Estimation error:', error);
    res.status(500).json({ error: error.message });
  }
});

// If not using S3, serve generated CSV files from the temp outputs dir (only local/dev)
if (!process.env.S3_BUCKET) {
  if (!fs.existsSync(LOCAL_OUTPUTS_DIR)) fs.mkdirSync(LOCAL_OUTPUTS_DIR, { recursive: true });
  app.use('/downloads', express.static(LOCAL_OUTPUTS_DIR));
}

const fallbackIndex = hasReactBuild ? path.join(reactBuildPath, 'index.html') : path.join(process.cwd(), 'public', 'index.html');
app.get(/^\/(?!api\/|downloads\/|assets\/).*/, (req, res, next) => {
  if (req.method !== 'GET') return next();
  if (req.path.startsWith('/api/') || req.path.startsWith('/downloads/') || req.path.startsWith('/assets/')) return next();
  if (!fs.existsSync(fallbackIndex)) return res.status(404).send('Not Found');
  res.sendFile(fallbackIndex);
});

if (require.main === module) {
  app.listen(PORT, () => {
    console.log(`✅ AI Estimator running on http://localhost:${PORT}`);
  });
}

// Export the app for serverless platforms
module.exports = app;