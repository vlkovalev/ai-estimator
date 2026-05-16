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
const pdfParse = require('pdf-parse');
const csv = require('csv-parser');
const { createObjectCsvWriter } = require('csv-writer');
const { GoogleGenAI } = require("@google/genai");

require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3000;
const AUDIT_LOG_DIR = path.join(process.cwd(), 'logs');
const AUDIT_LOG_PATH = path.join(AUDIT_LOG_DIR, 'input-uploads.log');
const auditStore = require('./lib/auditStore');

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
  const data = await pdfParse(dataBuffer);
  return data.text;
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

    const provider = process.env.STORAGE_PROVIDER || (process.env.S3_BUCKET ? 's3' : (process.env.GCS_BUCKET ? 'gcs' : null));
    if (!provider) return res.status(400).json({ error: 'No storage provider configured (S3_BUCKET or GCS_BUCKET)' });

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
    const provider = process.env.STORAGE_PROVIDER || (process.env.S3_BUCKET ? 's3' : (process.env.GCS_BUCKET ? 'gcs' : null));
    const useStorage = !!provider;
    let s3 = null;
    let gcs = null;
    if (provider === 's3') s3 = new S3Client({ region: process.env.AWS_REGION });
    if (provider === 'gcs') gcs = new Storage();
    const bucketName = provider === 's3' ? process.env.S3_BUCKET : process.env.GCS_BUCKET;

    let costCodes;
    let sampleEstimate;
    let drawingsText = '';
    let drawingFiles, costCodeFile, sampleEstimateFile;

    if (req.body.costCodeKey && req.body.sampleEstimateKey) {
      // Client supplied storage keys
      if (!useStorage) return res.status(400).json({ error: 'Storage provider not configured on server' });
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

    // Generate CSV file (use OS temp dir in serverless environments)
    const csvOutputDir = path.join(os.tmpdir(), 'outputs');
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
      // Fallback: serve from local temp outputs directory (only for local/dev use)
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

      // Remove local CSV if uploaded to S3
      if (fs.existsSync(csvPath)) {
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
  app.use('/downloads', express.static(path.join(os.tmpdir(), 'outputs')));
}

if (require.main === module) {
  app.listen(PORT, () => {
    console.log(`✅ AI Estimator running on http://localhost:${PORT}`);
  });
}

// Export the app for serverless platforms
module.exports = app;