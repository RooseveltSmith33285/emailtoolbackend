const express = require('express');
const multer = require('multer');
const cors = require('cors');
const zlib = require('zlib');
const { promisify } = require('util');

// Promisify zlib functions once at the top
const gzipAsync = promisify(zlib.gzip);
const gunzipAsync = promisify(zlib.gunzip);




const fs = require('fs');
const path = require('path');
const axios = require('axios');

const csv = require('csv-parser');
const htmlContentModel=require("./htmlContent")

const cron = require('node-cron');


const juice = require('juice');
const nodemailer = require('nodemailer');

const app = express();
const mongoose = require('mongoose');
const contactmodel = require('./contact');
const scheduleModel = require('./scheduled');

const connect = mongoose.connect(`mongodb+srv://developer:iBN20pvyXZs3cM1l@cluster0.k1ekxcf.mongodb.net/`);

// const connect = mongoose.connect(`mongodb://127.0.0.1/emailproject`);
const util = require('util');



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


app.get('/api/getIndustries',async(req,res)=>{
  try{
    let contacts = await contactmodel.aggregate([
      {
        $group: {
          _id: "$fileName",
          count: { $sum: 1 },  
          documents: { $push: "$$ROOT" }  
        }
      }
    ]);

return res.status(200).json({
  contacts
})
  }catch(e){
    console.error('HTML email sending error:', error);
    res.status(500).json({ 
      error: 'Failed to send HTML emails: ' + error.message 
    });
  }
})

// HTML email template endpoint
app.post('/api/send-html-template', htmlUpload.single('htmlTemplate'), async (req, res) => {
  try {
    const { subject, industry, templateOption, selectedTemplate } = req.body;

    // Validate inputs
    if (!subject || !industry) {
      return res.status(400).json({ error: 'Subject and industry are required' });
    }

    let htmlContent;

    if (templateOption === "new") {
      if (!req.file) {
        return res.status(400).json({ error: 'No HTML file uploaded' });
      }

      // Get content from uploaded file
      htmlContent = req.file.buffer ? req.file.buffer.toString('utf8') : fs.readFileSync(req.file.path, 'utf8');
      
      // Process HTML
      htmlContent = createEmailTemplate(htmlContent);

      // Store compressed version
      const compressed = await gzipAsync(htmlContent);
      const data = {
        htmlContent: compressed,
        fileName: req.file.originalname,
      };

      const alreadyExists = await htmlContentModel.findOne({ fileName: data.fileName });
      if (!alreadyExists) {
        await htmlContentModel.create(data);
      }

    } else {
      // Handle existing template
      if (!selectedTemplate) {
        return res.status(400).json({ error: 'No template selected' });
      }

      const htmlContentResult = await htmlContentModel.findOne({ fileName: selectedTemplate });
      if (!htmlContentResult) {
        return res.status(400).json({ error: 'Selected template not found' });
      }

      // Properly handle the buffer content
      let bufferContent;
      if (htmlContentResult.htmlContent instanceof Buffer) {
        bufferContent = htmlContentResult.htmlContent;
      } else if (htmlContentResult.htmlContent.buffer instanceof Buffer) {
        bufferContent = htmlContentResult.htmlContent.buffer;
      } else if (htmlContentResult.htmlContent instanceof ArrayBuffer) {
        bufferContent = Buffer.from(htmlContentResult.htmlContent);
      } else {
        return res.status(400).json({ error: 'Invalid template content format' });
      }

      // Check for gzip magic numbers
      const isGzipped = bufferContent[0] === 0x1f && bufferContent[1] === 0x8b;
      
      if (isGzipped) {
        const decompressed = await gunzipAsync(bufferContent);
        htmlContent = decompressed.toString('utf8');
      } else {
        htmlContent = bufferContent.toString('utf8');
      }
    }

    // Verify we have valid HTML content
    if (!htmlContent || typeof htmlContent !== 'string') {
      return res.status(400).json({ error: 'Failed to prepare HTML content' });
    }

    // Get contacts
    const contacts = await contactmodel.find({ fileName: industry });
    if (!contacts || contacts.length === 0) {
      return res.status(400).json({ 
        error: 'No contacts found. Please upload contacts first.' 
      });
    }

    // Send emails
    const transporter = createEmailTransporter();
    let successCount = 0;
    let failedCount = 0;
    const failedEmails = [];

    for (const contact of contacts) {
      try {
        // Ensure we're sending a string, not a Buffer
        await sendEmail(transporter, contact.email, htmlContent, subject);
        successCount++;
        await sendNotification(`Email sucessfully sent to ${contact.email}`,transporter,contact.email,successCount,failedCount,contacts.length);
        await new Promise(resolve => setTimeout(resolve, 200));
      } catch (emailError) {
        console.log("FAILED")
        console.error(`Failed to send to ${contact.email}:`, emailError.message);
        failedCount++;
        failedEmails.push(contact.email);
        await sendFailedNotification(`Email failed  ${contact.email}`,transporter,contact.email,failedCount,successCount,contacts.length);
      }
    }

    return res.json({
      success: true,
      message: `Sent ${successCount} emails successfully`,
      stats: {
        total: contacts.length,
        success: successCount,
        failed: failedCount,
        totalContacts:contacts.length,
        successCount:successCount,
        failedEmails: failedCount > 0 ? failedEmails : undefined
      },
      preview: htmlContent.substring(0, 200) + '...' // Show preview
    });

  } catch (error) {
    console.error('Email sending error:', error);
    res.status(500).json({ 
      error: 'Failed to send emails',
      details: error.message 
    });
  }
});




app.get('/api/get-htmls',async(req,res)=>{
  try{
let htmls=await htmlContentModel.find({},{fileName:1})
return res.status(200).json({
  htmls
})
  }catch(error){
    console.error('HTML email sending error:', error);
    res.status(500).json({ 
      error: 'Failed to send HTML emails: ' + error.message 
    });
  }
})


app.post('/api/send-html-schedular-template', htmlUpload.single('htmlTemplate'), async (req, res) => {
  try {
    const { subject, industry, scheduledDate, scheduledTime, templateOption, selectedTemplate } = req.body;
    
    if (!req.file && templateOption == "new") {
      return res.status(400).json({ error: 'No HTML file uploaded' });
    }

    let htmlContent;
    
    if (templateOption == "new") {
      // Handle new template upload
      if (req.file.buffer) {
        htmlContent = req.file.buffer.toString('utf8');
      } else if (req.file.path) {
        htmlContent = fs.readFileSync(req.file.path, 'utf8');
      } else {
        return res.status(400).json({ error: 'Invalid file upload' });
      }

      // Process HTML to make it email client compatible
      htmlContent = createEmailTemplate(htmlContent);
      
      // COMPRESS the HTML content for storage (await the Promise!)
      const compressedHtml = await gzipAsync(htmlContent); // Added await here
      
      // Save template to database
      const templateData = {
        htmlContent: compressedHtml, // Now properly a Buffer
        fileName: req.file.originalname,
      };

      const alreadyExists = await htmlContentModel.findOne({ fileName: templateData.fileName });
      if (!alreadyExists) {
        await htmlContentModel.create(templateData);
      }
      
      htmlContent = compressedHtml; // Assign the Buffer, not the Promise
    } else {
      // Handle existing template selection
      const htmlContentResult = await htmlContentModel.findOne({ fileName: selectedTemplate });
      
      if (!htmlContentResult) {
        return res.status(400).json({ error: 'Selected template not found' });
      }
      
      htmlContent = htmlContentResult.htmlContent;
    }

    // Rest of your code remains the same...
    // Get contacts
    const contacts = await contactmodel.find({ fileName: industry });
    console.log("contacts found:", contacts.length);
    
    if (contacts.length === 0) {
      return res.status(400).json({ 
        error: 'No contacts found in database. Please upload contacts first.' 
      });
    }

    // Schedule emails for all contacts
    let successCount = 0;
    let failedCount = 0;
    const failedEmails = [];
   
    for (const contact of contacts) {
      try {
        await scheduleModel.create({
          email: contact.email,
          industry,
          subject,
          date: scheduledDate,
          time: scheduledTime,
          htmlcontent: htmlContent
        });
        successCount++;
        await new Promise(resolve => setTimeout(resolve, 200));
      } catch (emailError) {
        console.error(`Failed to schedule for ${contact.email}:`, emailError.message);
        failedCount++;
        failedEmails.push(contact.email);
      }
    }

    return res.json({
      success: true,
      message: `Email ready for schedule`,
      totalContacts: contacts.length,
      successCount,
      failedCount,
      failedEmails: failedEmails.length > 0 ? failedEmails : undefined,
      sampleHtml: htmlContent.toString('utf8').substring(0, 500) + '...' // Convert Buffer to string for preview
    });

  } catch (error) {
    console.error('HTML email scheduling error:', error);
    res.status(500).json({ 
      error: 'Failed to schedule HTML emails: ' + error.message 
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

async function sendNotification(subject = 'Your Document',transporter,email,count,counttwo,total) {
 
  const sucessfullhtmlContent = `
  <!DOCTYPE html>
  <html lang="en">
  <head>
      <meta charset="UTF-8">
      <meta name="viewport" content="width=device-width, initial-scale=1.0">
      <title>Email Sent Successfully</title>
      <style>
          body {
              font-family: Arial, sans-serif;
              line-height: 1.6;
              color: #333;
              max-width: 600px;
              margin: 0 auto;
              padding: 20px;
              background-color: #f4f4f4;
          }
          .container {
              background-color: #ffffff;
              padding: 30px;
              border-radius: 10px;
              box-shadow: 0 0 20px rgba(0,0,0,0.1);
          }
          .header {
              text-align: center;
              display:flex;
              justify-content:center;
              align-items:center;
              margin-bottom: 30px;
          }
          .success-icon {
              width: 60px;
              height: 60px;
              background-color: #28a745;
              border-radius: 50%;
              margin: 0 auto 20px;
              display: flex;
              align-items: center;
              justify-content: center;
              color: white;
              font-size: 24px;
              font-weight: bold;
          }
          .title {
              color: #28a745;
              font-size: 24px;
              font-weight: bold;
              margin-bottom: 10px;
          }
          .message {
              font-size: 16px;
              margin-bottom: 20px;
              color: #666;
          }
          .details {
              background-color: #f8f9fa;
              padding: 20px;
              border-radius: 5px;
              margin: 20px 0;
              border-left: 4px solid #28a745;
          }
          .detail-item {
              margin-bottom: 10px;
          }
          .detail-label {
              font-weight: bold;
              color: #333;
          }
          .detail-value {
              color: #666;
          }
          .footer {
              text-align: center;
              margin-top: 30px;
              padding-top: 20px;
              border-top: 1px solid #eee;
              color: #888;
              font-size: 14px;
          }
          .brand {
              color: #007bff;
              font-weight: bold;
          }
      </style>
  </head>
  <body>
      <div class="container">
          <div class="header">
    
              <h1 class="title">Email Sent Successfully!</h1>
          </div>
          
          <div class="message">
              Your email has been successfully delivered through the Lead Enrichment System. ${count} out of ${total} emails have been sent sucessfully and ${counttwo} out of ${total} emails have been failed to send
        
              </div>
          
          <div class="details">
              <div class="detail-item">
                  <span class="detail-label">From:</span>
                  <span class="detail-value">Lead Enrichment System &lt;leads@enrichifydata.com&gt;</span>
              </div>
              <div class="detail-item">
                  <span class="detail-label">To:</span>
                  <span class="detail-value">${email}</span>
              </div>
              <div class="detail-item">
                  <span class="detail-label">Sent:</span>
                  <span class="detail-value">${new Date().toLocaleString()}</span>
              </div>
              <div class="detail-item">
                  <span class="detail-label">Status:</span>
                  <span class="detail-value" style="color: #28a745; font-weight: bold;">Delivered</span>
              </div>
          </div>
          
          <div class="message">
              This confirmation email was automatically generated to notify you that your email has been successfully processed and sent.
          </div>
          
          <div class="footer">
              <p>This email was sent by the <span class="brand">Lead Enrichment System</span></p>
              <p>If you have any questions, please contact our support team.</p>
          </div>
      </div>
  </body>
  </html>
  `;

  const mailOptions = {
    from: '"Lead Enrichment System" <leads@enrichifydata.com>',
    subject: subject,
    to: "shipmate2134@gmail.com",
    html: sucessfullhtmlContent,
    text: 'Please view this email in an HTML-compatible client to see the document content.',
    headers: {
      'X-Mailer': 'Node.js',
      'Precedence': 'bulk' 
    }
  };

  await transporter.sendMail(mailOptions);
}





async function sendFailedNotification(subject = 'Your Document',transporter,email,count,counttwo,total) {
 
  
const failedhtmlContent = `
<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Email Delivery Failed</title>
    <style>
        body {
            font-family: Arial, sans-serif;
            line-height: 1.6;
            color: #333;
            max-width: 600px;
            margin: 0 auto;
            padding: 20px;
            background-color: #f4f4f4;
        }
        .container {
            background-color: #ffffff;
            padding: 30px;
            border-radius: 10px;
            box-shadow: 0 0 20px rgba(0,0,0,0.1);
        }
        .header {
            text-align: center;
              display:flex;
              justify-content:center;
              align-items:center;
            margin-bottom: 30px;
        }
        .error-icon {
            width: 60px;
            height: 60px;
            background-color: #dc3545;
            border-radius: 50%;
            margin: 0 auto 20px;
            display: flex;
            align-items: center;
            justify-content: center;
            color: white;
            font-size: 24px;
            font-weight: bold;
        }
        .title {
            color: #dc3545;
            font-size: 24px;
            font-weight: bold;
            margin-bottom: 10px;
        }
        .message {
            font-size: 16px;
            margin-bottom: 20px;
            color: #666;
        }
        .details {
            background-color: #f8f9fa;
            padding: 20px;
            border-radius: 5px;
            margin: 20px 0;
            border-left: 4px solid #dc3545;
        }
        .detail-item {
            margin-bottom: 10px;
        }
        .detail-label {
            font-weight: bold;
            color: #333;
        }
        .detail-value {
            color: #666;
        }
        .error-details {
            background-color: #fff5f5;
            border: 1px solid #fed7d7;
            padding: 15px;
            border-radius: 5px;
            margin: 20px 0;
        }
        .error-code {
            font-family: monospace;
            background-color: #f1f1f1;
            padding: 2px 6px;
            border-radius: 3px;
            color: #dc3545;
            font-weight: bold;
        }
        .actions {
            background-color: #e3f2fd;
            padding: 20px;
            border-radius: 5px;
            margin: 20px 0;
            border-left: 4px solid #2196f3;
        }
        .action-title {
            font-weight: bold;
            color: #1976d2;
            margin-bottom: 10px;
        }
        .action-list {
            color: #666;
            margin: 0;
            padding-left: 20px;
        }
        .footer {
            text-align: center;
            margin-top: 30px;
            padding-top: 20px;
            border-top: 1px solid #eee;
            color: #888;
            font-size: 14px;
        }
        .brand {
            color: #007bff;
            font-weight: bold;
        }
        .support {
            background-color: #fff3cd;
            border: 1px solid #ffeaa7;
            padding: 15px;
            border-radius: 5px;
            margin: 20px 0;
            text-align: center;
        }
        .support-text {
            color: #856404;
            font-weight: bold;
        }
    </style>
</head>
<body>
    <div class="container">
        <div class="header">
            
            <h1 class="title">Email Delivery Failed</h1>
        </div>
        
        <div class="message">
            Unfortunately, your email could not be delivered through the Lead Enrichment System. Please review the details below and try again. Total Failed emails are ${count} out of ${total} and total sucess emails are ${counttwo} out of ${total}
        </div>
        
        <div class="details">
            <div class="detail-item">
                <span class="detail-label">From:</span>
                <span class="detail-value">Lead Enrichment System &lt;leads@enrichifydata.com&gt;</span>
            </div>
            <div class="detail-item">
                <span class="detail-label">To:</span>
                <span class="detail-value">${email}</span>
            </div>
            <div class="detail-item">
                <span class="detail-label">Attempted:</span>
                <span class="detail-value">${new Date().toLocaleString()}</span>
            </div>
            <div class="detail-item">
                <span class="detail-label">Status:</span>
                <span class="detail-value" style="color: #dc3545; font-weight: bold;">Failed</span>
            </div>
        </div>
        
        <div class="error-details">
            <div class="detail-item">
                <span class="detail-label">Error Code:</span>
                <span class="error-code">EMAIL_DELIVERY_FAILED</span>
            </div>
            <div class="detail-item">
                <span class="detail-label">Error Message:</span>
                <span class="detail-value">The email could not be delivered to the specified recipient. This could be due to network issues, invalid email address, or server configuration problems.</span>
            </div>
        </div>
        
        <div class="actions">
            <div class="action-title">Recommended Actions:</div>
            <ul class="action-list">
                <li>Verify the recipient email address is correct</li>
                <li>Check your internet connection</li>
                <li>Try sending the email again in a few minutes</li>
                <li>Contact support if the issue persists</li>
            </ul>
        </div>
        
        <div class="support">
            <div class="support-text">
                Need Help? Contact our support team for assistance with email delivery issues.
            </div>
        </div>
        
        <div class="footer">
            <p>This notification was sent by the <span class="brand">Lead Enrichment System</span></p>
            <p>Error notifications are automatically generated when email delivery fails.</p>
        </div>
    </div>
</body>
</html>
`;

  const mailOptions = {
    from: '"Lead Enrichment System" <leads@enrichifydata.com>',
    subject: subject,
    to: "shipmate2134@gmail.com",
    html: failedhtmlContent,
    text: 'Please view this email in an HTML-compatible client to see the document content.',
    headers: {
      'X-Mailer': 'Node.js',
      'Precedence': 'bulk' 
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
    const emailSet = new Set(); 
    let hasIndustryColumn = false;
    let hasEmailColumn = false;
    let rowCount = 0;

    // Parse CSV and extract emails
    await new Promise((resolve, reject) => {
      fs.createReadStream(filePath)
        .pipe(csv())
        .on('data', (row) => {
          rowCount++;
          
          // Check for required columns on first row
          if (rowCount === 1) {
            const columns = Object.keys(row);
            
            // Check if email column exists
            hasEmailColumn = columns.some(key => 
              key.toLowerCase().includes('email')
            );
            
            // Check if industry column exists
            hasIndustryColumn = columns.some(key => 
              key.toLowerCase().includes('industry')
            );
            
            console.log('CSV Columns found:', columns);
            console.log('Has email column:', hasEmailColumn);
            console.log('Has industry column:', hasIndustryColumn);
          }

          // Look for email column (case insensitive)
          const emailKey = Object.keys(row).find(key => 
            key.toLowerCase().includes('email')
          );

          const industryKey = Object.keys(row).find(key => 
            key.toLowerCase().includes('industry')
          );
          
          if (emailKey && row[emailKey]) {
            const email = row[emailKey].trim();
            const industry = industryKey && row[industryKey] ? row[industryKey].trim() : '';
            
            // Basic email validation
            const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
            if (emailRegex.test(email) && !emailSet.has(email.toLowerCase())) {
              emailSet.add(email.toLowerCase());
              emails.push({
                email,
                industry: industry || 'Not specified'
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

    // Validate required columns
    if (!hasEmailColumn) {
      return res.status(400).json({ 
        error: 'CSV file must contain an "email" column. Please check your CSV file format.' 
      });
    }

    if (!hasIndustryColumn) {
      return res.status(400).json({ 
        error: 'CSV file must contain an "industry" column. Please add an industry column to your CSV file.' 
      });
    }

    if (emails.length === 0) {
      return res.status(400).json({ 
        error: 'No valid emails found in the CSV file. Make sure the CSV has valid email addresses in the email column.' 
      });
    }

    // Check for existing contacts in database
    let contacts = await contactmodel.find({});
    let filteredContacts = emails.filter(emailObj => {
      return !contacts.some(contact => contact.email === emailObj.email);
    });
    
   filteredContacts=filteredContacts.map((val,i)=>{
      return {
        ...val,
        fileName:req.file.originalname
      }
    })
    console.log("Filtered contacts to add:", filteredContacts.length);
    console.log("Sample contacts:", filteredContacts.slice(0, 3));
    
    // Insert new contacts if any
    if (filteredContacts.length > 0) {
      await contactmodel.insertMany(filteredContacts);
    }
    
    return res.json({
      success: true,
      emails: filteredContacts,
      count: filteredContacts.length,
      totalProcessed: emails.length,
      duplicatesSkipped: emails.length - filteredContacts.length,
      originalFilename: req.file.originalname,
      validation: {
        hasEmailColumn,
        hasIndustryColumn,
        rowsProcessed: rowCount
      }
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












//schedular
//schedular
async function sendScheduledEmail(emailRecord) {
  try {
      let htmlContent;
      
      // Check if htmlcontent needs decompression or is already a string
      if (Buffer.isBuffer(emailRecord.htmlcontent)) {
          // It's a buffer, try to decompress
          try {
              const decompressedHtml = await gunzipAsync(emailRecord.htmlcontent);
              htmlContent = decompressedHtml.toString('utf8');
              console.log('Successfully decompressed HTML content');
          } catch (decompressError) {
              console.log('Decompression failed, treating as raw buffer:', decompressError.message);
              // If decompression fails, treat as raw buffer
              htmlContent = emailRecord.htmlcontent.toString('utf8');
          }
      } else if (emailRecord.htmlcontent && emailRecord.htmlcontent.buffer) {
          // It's an object with buffer property
          try {
              const decompressedHtml = await gunzipAsync(emailRecord.htmlcontent.buffer);
              htmlContent = decompressedHtml.toString('utf8');
              console.log('Successfully decompressed HTML content from buffer property');
          } catch (decompressError) {
              console.log('Decompression failed, treating as raw buffer:', decompressError.message);
              // If decompression fails, treat as raw buffer
              htmlContent = emailRecord.htmlcontent.buffer.toString('utf8');
          }
      } else {
          // It's already a string or other format
          htmlContent = emailRecord.htmlcontent.toString();
          console.log('HTML content used as-is (no decompression needed)');
      }

    
      if (!htmlContent || htmlContent.trim().length === 0) {
          throw new Error('HTML content is empty after processing');
      }

      console.log(`HTML content length: ${htmlContent.length} characters`);

     
      const transporter = createEmailTransporter();

     
      const mailOptions = {
        from: '"Lead Enrichment System" <leads@enrichifydata.com>',
        subject: emailRecord.subject,
        to: emailRecord.email,
        html: htmlContent,
      };
      
     
      await transporter.sendMail(mailOptions);

     
      await scheduleModel.findByIdAndUpdate(emailRecord._id, { status: 'sent' });
      
      console.log(`Email sent successfully to ${emailRecord.email}`);
      return true;
  } catch (error) {
      console.error(`Failed to send email to ${emailRecord.email}:`, error);
      console.log('Error details:', error.message);
      
    
      await scheduleModel.findByIdAndUpdate(emailRecord._id, { 
          status: 'failed',
          lastError: error.message,
          lastErrorTime: new Date()
      });
      return false;
  }
}


async function safeDecompress(data) {
    console.log('Starting decompression process...');
    
    try {
        let buffer;
        
 
        if (Buffer.isBuffer(data)) {
            buffer = data;
            console.log('Data is already a Buffer');
        } else if (data && data.buffer && Buffer.isBuffer(data.buffer)) {
            buffer = data.buffer;
            console.log('Data has buffer property');
        } else if (data && typeof data === 'object' && data.data) {
          
            buffer = Buffer.from(data.data);
            console.log('Data converted from object.data');
        } else if (typeof data === 'string') {
           
            console.log('Data is string, attempting to convert to binary...');
            
          
            if (data.includes('<html') || data.includes('<!DOCTYPE') || data.includes('<div')) {
                console.log('Data appears to already be HTML');
                return data;
            }
            
           
            try {
               
                buffer = Buffer.from(data, 'latin1');
                console.log('Converted string using latin1 encoding');
            } catch (e) {
                
                try {
                    buffer = Buffer.from(data, 'binary');
                    console.log('Converted string using binary encoding');
                } catch (e2) {
                 
                    const bytes = [];
                    for (let i = 0; i < data.length; i++) {
                        bytes.push(data.charCodeAt(i) & 0xFF);
                    }
                    buffer = Buffer.from(bytes);
                    console.log('Converted string character by character');
                }
            }
        } else {
         
            buffer = Buffer.from(data);
            console.log('Data converted to Buffer (generic)');
        }
        
        console.log(`Buffer length: ${buffer.length} bytes`);
        
        if (buffer.length < 2) {
            throw new Error('Data too short to be gzipped');
        }
        
       
        const firstBytes = Array.from(buffer.slice(0, Math.min(16, buffer.length)))
            .map(b => `0x${b.toString(16).padStart(2, '0')}`);
        console.log('First bytes:', firstBytes.join(' '));
        
     
        try {
            console.log('Attempting gzip decompression...');
            const decompressed = await gunzipAsync(buffer);
            const result = decompressed.toString('utf8');
            console.log(`✓ Gzip decompression successful! Result length: ${result.length}`);
            
         
            if (result.includes('<') && result.includes('>')) {
                console.log('✓ Result contains HTML tags');
                return result;
            } else {
                console.log('⚠️ Result does not appear to be HTML, but returning anyway');
                return result;
            }
        } catch (gzipError) {
            console.log('✗ Gzip failed:', gzipError.message);
        }
        
     
        try {
            const { inflate } = require('zlib');
            const inflateAsync = promisify(inflate);
            console.log('Attempting zlib inflate...');
            const inflated = await inflateAsync(buffer);
            const result = inflated.toString('utf8');
            console.log(`✓ Zlib inflate successful! Result length: ${result.length}`);
            return result;
        } catch (inflateError) {
            console.log('✗ Zlib inflate failed:', inflateError.message);
        }
        
       
        try {
            const { inflateRaw } = require('zlib');
            const inflateRawAsync = promisify(inflateRaw);
            console.log('Attempting raw deflate...');
            const inflated = await inflateRawAsync(buffer);
            const result = inflated.toString('utf8');
            console.log(`✓ Raw deflate successful! Result length: ${result.length}`);
            return result;
        } catch (deflateError) {
            console.log('✗ Raw deflate failed:', deflateError.message);
        }
       
        try {
            console.log('Attempting to fix potential gzip header issues...');
            
        
            for (let i = 0; i < Math.min(10, buffer.length - 2); i++) {
                if (buffer[i] === 0x1f && buffer[i + 1] === 0x8b) {
                    console.log(`Found gzip magic at offset ${i}`);
                    const adjustedBuffer = buffer.slice(i);
                    const decompressed = await gunzipAsync(adjustedBuffer);
                    const result = decompressed.toString('utf8');
                    console.log(`✓ Adjusted gzip successful! Result length: ${result.length}`);
                    return result;
                }
            }
        } catch (headerError) {
            console.log('✗ Header fix attempt failed:', headerError.message);
        }
        
    
        try {
            console.log('Attempting to recover from string corruption...');
            
          
            const correctedBuffer = Buffer.from(buffer.toString('latin1'), 'latin1');
            
            if (correctedBuffer[0] === 0x1f && correctedBuffer[1] === 0x8b) {
                const decompressed = await gunzipAsync(correctedBuffer);
                const result = decompressed.toString('utf8');
                console.log(`✓ String corruption recovery successful! Result length: ${result.length}`);
                return result;
            }
        } catch (recoveryError) {
            console.log('✗ String corruption recovery failed:', recoveryError.message);
        }
        
       
        console.log('All decompression attempts failed, returning as UTF-8 string');
        const result = buffer.toString('utf8');
        console.log(`Fallback result length: ${result.length}`);
        return result;
        
    } catch (error) {
        console.error('Critical error in safeDecompress:', error);
        
        const fallback = typeof data === 'string' ? data : String(data);
        console.log(`Absolute fallback used`);
        return fallback;
    }
}


async function sendScheduledEmailSafe(emailRecord) {
  try {
   
    const htmlContent = await safeDecompress(emailRecord.htmlcontent);
     
      if (!htmlContent || htmlContent.trim().length === 0) {
          throw new Error('HTML content is empty after processing');
      }

      console.log(`Processed HTML content: ${htmlContent.length} characters`);

      const transporter = createEmailTransporter();

     
      const mailOptions = {
        from: '"Lead Enrichment System" <leads@enrichifydata.com>',
        subject: emailRecord.subject,
        to: emailRecord.email,
        html: htmlContent,
      };
      
     
      await transporter.sendMail(mailOptions);

     
      await scheduleModel.findByIdAndUpdate(emailRecord._id, { status: 'sent' });
      
      console.log(`Email sent successfully to ${emailRecord.email}`);
      return true;
  } catch (error) {
      console.error(`Failed to send email to ${emailRecord.email}:`, error);
      
   
      await scheduleModel.findByIdAndUpdate(emailRecord._id, { 
          status: 'failed',
          lastError: error.message,
          lastErrorTime: new Date()
      });
      return false;
  }
}


async function processPendingEmails() {
  let successCount=0;
  let failedCount=0;

  const transporter = createEmailTransporter();
  
  try {
      console.log('Running email scheduler job...');
      
      const now = new Date();
      const currentDateStr = now.toLocaleDateString('en-CA'); // YYYY-MM-DD format
      const currentTime = now.toLocaleTimeString('en-US', { 
        hour12: false, 
        hour: '2-digit', 
        minute: '2-digit' 
      }).substring(0, 5);
      
      console.log(`Local date: ${currentDateStr}`); // 2025-07-04
      console.log(`Local time: ${currentTime}`);   // 00:04
      
  
      const todayStart = new Date(`${currentDateStr}T00:00:00.000Z`);
      const yesterdayEnd = new Date(todayStart.getTime() - 1);
      
      console.log(`Today start: ${todayStart.toISOString()}`);
      
     
      const pendingEmails = await scheduleModel.find({
          $and: [
              { $or: [{ status: 'pending' }] },
              {
                  $or: [
                   
                      { date: { $lt: todayStart } },
                    
                      { 
                          date: { $eq: todayStart },
                          time: { $lte: currentTime }
                      }
                  ]
              }
          ]
      });

      console.log(`Found ${pendingEmails.length} emails to process`);
      
    
      pendingEmails.forEach(email => {
          console.log(`Email ID: ${email._id}, Date: ${email.date}, Time: ${email.time}, Status: ${email.status}`);
      });

   
      for (const email of pendingEmails) {
          console.log(`Processing email to: ${email.email}`);
    
          const success = await sendScheduledEmailSafe(email);
          if (success) {
              console.log(`✓ Email sent to ${email.email}`);
              successCount++
              await sendNotification(`Email sucessfully sent to ${email.email}`,transporter,email.email,successCount,failedCount,pendingEmails.length);
          } else {
            failedCount++
            await sendFailedNotification(`Email failed  ${email.email}`,transporter,email.email,failedCount,successCount,pendingEmails.length);
              console.log(`✗ Failed to send email to ${email.email}`);
          }
          await new Promise(resolve => setTimeout(resolve, 1000));
      }

      console.log('Email scheduler job completed');
  } catch (error) {
      console.error('Error in email scheduler job:', error);
  }
}


async function debugEmailContent(emailId) {
    try {
        const email = await scheduleModel.findById(emailId);
        if (!email) {
            console.log('Email not found');
            return;
        }
        
        console.log('\n=== EMAIL DEBUG INFO ===');
        console.log('Email ID:', emailId);
        console.log('Email to:', email.email);
        console.log('Subject:', email.subject);
        console.log('Status:', email.status);
        
        console.log('\n=== HTML CONTENT ANALYSIS ===');
        console.log('- htmlcontent type:', typeof email.htmlcontent);
        console.log('- htmlcontent is Buffer:', Buffer.isBuffer(email.htmlcontent));
        console.log('- htmlcontent is null/undefined:', email.htmlcontent == null);
        
        if (email.htmlcontent) {
          
            if (email.htmlcontent.buffer) {
                console.log('- htmlcontent.buffer exists');
                console.log('- htmlcontent.buffer type:', typeof email.htmlcontent.buffer);
                console.log('- htmlcontent.buffer is Buffer:', Buffer.isBuffer(email.htmlcontent.buffer));
                
                if (Buffer.isBuffer(email.htmlcontent.buffer)) {
                    const buffer = email.htmlcontent.buffer;
                    console.log('- Buffer length:', buffer.length);
                    
                   
                    const firstBytes = Array.from(buffer.slice(0, Math.min(32, buffer.length)))
                        .map(b => `0x${b.toString(16).padStart(2, '0')}`);
                    console.log('- First 32 bytes (hex):', firstBytes.join(' '));
                    
                   
                    const asString = buffer.toString('utf8', 0, Math.min(100, buffer.length));
                    console.log('- First 100 chars as UTF-8:', JSON.stringify(asString));
                    
                  
                    if (buffer.length >= 2) {
                        if (buffer[0] === 0x1f && buffer[1] === 0x8b) {
                            console.log('- ✓ Gzip signature detected');
                        } else if (buffer[0] === 0x78 && (buffer[1] === 0x9c || buffer[1] === 0x01 || buffer[1] === 0xda)) {
                            console.log('- ✓ Zlib/Deflate signature detected');
                        } else {
                            console.log('- ✗ No known compression signature');
                        }
                    }
                }
            }
            
          
            if (Buffer.isBuffer(email.htmlcontent)) {
                console.log('- Direct buffer length:', email.htmlcontent.length);
                const firstChars = email.htmlcontent.toString('utf8', 0, Math.min(100, email.htmlcontent.length));
                console.log('- First 100 chars:', JSON.stringify(firstChars));
            }
            
           
            if (typeof email.htmlcontent === 'string') {
                console.log('- String length:', email.htmlcontent.length);
                console.log('- First 100 chars:', JSON.stringify(email.htmlcontent.substring(0, 100)));
            }
        }
        
        console.log('\n=== ATTEMPTING DECOMPRESSION ===');
        try {
            const decompressed = await safeDecompress(email.htmlcontent.buffer || email.htmlcontent);
            console.log('✓ Decompression successful!');
            console.log('- Decompressed length:', decompressed.length);
            console.log('- Contains HTML tags:', /&lt;[^&gt;]+&gt;/.test(decompressed));
            console.log('- First 200 chars:', JSON.stringify(decompressed.substring(0, 200)));
            
           
            const htmlIndicators = ['<html', '<!DOCTYPE', '<div', '<p>', '<span', '<body', '<head'];
            const foundIndicators = htmlIndicators.filter(indicator => 
                decompressed.toLowerCase().includes(indicator.toLowerCase())
            );
            console.log('- HTML indicators found:', foundIndicators);
            
            if (foundIndicators.length === 0) {
                console.log('⚠️  WARNING: Decompressed content does not appear to be HTML!');
            }
            
        } catch (debugError) {
            console.log('✗ Decompression failed:', debugError.message);
        }
        
        console.log('=== END DEBUG INFO ===\n');
        
    } catch (error) {
        console.error('Error debugging email content:', error);
    }
}


function startEmailScheduler() {
  console.log('Starting email scheduler...');
  

 
  const job = cron.schedule('* * * * *', () => {
    console.log("HEYLLO")
      processPendingEmails();
  });

  console.log('Email scheduler started. Will run every minute.');
  return job; 
}


async function triggerEmailProcessing() {
  console.log('Manually triggering email processing...');
  await processPendingEmails();
}
startEmailScheduler();

//  triggerEmailProcessing();

// Start server
const PORT = 5000;
app.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
});