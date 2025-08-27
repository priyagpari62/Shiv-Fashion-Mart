require('dotenv').config();
const express = require('express');
const multer = require('multer');
const cloudinary = require('cloudinary').v2;
const streamifier = require('streamifier');
const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');
const nodemailer = require('nodemailer');
const bodyParser = require('body-parser');
const serverless = require('serverless-http');

const app = express();

// Configure Cloudinary
cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET,
});

// Setup DB (use /tmp on Vercel for writable storage)
const dbPath = process.env.NODE_ENV === 'production'
  ? path.join('/tmp', 'submissions.db')
  : path.join(__dirname, 'data', 'submissions.db');

fs.mkdirSync(path.dirname(dbPath), { recursive: true });
const db = new Database(dbPath);

db.exec(`
CREATE TABLE IF NOT EXISTS submissions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  contact TEXT NOT NULL,
  email TEXT,
  product_links TEXT,
  image_urls TEXT,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  status TEXT DEFAULT 'pending'
);
`);

// Configure multer (memory storage)
const upload = multer({ storage: multer.memoryStorage() });

// JSON body parsing
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));

// Serve static frontend (optional in serverless)
app.use(express.static(path.join(__dirname, 'public')));

// Helper: upload buffer to Cloudinary
function uploadBufferToCloudinary(buffer) {
  return new Promise((resolve, reject) => {
    const uploadStream = cloudinary.uploader.upload_stream(
      { folder: 'shiv-fashion-mart' },
      (error, result) => {
        if (error) return reject(error);
        resolve(result.secure_url);
      }
    );
    streamifier.createReadStream(buffer).pipe(uploadStream);
  });
}

// Nodemailer transporter
let transporter = null;
if (process.env.SMTP_HOST) {
  transporter = nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port: Number(process.env.SMTP_PORT || 587),
    secure: false,
    auth: {
      user: process.env.SMTP_USER,
      pass: process.env.SMTP_PASS,
    },
  });
}

// Main form submission route
app.post('/api/submit', upload.array('images', 6), async (req, res) => {
  try {
    const { name, contact, email, links } = req.body;
    if (!name || !contact) {
      return res.status(400).json({ error: 'Name and contact are required.' });
    }

    const linksArray = (links || '').split('\n').map(s => s.trim()).filter(Boolean);
    const files = req.files || [];

    // Upload images to Cloudinary
    const uploadedUrls = [];
    for (const file of files) {
      const url = await uploadBufferToCloudinary(file.buffer);
      uploadedUrls.push(url);
    }

    // Save in DB
    const insert = db.prepare(`
      INSERT INTO submissions (name, contact, email, product_links, image_urls)
      VALUES (?, ?, ?, ?, ?)
    `);
    insert.run(name, contact, email || '', JSON.stringify(linksArray), JSON.stringify(uploadedUrls));

    // Send emails
    if (transporter) {
      const htmlLinks = linksArray.map(l => `<li><a href="${l}" target="_blank">${l}</a></li>`).join('');
      const htmlImages = uploadedUrls.map(u => `<li><a href="${u}" target="_blank">${u}</a></li>`).join('');

      await transporter.sendMail({
        from: process.env.FROM_EMAIL,
        to: process.env.SMTP_USER,
        subject: `New product submission from ${name}`,
        html: `<p><strong>Name:</strong> ${name}</p>
               <p><strong>Contact:</strong> ${contact}</p>
               <p><strong>Email:</strong> ${email || 'N/A'}</p>
               <p><strong>Links:</strong></p><ul>${htmlLinks}</ul>
               <p><strong>Images:</strong></p><ul>${htmlImages}</ul>`
      });

      if (email) {
        await transporter.sendMail({
          from: process.env.FROM_EMAIL,
          to: email,
          subject: "Thank You for Your Submission - Shiv Fashion Mart",
          html: `<p>Dear ${name},</p>
                 <p>Thank you for submitting your product details to Shiv Fashion Mart.</p>
                 <p>We’re excited to offer you a <strong>20% discount</strong> on your next purchase!</p>
                 <p>Our team will contact you shortly.</p>
                 <p>Best regards,<br>Shiv Fashion Mart Team</p>`
        });
      }
    }

    res.json({ success: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error', details: err.message });
  }
});

// Admin route
app.get('/admin/submissions', (req, res) => {
  const rows = db.prepare('SELECT * FROM submissions ORDER BY created_at DESC').all();
  const parsed = rows.map(r => ({
    ...r,
    product_links: JSON.parse(r.product_links || '[]'),
    image_urls: JSON.parse(r.image_urls || '[]')
  }));
  res.json(parsed);
});

// Export for Vercel
module.exports = app;
module.exports.handler = serverless(app);

// Disable Next.js body parser (important for file uploads)
module.exports.config = {
  api: {
    bodyParser: false
  }
};

