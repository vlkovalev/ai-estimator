const express = require('express');
const multer = require('multer');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const pdfParse = require('pdf-parse');
const csv = require('csv-parser');
const { createObjectCsvWriter } = require('csv-writer');
const { GoogleGenerativeAI } = require("@google/generative-ai");

require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.static('public'));

// Multer config for file uploads
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    const uploadDir = './uploads';
    if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir);
    cb(null, uploadDir);
  },
  filename: (req, file, cb) => {
    const unique = Date.now() + '-' + Math.round(Math.random() * 1e9);
    cb(null, unique + '-' + file.originalname);
  }
});
const upload = multer({ storage });

// Initialize Gemini
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
const model = genAI.getGenerativeModel({ model: "gemini-1.5-flash" });

// Helper: parse CSV file to JSON
function parseCSV(filePath) {
  return new Promise((resolve, reject) => {
    const results = [];
    fs.createReadStream(filePath)
      .pipe(csv())
      .on('data', (data) => results.push(data))
      .on('end', () => resolve(results))
      .on('error', reject);
  });
}

// Helper: extract text from PDF
async function extractPDFText(filePath) {
  const dataBuffer = fs.readFileSync(filePath);
  const data = await pdfParse(dataBuffer);
  return data.text;
}

// Main estimation endpoint
app.post('/api/estimate', upload.fields([
  { name: 'drawings', maxCount: 5 },
  { name: 'costCodes', maxCount: 1 },
  { name: 'sampleEstimate', maxCount: 1 },
  { name: 'projectNotes', maxCount: 1 }
]), async (req, res) => {
  try {
    const drawingFiles = req.files['drawings'] || [];
    const costCodeFile = req.files['costCodes'] ? req.files['costCodes'][0] : null;
    const sampleEstimateFile = req.files['sampleEstimate'] ? req.files['sampleEstimate'][0] : null;
    const projectNotes = req.body.projectNotes || '';

    if (!costCodeFile || !sampleEstimateFile) {
      return res.status(400).json({ error: 'Cost codes and sample estimate are required' });
    }

    const costCodes = await parseCSV(costCodeFile.path);
    const sampleEstimate = await parseCSV(sampleEstimateFile.path);

    let drawingsText = '';
    for (const file of drawingFiles.slice(0, 3)) {
      const text = await extractPDFText(file.path);
      drawingsText += `\n--- ${file.originalname} ---\n${text.slice(0, 8000)}`;
    }

    // System prompt (10-step estimator process)
    const systemPrompt = `You are an expert residential construction estimator with 21+ years of experience.
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

CRITICAL: Do not add any text outside the JSON. Use real numbers.`;

    const userPrompt = `Here is the project data:

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

    // Call Gemini
    const fullPrompt = systemPrompt + "\n\n" + userPrompt;
    const result = await model.generateContent(fullPrompt);
    const responseText = result.response.text();

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

    // Generate CSV file
    const csvOutputDir = './outputs';
    if (!fs.existsSync(csvOutputDir)) fs.mkdirSync(csvOutputDir);
    const csvPath = path.join(csvOutputDir, `estimate_${Date.now()}.csv`);

    if (parsed.estimate && parsed.estimate.length > 0) {
      const csvWriter = createObjectCsvWriter({
        path: csvPath,
        header: Object.keys(parsed.estimate[0]).map(key => ({ id: key, title: key }))
      });
      await csvWriter.writeRecords(parsed.estimate);
    }

    res.json({
      success: true,
      estimate: parsed.estimate || [],
      allowances: parsed.allowances || [],
      iea: parsed.iea || { inclusions: [], exclusions: [], assumptions: [] },
      csvDownloadPath: `/downloads/${path.basename(csvPath)}`
    });

    // Cleanup uploaded files
    setTimeout(() => {
      [drawingFiles, costCodeFile, sampleEstimateFile].flat().forEach(f => {
        if (f && f.path) fs.unlink(f.path, () => {});
      });
    }, 5000);

  } catch (error) {
    console.error('Estimation error:', error);
    res.status(500).json({ error: error.message });
  }
});

// Serve generated CSV files
app.use('/downloads', express.static('./outputs'));

app.listen(PORT, () => {
  console.log(`✅ AI Estimator running on http://localhost:${PORT}`);
});