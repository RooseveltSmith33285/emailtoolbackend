const express = require('express');
const multer = require('multer');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const axios = require('axios');

const csv = require('csv-parser');
const juice = require('juice');
const nodemailer = require('nodemailer');

const app = express();
const mongoose = require('mongoose');
const contactmodel = require('./contact');

const connect = mongoose.connect(`mongodb+srv://user:user@cluster0.pfn059x.mongodb.net/?retryWrites=true&w=majority&appName=Cluster0`);

// Middleware
app.use(cors());
app.use(express.json());

// Configure file upload storage
// const storage = multer.diskStorage({
//   destination: (req, file, cb) => {
//     const uploadDir = path.join(__dirname, 'uploads');
//     if (!fs.existsSync(uploadDir)) {
//       fs.mkdirSync(uploadDir, { recursive: true });
//     }
//     cb(null, uploadDir);
//   },
//   filename: (req, file, cb) => {
//     cb(null, `${Date.now()}-${file.originalname}`);
//   }
// });


// With this:
const storage = multer.memoryStorage(); // Stores files in memory


const upload = multer({
  storage: storage,
  limits: { fileSize: 25 * 1024 * 1024 }, // 25MB limit
  fileFilter: (req, file, cb) => {
    if (file.mimetype === 'application/pdf') {
      cb(null, true);
    } else {
      cb(new Error('Only PDF files are allowed'));
    }
  }
});

// Configure HTML upload
const htmlUpload = multer({
  storage: storage,
  limits: { fileSize: 10 * 1024 * 1024 }, // 10MB limit for HTML
  fileFilter: (req, file, cb) => {
    if (file.mimetype === 'text/html' || file.originalname.toLowerCase().endsWith('.html')) {
      cb(null, true);
    } else {
      cb(new Error('Only HTML files are allowed'));
    }
  }
});

// Configure CSV upload

const csvDiskStorage = multer.diskStorage({
    destination: (req, file, cb) => {
      const uploadDir = '/tmp'; // Use /tmp directory on Vercel
      cb(null, uploadDir);
    },
    filename: (req, file, cb) => {
      cb(null, `${Date.now()}-${file.originalname}`);
    }
  });
  
  const csvUploadDisk = multer({
    storage: csvDiskStorage,
    limits: { fileSize: 10 * 1024 * 1024 }, // 10MB limit for CSV
    fileFilter: (req, file, cb) => {
      if (file.mimetype === 'text/csv' || file.originalname.toLowerCase().endsWith('.csv')) {
        cb(null, true);
      } else {
        cb(new Error('Only CSV files are allowed'));
      }
    }
  });
  

// ConvertAPI configuration
const CONVERT_API_TOKEN = 'NRvX3zRchgRlgoURevXe6OSTqjxEj0go';
const CONVERT_API_URL = 'https://v2.convertapi.com/convert/pdf/to/html';

// HTML email template endpoint
app.post('/api/send-html-template', htmlUpload.single('htmlTemplate'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: 'No HTML file uploaded' });
    }

    // Use buffer instead of file path
    let htmlContent;
    if (req.file.buffer) {
      htmlContent = req.file.buffer.toString('utf8');
    } else if (req.file.path) {
      htmlContent = fs.readFileSync(req.file.path, 'utf8');
    } else {
      return res.status(400).json({ error: 'Invalid file upload' });
    }

    // Process HTML to make it email client compatible
    htmlContent = createEmailTemplate(htmlContent);

    // Rest of your code remains the same...
    const contacts = await contactmodel.find({});
    
    if (contacts.length === 0) {
      return res.status(400).json({ 
        error: 'No contacts found in database. Please upload contacts first.' 
      });
    }

    const transporter = createEmailTransporter();
    
    let successCount = 0;
    let failedCount = 0;
    const failedEmails = [];
    const emailSubject = "Enrichify mail";
    for (const contact of contacts) {
      try {
        await sendEmail(transporter, contact.email, htmlContent, emailSubject);
        successCount++;
        await new Promise(resolve => setTimeout(resolve, 200));
      } catch (emailError) {
        console.error(`Failed to send to ${contact.email}:`, emailError.message);
        failedCount++;
        failedEmails.push(contact.email);
      }
    }

    return res.json({
      success: true,
      message: `Emails sent successfully to ${successCount} contacts`,
      totalContacts: contacts.length,
      successCount,
      failedCount,
      failedEmails: failedEmails.length > 0 ? failedEmails : undefined,
      sampleHtml: htmlContent.substring(0, 500) + '...'
    });

  } catch (error) {
    console.error('HTML email sending error:', error);
    res.status(500).json({ 
      error: 'Failed to send HTML emails: ' + error.message 
    });
  }
});

// PDF to HTML conversion endpoint (existing)
app.post('/api/convert-template', upload.single('template'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: 'No file uploaded' });
    }

    const emailSubject = "Enrichify mail";
    const filePath = req.file.path;

    // Read the PDF file
    const pdfData = fs.readFileSync(filePath);
    const base64Data = pdfData.toString('base64');

    // Prepare ConvertAPI request with email-specific settings
    const payload = {
      Parameters: [
        {
          Name: "File",
          FileValue: {
            Name: req.file.originalname,
            Data: base64Data
          }
        },
        {
          Name: "StoreFile",
          Value: true
        },
        {
          Name: "FileName",
          Value: "converted"
        },
        {
          Name: "Wysiwyg",
          Value: true
        },
        {
          Name: "EmailCompatible",
          Value: true
        }
      ]
    };

    // Call ConvertAPI
    const response = await axios.post(CONVERT_API_URL, payload, {
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${CONVERT_API_TOKEN}`
      },
      timeout: 120000
    });

    if (response.data?.Files?.[0]?.Url) {
      const htmlUrl = response.data.Files[0].Url;
      const htmlResponse = await axios.get(htmlUrl);
      let htmlContent = htmlResponse.data;

      // Process HTML to make it email client compatible
      htmlContent = createEmailTemplate(htmlContent);

      // Get contacts and send emails
      const contacts = await contactmodel.find({});
      const transporter = createEmailTransporter();
      
      // Send emails sequentially with delay
      for (const contact of contacts) {
        try {
          await sendEmail(transporter, contact.email, htmlContent, emailSubject);
          await new Promise(resolve => setTimeout(resolve, 200)); // 200ms delay
        } catch (emailError) {
          console.error(`Failed to send to ${contact.email}:`, emailError.message);
        }
      }

      // Clean up uploaded file
      fs.unlinkSync(filePath);

      return res.json({
        success: true,
        message: `Emails sent successfully to ${contacts.length} contacts`,
        sampleHtml: htmlContent.substring(0, 500) + '...' // Return sample for preview
      });
    } else {
      throw new Error('No output file received from ConvertAPI');
    }
  } catch (error) {
    console.error('Conversion error:', error);
    if (req.file && fs.existsSync(req.file.path)) {
      fs.unlinkSync(req.file.path);
    }
    res.status(500).json({ 
      error: 'Failed to process document: ' + error.message 
    });
  }
});
function createEmailTemplate(content) {
  let html = content;

  // 1. First, let's preserve the existing structure and only make minimal changes
  // Don't remove existing styles - instead, enhance them
  
  // 2. Add email-compatible DOCTYPE if not present
  if (!html.includes('DOCTYPE')) {
    html = `<!DOCTYPE html PUBLIC "-//W3C//DTD XHTML 1.0 Strict//EN" "http://www.w3.org/TR/xhtml1/DTD/xhtml1-strict.dtd">\n${html}`;
  }

  // 3. Enhance existing CSS with email-specific rules instead of replacing
  const emailEnhancements = `
    <style type="text/css">
      /* Email client compatibility fixes */
      .ReadMsgBody { width: 100%; }
      .ExternalClass { width: 100%; }
      .ExternalClass, .ExternalClass p, .ExternalClass span, 
      .ExternalClass font, .ExternalClass td, .ExternalClass div { 
        line-height: 100%; 
      }
      
      /* Outlook fixes */
      table, td { 
        mso-table-lspace: 0pt; 
        mso-table-rspace: 0pt; 
      }
      #outlook a { padding: 0; }
      
      /* Image fixes */
      img { 
        -ms-interpolation-mode: bicubic;
        border: 0;
        outline: none;
        text-decoration: none;
        max-width: 100%;
        height: auto;
      }
      
      /* Text size adjustment */
      body, table, td, p, a, li, blockquote {
        -ms-text-size-adjust: 100%;
        -webkit-text-size-adjust: 100%;
      }

      /* Ensure tables render properly */
      table {
        border-collapse: collapse;
      }

      /* Gmail/Yahoo fixes */
      u + .body .gmail-fix { display: none; }
      
      /* Dark mode support */
      [data-ogsc] .dark-mode-bg { background-color: #1a1a1a !important; }
      [data-ogsc] .dark-mode-text { color: #ffffff !important; }
    </style>
  `;

  // 4. Insert enhancements into existing head section (don't replace)
  if (html.includes('</head>')) {
    html = html.replace('</head>', `${emailEnhancements}</head>`);
  } else if (html.includes('<head>')) {
    html = html.replace('<head>', `<head>${emailEnhancements}`);
  } else {
    // If no head tag exists, add one
    html = html.replace('<html', `<html><head>${emailEnhancements}</head><html`);
  }

  // 5. Fix any problematic CSS properties in inline styles only
  html = html.replace(/style="([^"]*?)"/g, (match, styleContent) => {
    let fixedStyle = styleContent
      // Remove unsupported properties
      .replace(/\s*(position|z-index|transform|transition|animation|filter|backdrop-filter|box-shadow):[^;]*;?/gi, '')
      // Convert modern units to pixels where needed
      .replace(/(font-size|width|height|padding|margin|line-height):\s*(\d*\.?\d+)(rem|em)/gi, 
        (match, prop, value, unit) => {
          const multiplier = unit === 'rem' ? 16 : 16; // Treat both as 16px base
          return `${prop}:${Math.round(parseFloat(value) * multiplier)}px`;
        })
      // Ensure background colors are properly formatted
      .replace(/background:\s*([^;]+);?/gi, (match, bgValue) => {
        if (bgValue.includes('linear-gradient') || bgValue.includes('radial-gradient')) {
          // Extract just the color if it's a gradient
          const colorMatch = bgValue.match(/#[0-9a-f]{6}|#[0-9a-f]{3}|rgb\([^)]+\)|rgba\([^)]+\)/i);
          return colorMatch ? `background-color:${colorMatch[0]};` : '';
        }
        return match;
      });
    
    return `style="${fixedStyle}"`;
  });

  // 6. Ensure all images have proper attributes
  html = html.replace(/<img([^>]*?)>/gi, (match, attrs) => {
    let newAttrs = attrs;
    if (!newAttrs.includes('border=')) {
      newAttrs += ' border="0"';
    }
    if (!newAttrs.includes('style=') && !newAttrs.includes('display:')) {
      newAttrs += ' style="display:block; line-height:0; font-size:0;"';
    }
    return `<img${newAttrs}>`;
  });

  // 7. Ensure all tables have proper email attributes
  html = html.replace(/<table([^>]*?)>/gi, (match, attrs) => {
    let newAttrs = attrs;
    if (!newAttrs.includes('cellpadding=')) {
      newAttrs += ' cellpadding="0"';
    }
    if (!newAttrs.includes('cellspacing=')) {
      newAttrs += ' cellspacing="0"';
    }
    if (!newAttrs.includes('border=')) {
      newAttrs += ' border="0"';
    }
    if (!newAttrs.includes('role=')) {
      newAttrs += ' role="presentation"';
    }
    return `<table${newAttrs}>`;
  });

  // 8. Fix any remaining issues with specific elements
  html = html
    // Fix meta viewport for mobile
    .replace(/<meta name="viewport"[^>]*>/gi, '<meta name="viewport" content="width=device-width, initial-scale=1.0">')
    // Remove any script tags (they won't work in email anyway)
    .replace(/<script[^>]*>.*?<\/script>/gis, '')
    // Fix link tags that might cause issues
    .replace(/<link(?![^>]*href=["']https:\/\/fonts\.googleapis\.com)[^>]*>/gi, '');

  // 9. Use juice for final CSS inlining, but preserve media queries and existing structure
  try {
    html = juice(html, {
      applyStyleTags: true,
      removeStyleTags: false, // Keep style tags for email client compatibility
      preserveMediaQueries: true,
      preserveFontFaces: true,
      webResources: {
        relativeTo: 'inline',
        images: false
      }
    });
  } catch (juiceError) {
    console.warn('Juice processing failed, continuing without it:', juiceError.message);
  }

  // 10. Don't wrap in additional containers if the email already has proper structure
  // Your existing HTML template already has the proper email structure

  return html;
}

// Alternative simpler approach - just enhance existing styles without major changes
function createEmailTemplateSimple(content) {
  let html = content;

  // Only make essential fixes for email compatibility
  const essentialFixes = `
    <style type="text/css">
      /* Critical email client fixes */
      #outlook a { padding: 0; }
      .ReadMsgBody { width: 100%; }
      .ExternalClass { width: 100%; }
      img { -ms-interpolation-mode: bicubic; }
      table { border-collapse: collapse; mso-table-lspace: 0pt; mso-table-rspace: 0pt; }
    </style>
  `;

  // Insert before closing head tag
  if (html.includes('</head>')) {
    html = html.replace('</head>', `${essentialFixes}</head>`);
  }

  // Only remove scripts (they don't work in email)
  html = html.replace(/<script[^>]*>.*?<\/script>/gis, '');

  // Ensure proper email DOCTYPE
  if (!html.includes('DOCTYPE')) {
    html = `<!DOCTYPE html PUBLIC "-//W3C//DTD XHTML 1.0 Strict//EN" "http://www.w3.org/TR/xhtml1/DTD/xhtml1-strict.dtd">\n${html}`;
  }

  return html;
}
// Create email transporter
function createEmailTransporter() {
  return nodemailer.createTransport({
    service: 'gmail',
    auth: {
      user: 'leads@enrichifydata.com',
      pass: 'cazhzgbslrzvyjfc'
    },
    pool: true, // Use connection pooling
    rateLimit: 5, // Max 5 messages per second
    maxConnections: 5 // Max 5 connections
  });
}

// Send individual email
async function sendEmail(transporter, toEmail, htmlContent, subject = 'Your Document') {
  const mailOptions = {
    from: '"Lead Enrichment System" <leads@enrichifydata.com>',
    subject: subject,
    to: toEmail,
    html: htmlContent,
    text: 'Please view this email in an HTML-compatible client to see the document content.',
    headers: {
      'X-Mailer': 'Node.js',
      'Precedence': 'bulk' // Mark as bulk email
    }
  };

  await transporter.sendMail(mailOptions);
}

// Email extraction endpoint


app.post('/api/extract-emails', csvUploadDisk.single('contacts'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: 'No CSV file uploaded' });
    }

    const filePath = req.file.path;
    const emails = [];
    const emailSet = new Set(); // To avoid duplicates

    // Parse CSV and extract emails
    await new Promise((resolve, reject) => {
      fs.createReadStream(filePath)
        .pipe(csv())
        .on('data', (row) => {
          // Look for email column (case insensitive)
          const emailValue = Object.keys(row).find(key => 
            key.toLowerCase().includes('email')
          );
          
          if (emailValue && row[emailValue]) {
            const email = row[emailValue].trim();
            
            // Basic email validation
            const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
            if (emailRegex.test(email) && !emailSet.has(email.toLowerCase())) {
              emailSet.add(email.toLowerCase());
              emails.push({
                email
              });
            }
          }
        })
        .on('end', () => {
          resolve();
        })
        .on('error', (error) => {
          reject(error);
        });
    });

    // Clean up uploaded file
    fs.unlinkSync(filePath);

    if (emails.length === 0) {
      return res.status(400).json({ 
        error: 'No valid emails found in the CSV file. Make sure the CSV has an "email" column.' 
      });
    }

    let contacts = await contactmodel.find({});
    const filteredContacts = emails.filter(emailObj => {
      return !contacts.some(contact => contact.email === emailObj.email);
    });
    
    console.log("filteredContacts");
    console.log(filteredContacts);
    
    if (filteredContacts.length > 0) {
      await contactmodel.insertMany(filteredContacts);
    }
    
    return res.json({
      success: true,
      emails: filteredContacts,
      count: filteredContacts.length,
      totalProcessed: emails.length,
      duplicatesSkipped: emails.length - filteredContacts.length,
      originalFilename: req.file.originalname
    });

  } catch (error) {
    console.error('Email extraction error:', error);
    
    // Clean up file if it exists
    if (req.file && fs.existsSync(req.file.path)) {
      fs.unlinkSync(req.file.path);
    }
    
    res.status(500).json({ 
      error: 'Failed to extract emails: ' + error.message 
    });
  }
});

// Get contacts count endpoint
app.get('/api/contacts/count', async (req, res) => {
  try {
    const count = await contactmodel.countDocuments({});
    res.json({ count });
  } catch (error) {
    res.status(500).json({ error: 'Failed to get contacts count' });
  }
});

// Helper function to convert HTML to React
function convertHtmlToReact(html) {
  return `import React from 'react';

const ConvertedTemplate = () => {
  return (
    <div>
      ${html
        .replace(/class=/g, 'className=')
        .replace(/style="([^"]*)"/g, (match, style) => {
          const styleObj = {};
          style.split(';').forEach(rule => {
            const [prop, val] = rule.split(':').map(s => s.trim());
            if (prop && val) {
              const camelProp = prop.replace(/-([a-z])/g, (g) => g[1].toUpperCase());
              styleObj[camelProp] = val;
            }
          });
          return `style={${JSON.stringify(styleObj)}}`;
        })
        .replace(/<(area|base|br|col|embed|hr|img|input|link|meta|param|source|track|wbr)([^>]*?)>/g, '<$1$2 />')
        .replace(/for=/g, 'htmlFor=')
        .replace(/&nbsp;/g, '{\' \'}')
        .replace(/<!--(.*?)-->/g, '{/* $1 */}')
        .split('\n')
        .map(line => line.trim())
        .join('\n      ')}
    </div>
  );
};

export default ConvertedTemplate;`;
}

// Health check endpoint
app.get('/api/health', (req, res) => {
  res.json({ 
    status: 'OK',
    message: 'PDF to HTML converter, HTML email sender, and email extractor service is running'
  });
});

// Start server
const PORT = process.env.PORT || 3001;
app.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
});