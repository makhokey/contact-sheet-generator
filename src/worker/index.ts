import { Hono } from "hono";
import { cors } from "hono/cors";
import { generateContactSheet } from './contactSheetGenerator';

const app = new Hono<{ Bindings: Env }>();

app.use('*', cors({
  origin: ['http://localhost:5173', 'https://contact-sheet-generator.pages.dev'],
  allowMethods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS', 'HEAD'],
  allowHeaders: ['Content-Type', 'Authorization', '*'],
  exposeHeaders: ['ETag', 'Location', 'Content-Length', 'Content-Type'],
}));

// Direct upload endpoint for images
app.post("/api/upload", async (c) => {
  try {
    const formData = await c.req.formData();
    const file = formData.get('file') as File;
    
    if (!file) {
      return c.json({ error: "No file provided" }, 400);
    }

    // Generate a unique key for the file
    const key = `uploads/${Date.now()}-${file.name}`;
    
    // Upload to R2
    await c.env.CONTACT_SHEET_BUCKET.put(key, file.stream(), {
      httpMetadata: {
        contentType: file.type,
      },
    });

    // Return the file URL (you may need to adjust this based on your R2 setup)
    const fileUrl = `https://pub-${c.env.R2_ACCOUNT_ID}.r2.dev/${key}`;

    return c.json({
      success: true,
      key: key,
      url: fileUrl,
      filename: file.name,
    });

  } catch (error) {
    console.error('Error uploading file:', error);
    return c.json({ 
      error: `Failed to upload file: ${error instanceof Error ? error.message : 'Unknown error'}` 
    }, 500);
  }
});

// Custom R2 presigned URL generator using native Workers APIs
app.post("/api/upload-presigned", async (c) => {
  try {
    const { filename, contentType } = await c.req.json();
    
    if (!filename || !contentType) {
      return c.json({ error: "Missing filename or contentType" }, 400);
    }

    console.log(`Generating custom presigned URL for: ${filename} (${contentType})`);

    // Generate a unique key for the file
    const key = `uploads/${Date.now()}-${filename}`;
    
    // Create presigned URL manually using AWS Signature Version 4
    const signedUrl = await generateR2PresignedUrl(
      c.env.R2_ACCOUNT_ID,
      'contact-sheet-images',
      key,
      c.env.R2_ACCESS_KEY_ID,
      c.env.R2_SECRET_ACCESS_KEY,
      contentType,
      14400 // 4 hour expiry for batch uploads
    );

    console.log(`Generated custom presigned URL for key: ${key}`);
    console.log(`Presigned URL: ${signedUrl}`);

    return c.json({
      method: 'PUT',
      url: signedUrl,
      fields: {},
      headers: {
        'Content-Type': contentType,
      },
      key: key,
    });

  } catch (error) {
    console.error('Error generating custom R2 presigned URL:', error);
    return c.json({ 
      error: `Failed to generate presigned URL: ${error instanceof Error ? error.message : 'Unknown error'}` 
    }, 500);
  }
});

// Custom presigned URL generator for R2 using AWS Signature Version 4
async function generateR2PresignedUrl(
  accountId: string,
  bucketName: string,
  objectKey: string,
  accessKeyId: string,
  secretAccessKey: string,
  contentType: string,
  expiresIn: number
): Promise<string> {
  const region = 'auto';
  const service = 's3';
  const endpoint = `https://${accountId}.r2.cloudflarestorage.com`;
  
  // Create timestamp and date
  const now = new Date();
  const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, '');
  const dateStamp = amzDate.substring(0, 8);
  
  // Create credential scope
  const credentialScope = `${dateStamp}/${region}/${service}/aws4_request`;
  
  // Create query parameters
  const queryParams = new URLSearchParams({
    'X-Amz-Algorithm': 'AWS4-HMAC-SHA256',
    'X-Amz-Credential': `${accessKeyId}/${credentialScope}`,
    'X-Amz-Date': amzDate,
    'X-Amz-Expires': expiresIn.toString(),
    'X-Amz-SignedHeaders': 'content-type;host',
  });
  
  // Create canonical request
  const canonicalUri = `/${bucketName}/${objectKey}`;
  const canonicalQueryString = queryParams.toString();
  const canonicalHeaders = [
    `content-type:${contentType}`,
    `host:${accountId}.r2.cloudflarestorage.com`,
  ].join('\n') + '\n';
  const signedHeaders = 'content-type;host';
  const payloadHash = 'UNSIGNED-PAYLOAD';
  
  const canonicalRequest = [
    'PUT',
    canonicalUri,
    canonicalQueryString,
    canonicalHeaders,
    signedHeaders,
    payloadHash
  ].join('\n');
  
  // Create string to sign
  const algorithm = 'AWS4-HMAC-SHA256';
  const hashedCanonicalRequest = await sha256(canonicalRequest);
  const stringToSign = [
    algorithm,
    amzDate,
    credentialScope,
    hashedCanonicalRequest
  ].join('\n');
  
  // Calculate signature
  const signingKey = await getSignatureKey(secretAccessKey, dateStamp, region, service);
  const signature = await hmacSha256Hex(signingKey, stringToSign);
  
  // Add signature to query parameters
  queryParams.set('X-Amz-Signature', signature);
  
  return `${endpoint}${canonicalUri}?${queryParams.toString()}`;
}

// Helper functions for AWS Signature Version 4
async function sha256(message: string): Promise<string> {
  const encoder = new TextEncoder();
  const data = encoder.encode(message);
  const hashBuffer = await crypto.subtle.digest('SHA-256', data);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  return hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
}

async function hmacSha256(key: ArrayBuffer, message: string): Promise<ArrayBuffer> {
  const encoder = new TextEncoder();
  const cryptoKey = await crypto.subtle.importKey(
    'raw',
    key,
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  return await crypto.subtle.sign('HMAC', cryptoKey, encoder.encode(message));
}

async function hmacSha256Hex(key: ArrayBuffer, message: string): Promise<string> {
  const signature = await hmacSha256(key, message);
  const hashArray = Array.from(new Uint8Array(signature));
  return hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
}

async function getSignatureKey(key: string, dateStamp: string, regionName: string, serviceName: string): Promise<ArrayBuffer> {
  const encoder = new TextEncoder();
  const kDate = await hmacSha256(encoder.encode('AWS4' + key).buffer, dateStamp);
  const kRegion = await hmacSha256(kDate, regionName);
  const kService = await hmacSha256(kRegion, serviceName);
  const kSigning = await hmacSha256(kService, 'aws4_request');
  return kSigning;
}

// Direct upload endpoint - S3-compatible response
app.post("/api/upload-direct", async (c) => {
  try {
    const formData = await c.req.formData();
    const file = formData.get('file') as File;
    
    if (!file) {
      return c.json({ error: "No file provided" }, 400);
    }

    // Generate a unique key for the file
    const key = `uploads/${Date.now()}-${file.name}`;

    // Upload directly to R2
    await c.env.CONTACT_SHEET_BUCKET.put(key, file.stream(), {
      httpMetadata: {
        contentType: file.type,
      },
    });

    // Generate ETag (simple hash for compatibility)
    const etag = `"${Date.now()}-${file.size}"`;
    
    // Construct the file URL
    const fileUrl = `/api/file/${key}`;

    // Return S3-compatible XML response that Uppy expects
    const xmlResponse = `<?xml version="1.0" encoding="UTF-8"?>
<PostResponse>
  <Location>${fileUrl}</Location>
  <Bucket>contact-sheet-images</Bucket>
  <Key>${key}</Key>
  <ETag>${etag}</ETag>
</PostResponse>`;

    return new Response(xmlResponse, {
      status: 201,
      headers: {
        'Content-Type': 'application/xml',
        'ETag': etag,
        'Location': fileUrl,
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Expose-Headers': 'ETag, Location, Content-Length, Content-Type',
      },
    });

  } catch (error) {
    console.error('Error in direct upload:', error);
    return c.json({ 
      error: `Failed to upload file: ${error instanceof Error ? error.message : 'Unknown error'}` 
    }, 500);
  }
});

// Serve files from R2 - handle nested paths like uploads/filename
app.get("/api/file/*", async (c) => {
  try {
    const key = c.req.param('*'); // This captures the full path after /api/file/
    
    if (!key) {
      return c.json({ error: "File key is required" }, 400);
    }

    console.log('Serving file with key:', key);
    const object = await c.env.CONTACT_SHEET_BUCKET.get(key);
    
    if (!object) {
      return c.json({ error: "File not found" }, 404);
    }

    const data = await object.arrayBuffer();
    
    return new Response(data, {
      headers: {
        'Content-Type': object.httpMetadata?.contentType || 'application/octet-stream',
        'Cache-Control': 'public, max-age=3600',
        'Access-Control-Allow-Origin': '*',
      },
    });

  } catch (error) {
    console.error('Error serving file:', error);
    return c.json({ error: "Failed to serve file" }, 500);
  }
});

// Storage for progressive generation sessions
const progressiveSessions = new Map<string, {
  imageUrls: string[];
  canvas: Uint8Array | null;
  processedCount: number;
  totalExpected: number;
  columns: number;
  thumbnailSize: number;
  spacing: number;
}>();

// Progressive contact sheet generation endpoint
app.post("/api/progressive-generate", async (c) => {
  try {
    const requestData = await c.req.json();
    const { sessionId, imageUrls, isFirst, isComplete, totalExpected } = requestData;
    
    if (!sessionId) {
      return c.json({ error: "Session ID required" }, 400);
    }
    
    // Initialize session on first request
    if (isFirst) {
      progressiveSessions.set(sessionId, {
        imageUrls: [],
        canvas: null,
        processedCount: 0,
        totalExpected: totalExpected || 20,
        columns: 4,
        thumbnailSize: 200,
        spacing: 10,
      });
    }
    
    const session = progressiveSessions.get(sessionId);
    if (!session) {
      return c.json({ error: "Invalid session" }, 400);
    }
    
    // Add new images if provided
    if (imageUrls && Array.isArray(imageUrls)) {
      session.imageUrls.push(...imageUrls);
    }
    
    // If complete flag is set, generate final contact sheet
    if (isComplete && session.imageUrls.length > 0) {
      const contactSheetBytes = await generateContactSheet(
        session.imageUrls,
        {
          thumbnailSize: session.thumbnailSize,
          columns: session.columns,
          spacing: session.spacing,
          backgroundColor: '#ffffff',
        },
        c.env.CONTACT_SHEET_BUCKET
      );
      
      // Clean up session
      progressiveSessions.delete(sessionId);
      
      return new Response(contactSheetBytes, {
        headers: {
          "Content-Type": "image/png",
          "Content-Disposition": `attachment; filename="contact-sheet-${Date.now()}.png"`,
          "Cache-Control": "no-cache",
        },
      });
    }
    
    // Return progress update
    return c.json({
      sessionId,
      processedCount: session.imageUrls.length,
      totalExpected: session.totalExpected,
      status: "processing",
    });
    
  } catch (error) {
    console.error("Progressive generation error:", error);
    return c.json({ error: "Progressive generation failed" }, 500);
  }
});

// Endpoint to generate contact sheet
app.post("/api/generate-contact-sheet", async (c) => {
  let imageUrls: string[] = [];
  try {
    console.log('=== CONTACT SHEET GENERATION START ===');
    const requestData = await c.req.json();
    imageUrls = requestData.imageUrls;
    
    console.log(`Received ${imageUrls?.length || 0} image URLs:`, imageUrls);
    
    if (!imageUrls || !Array.isArray(imageUrls) || imageUrls.length === 0) {
      console.log('ERROR: No valid image URLs provided');
      return c.json({ error: "No image URLs provided" }, 400);
    }

    console.log('Starting contact sheet generation...');
    
    console.log('Starting contact sheet generation with options:', {
      thumbnailSize: 200,
      columns: 4,
      spacing: 10,
      backgroundColor: '#ffffff',
      imageCount: imageUrls.length
    });
    
    // Generate the contact sheet
    const contactSheetBytes = await generateContactSheet(imageUrls, {
      thumbnailSize: 200,
      columns: 4,
      spacing: 10,
      backgroundColor: '#ffffff'
    }, c.env.CONTACT_SHEET_BUCKET);
    
    console.log(`Contact sheet generation completed. Generated ${contactSheetBytes.length} bytes`);
    
    console.log(`Analyzing generated content: ${contactSheetBytes.length} bytes`);
    console.log(`First few bytes:`, Array.from(contactSheetBytes.slice(0, 10)).map(b => `0x${b.toString(16).padStart(2, '0')}`).join(' '));
    
    // Determine file type based on content
    const isImageBytes = contactSheetBytes.length > 1000 && 
                        (contactSheetBytes[0] === 0x89 && contactSheetBytes[1] === 0x50); // PNG header
    
    const fileExtension = isImageBytes ? 'png' : 'svg';
    const contentType = isImageBytes ? 'image/png' : 'image/svg+xml';
    
    console.log(`Returning ${fileExtension.toUpperCase()} directly with content-type: ${contentType}`);
    console.log('=== CONTACT SHEET GENERATION END ===');
    
    // Return the image data directly as a downloadable response
    return new Response(contactSheetBytes, {
      headers: {
        'Content-Type': contentType,
        'Content-Disposition': `attachment; filename="contact-sheet-${Date.now()}.${fileExtension}"`,
        'Cache-Control': 'no-cache',
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Expose-Headers': 'Content-Disposition, Content-Type',
      },
    });

  } catch (error) {
    console.error('=== CONTACT SHEET GENERATION ERROR ===');
    console.error('Error generating contact sheet:', error);
    console.error('Error stack:', error instanceof Error ? error.stack : 'No stack trace');
    console.error('Error details:', {
      name: error instanceof Error ? error.name : 'Unknown',
      message: error instanceof Error ? error.message : String(error),
      cause: error instanceof Error ? error.cause : undefined
    });
    console.error('Request details:', {
      hasImageUrls: !!imageUrls,
      imageCount: imageUrls?.length || 0,
      firstUrl: imageUrls?.[0] || 'none'
    });
    console.error('=== END ERROR ===');
    
    return c.json({ 
      success: false, 
      error: 'Failed to generate contact sheet',
      details: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : undefined
    }, 500);
  }
});

// Download endpoint for contact sheets
app.get("/api/download/:filename", async (c) => {
  try {
    const filename = c.req.param('filename');
    
    if (!filename) {
      return c.json({ error: "Filename is required" }, 400);
    }

    const key = `contact-sheets/${filename}`;
    const object = await c.env.CONTACT_SHEET_BUCKET.get(key);
    
    if (!object) {
      return c.json({ error: "File not found" }, 404);
    }

    const data = await object.arrayBuffer();
    
    return new Response(data, {
      headers: {
        'Content-Type': 'image/png',
        'Content-Disposition': `attachment; filename="${filename}"`,
        'Cache-Control': 'public, max-age=3600',
      },
    });

  } catch (error) {
    console.error('Error downloading file:', error);
    return c.json({ error: "Failed to download file" }, 500);
  }
});

// Health check endpoint
app.get("/api/health", (c) => c.json({ status: "ok", timestamp: new Date().toISOString() }));

export default app;
