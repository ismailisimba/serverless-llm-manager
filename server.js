// server.js
import express from 'express';
import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';
import cookieParser from 'cookie-parser'; // <<< Ensure this is imported
import { marked } from 'marked';
import { formidable } from 'formidable'; // <<< ADD formidable import
import * as fs from 'fs/promises'; // <<< ADD fs.promises import
import { logSessionEvent } from './bigquery-logger.js'; // <<< ADD Logger import
import { v4 as uuidv4 } from 'uuid'; // <<< ADD UUID import for request ID
import { Document, Packer, Paragraph, TextRun, HeadingLevel, AlignmentType } from 'docx'; // <<< ADD docx imports


// Import our Gemma client and GCS Session Manager
import { fetchIdentityToken, callGemmaService, callGemmaServiceStream } from './gemma-client.js';
import { sessionMiddleware } from './session-manager.js'; // <<< Use our GCS session middleware

dotenv.config();
const app = express();
const PORT = process.env.PORT || 8080;
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));

// --- Middleware ---
// Order is important! Static files -> Cookie Parser -> Session -> Body Parsers

// 1. Serve static files from 'public' directory
app.use(express.static(path.join(__dirname, 'public')));

// 2. Parse cookies BEFORE session middleware
app.use(cookieParser());

// 3. Custom session middleware (uses cookies and GCS)
app.use(sessionMiddleware);

// 4. Middleware to parse URL-encoded bodies & JSON bodies


// --- Routes ---

// Homepage route - Reads history from req.gemmaSession
app.get('/', (req, res) => {
    // We no longer load or pass history here. JS will fetch it.
    res.render('index', {
        // Pass marked just in case any server-side rendering remains or is added back
        marked: marked
        // No result, error, or chatHistory needed initially
    });
  });

// Route to handle form submission - Uses and Saves GCS-backed session
app.post('/generate' ,express.urlencoded({extended: true}), async (req, res) => {
  // Get session details attached by middleware
  const sessionId = req.gemmaSession.id;
  const chatHistory = req.gemmaSession.chatHistory; // This is a reference to the array

  const userPrompt = req.body.prompt;
  let resultText = null;
  let errorMsg = null;

  if (!userPrompt || userPrompt.trim() === '') {
    errorMsg = 'Please enter a prompt.';
    // Render immediately, no history change, no save needed
    return res.render('index', { result: null, error: errorMsg, chatHistory, marked });
  }

  const targetAudience = process.env.CLOUD_RUN_GEMMA_URL;
  const modelName = process.env.OLLAMA_MODEL || 'gemma3:4b';

  if (!targetAudience) {
      errorMsg = 'Server configuration error: Target Gemma service URL is not set.';
      console.error(errorMsg);
       // Render immediately, no history change, no save needed
      return res.render('index', { result: null, error: errorMsg, chatHistory, marked });
  }

  // Prepare history entry (prompt is always added)
  const currentEntry = { prompt: userPrompt };

  try {
    console.log(`[Session: ${sessionId}] Received prompt, fetching token...`);
    const token = await fetchIdentityToken(targetAudience);

    console.log(`[Session: ${sessionId}] Token fetched, calling Gemma service (Model: ${modelName})...`);
    const gemmaResponse = await callGemmaService(
      targetAudience,
      token,
      userPrompt,
      modelName,
      60000 // Timeout 60 seconds
    );

    console.log(`[Session: ${sessionId}] Gemma service call successful.`);
    resultText = gemmaResponse?.response ?? 'Model returned no text.';
    currentEntry.response = resultText; // Add successful response to entry

  } catch (error) {
    console.error(`[Session: ${sessionId}] Error during Gemma call:`, error);
    errorMsg = `Failed to get response: ${error.message}`;
    currentEntry.error = errorMsg; // Add error message to entry
  }

  // Add the current interaction entry to the history array
  chatHistory.push(currentEntry);

  // --- Persist the updated session data to GCS --- <<< IMPORTANT STEP >>>
  try {
      console.log(`[Session: ${sessionId}] Saving updated chat history to GCS...`);
      await req.gemmaSession.save(); // Call the save function attached by middleware
      console.log(`[Session: ${sessionId}] Session saved successfully.`);
  } catch(saveError) {
      console.error(`[Session: ${sessionId}] CRITICAL: Failed to save session to GCS!`, saveError);
      // Decide how to handle save errors. Options:
      // 1. Inform the user (set a specific errorMsg, maybe don't overwrite gemma error)
      // 2. Just log it and continue (history might be inconsistent on next load)
      // For now, we'll log it and overwrite the previous errorMsg if it was null
      if (!errorMsg) {
          errorMsg = "Error saving chat history. Your session might be inconsistent.";
      }
  }

  // Render the page again with the latest result/error AND the full updated history
  res.render('index', { result: resultText, error: errorMsg, chatHistory, marked });
});



app.post('/generate-stream', async (req, res) => {

    const startTime = Date.now(); // <<< Record start time
    const requestId = uuidv4(); // <<< Generate unique request ID

    // Use Formidable V3+ async/await style
    const form = formidable({
        multiples: true, // Important for multiple file uploads
        maxFileSize: 5 * 1024 * 1024, // Example: 5MB limit per file (optional)
        allowEmptyFiles: true,
        minFileSize:0,
        // keepExtensions: true, // Keep original extensions in temporary file path (optional)
    });
  
    let fields;
    let files;
    try {
        // formidable v3 uses promises directly
        [fields, files] = await form.parse(req);
    } catch (err) {
        console.error('Error parsing form data:', err);
        res.writeHead(400, { 'Content-Type': 'text/plain' }); // Use writeHead for consistency? Or simple res.status?
        res.end('Error parsing form data.');


            // Log error event before returning
            await logSessionEvent({
                session_id: req.gemmaSession?.id || 'unknown', // Try to get session ID
                request_id: requestId,
                model_name: process.env.OLLAMA_MODEL || 'gemma3:4b',
                prompt_length: fields?.prompt?.[0]?.length || 0,
                image_count: (files?.images || []).length,
                duration_ms: Date.now() - startTime,
                was_success: false,
                error_message: `Form parsing error: ${err.message}`.substring(0, 1000), // Limit error length
            });


        return;
    }
  
    // --- Start SSE ---
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    });
  
    // --- Extract Data & Session ---
    // Note: formidable v3 wraps fields in arrays, even if single value
    const userPrompt = fields.prompt?.[0]?.trim();
    const uploadedFiles = files.images || []; // Will be an array if files were uploaded
  
    const sessionId = req.gemmaSession.id;
    const chatHistory = req.gemmaSession.chatHistory;
  
    // --- Validation ---
    if (!userPrompt) {
        res.write(`event: error\ndata: ${JSON.stringify({ message: "Prompt is missing." })}\n\n`);
         // Log error event before returning
         await logSessionEvent({
            session_id: sessionId, request_id: requestId, was_success: false,
            error_message: 'Prompt is missing.'
         });
        return res.end();
    }
  
    const targetAudience = process.env.CLOUD_RUN_GEMMA_URL;
    const modelName = process.env.OLLAMA_MODEL || 'gemma3:4b';
  
    if (!targetAudience) {
        console.error(`[Session: ${sessionId}] Server configuration error: Target URL missing.`);
        res.write(`event: error\ndata: ${JSON.stringify({ message: "Server configuration error." })}\n\n`);
          // Log error event before returning
          await logSessionEvent({
            session_id: sessionId, request_id: requestId, was_success: false,
            error_message: 'Server configuration error: Target URL missing.'
        });
        return res.end();
    }
  
    // --- Prepare History & Ollama Call ---
    let fullResponseAccumulator = '';
    const promptForHistory = uploadedFiles.length > 0
        ? `${userPrompt} (+ ${uploadedFiles.length} image${uploadedFiles.length > 1 ? 's' : ''})`
        : userPrompt;
    const currentEntry = { prompt: promptForHistory }; // Use modified prompt for history display
    let base64Images = null; // Will hold array of base64 strings if images present
    let ollamaStats = null; // <<< To store the final Ollama stats chunk
  
    try {
        // --- Process Uploaded Files (if any) ---
        if (uploadedFiles.length > 0) {
            console.log(`[Session: ${sessionId}] Processing ${uploadedFiles.length} uploaded image(s)...`);
            base64Images = [];
            let validFiles = 0;
            for (const file of uploadedFiles) {
                if (file.size === 0) continue; // Skip empty file inputs
                validFiles++;
                // Basic MIME type check (optional but recommended)
                if (!file.mimetype?.startsWith('image/')) {
                    console.warn(`[Session: ${sessionId}] Skipping non-image file: ${file.originalFilename} (${file.mimetype})`);
                    continue;
                }
                try {
                    const fileBuffer = await fs.readFile(file.filepath);
                    base64Images.push(fileBuffer.toString('base64'));
                    // No need to delete temp file, formidable v3 usually handles cleanup
                } catch (readError) {
                    console.error(`[Session: ${sessionId}] Error reading uploaded file ${file.originalFilename}:`, readError);
                    // Optionally notify client via SSE error event?
                    throw new Error(`Failed to read uploaded file: ${file.originalFilename}`);
                }
            }
            console.log(`[Session: ${sessionId}] Processed ${base64Images.length} image(s) to base64.`);
            if(base64Images.length === 0 && uploadedFiles.length > 0 && validFiles > 0) {
                // If files were selected but none were valid images
                 throw new Error("Uploaded files were not valid images.");
            }
        }
  
        // --- Fetch Auth Token ---
        console.log(`[Session: ${sessionId}] Stream request: Fetching token...`);
        const token = await fetchIdentityToken(targetAudience);
  
        // --- Initiate Streaming Call (potentially multimodal) ---
        console.log(`[Session: ${sessionId}] Stream request: Calling Ollama stream...`);
        const ollamaResponse = await callGemmaServiceStream(
            targetAudience,
            token,
            userPrompt, // Send the original text prompt to Ollama
            modelName,
            base64Images // Pass array of base64 strings, or null
        );
  
        // --- Process Stream ---
        const stream = ollamaResponse.data;
  
        stream.on('data', (chunk) => {
            try {
                const chunkString = chunk.toString();
                chunkString.split('\n').forEach(line => {
                    if (line.trim()) {
                        const parsed = JSON.parse(line);
                        if (parsed.response) {
                            fullResponseAccumulator += parsed.response;
                            res.write(`data: ${JSON.stringify({ text: parsed.response })}\n\n`);
                        }
                        if (parsed.done) {
                             console.log(`[Session: ${sessionId}] Ollama stream 'done' received.`);
                             // Signal done (history save happens on 'end')
                             res.write(`event: done\ndata: ${JSON.stringify({ fullResponse: fullResponseAccumulator })}\n\n`);
                        }
                    }
                });
            } catch (parseError) {
                console.error(`[Session: ${sessionId}] Error parsing stream chunk: ${parseError}. Chunk: "${chunk.toString()}"`);
            }
        });
  
        stream.on('end', async () => {
            console.log(`[Session: ${sessionId}] Ollama stream ended.`);
            currentEntry.response = fullResponseAccumulator;
            chatHistory.push(currentEntry);
            try {
                await req.gemmaSession.save();
                console.log(`[Session: ${sessionId}] Session history saved after stream end.`);
                    // <<< Log SUCCESS event to BigQuery >>>
            await logSessionEvent({
                session_id: sessionId, request_id: requestId, model_name: modelName,
                prompt_length: userPrompt.length, image_count: base64Images?.length || 0,
                response_length: fullResponseAccumulator.length,
                duration_ms: Date.now() - startTime, was_success: true, error_message: null,
                gemma_total_duration_ns: ollamaStats?.total_duration, // Use captured stats
                gemma_load_duration_ns: ollamaStats?.load_duration,
                gemma_prompt_eval_count: ollamaStats?.prompt_eval_count,
                gemma_eval_count: ollamaStats?.eval_count
            });
            } catch (saveError) {
                console.error(`[Session: ${sessionId}] CRITICAL: Failed to save session after stream end!`, saveError);
            }
            res.end();
        });
  
        stream.on('error', async (streamError) => {
            console.error(`[Session: ${sessionId}] Error during Ollama stream:`, streamError);
            currentEntry.error = `Stream error: ${streamError.message}`;
            chatHistory.push(currentEntry);
            try { await req.gemmaSession.save(); } catch (saveError) { /* log */ }
              // <<< Log FAILURE event to BigQuery >>>
              await logSessionEvent({
                session_id: sessionId, request_id: requestId, model_name: modelName,
                prompt_length: userPrompt.length, image_count: base64Images?.length || 0,
                response_length: fullResponseAccumulator.length, // Log partial response length
                duration_ms: Date.now() - startTime, was_success: false,
                error_message: errorMessage.substring(0, 1000) // Limit error length
                // Ollama stats likely unavailable here
            });
            if (!res.writableEnded) {
                res.write(`event: error\ndata: ${JSON.stringify({ message: `Stream error: ${streamError.message}` })}\n\n`);
                res.end();
            }
        });
  
    } catch (initialError) {
        console.error(`[Session: ${sessionId}] Error setting up stream or processing files:`, initialError);
        currentEntry.error = `Failed to start generation: ${initialError.message}`;
        chatHistory.push(currentEntry);
        try { await req.gemmaSession.save(); } catch(saveError) { /* log */ }


         // <<< Log FAILURE event to BigQuery >>>
         await logSessionEvent({
            session_id: sessionId, request_id: requestId, model_name: modelName,
            prompt_length: userPrompt.length, image_count: base64Images?.length || 0,
            duration_ms: Date.now() - startTime, was_success: false,
            error_message: errorMessage.substring(0, 1000) // Limit error length
        });

         if (!res.headersSent) {
             res.writeHead(500, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', 'Connection': 'keep-alive' });
         }
        if (!res.writableEnded) {
            res.write(`event: error\ndata: ${JSON.stringify({ message: `Failed to start generation: ${initialError.message}` })}\n\n`);
            res.end();
        }
    }
  }); // End POST /generate-stream





  // --- ADD DOWNLOAD ROUTES ---

// GET /download/txt - Download chat history as plain text
app.get('/download/txt', (req, res) => {
    const sessionId = req.gemmaSession.id;
    const chatHistory = req.gemmaSession.chatHistory || [];
    console.log(`[Session: ${sessionId}] Requested TXT download.`);

    if (chatHistory.length === 0) {
        res.status(404).send('No chat history found for this session.');
        return;
    }

    let formattedText = `Chat History - Session: ${sessionId}\n`;
    formattedText += "========================================\n\n";

    chatHistory.forEach((entry, index) => {
        formattedText += `Interaction ${index + 1}:\n`;
        formattedText += `You:\n${entry.prompt}\n\n`;
        if (entry.response) {
            formattedText += `Gemma:\n${entry.response}\n\n`;
        } else if (entry.error) {
            formattedText += `Error:\n${entry.error}\n\n`;
        }
        formattedText += "---\n\n";
    });

    // Set headers for file download
    res.setHeader('Content-Type', 'text/plain');
    res.setHeader('Content-Disposition', 'attachment; filename="chat_history.txt"');
    res.send(formattedText);
});


// GET /download/docx - Download chat history as Word document
app.get('/download/docx', async (req, res) => {
    const sessionId = req.gemmaSession.id;
    const chatHistory = req.gemmaSession.chatHistory || [];
    console.log(`[Session: ${sessionId}] Requested DOCX download.`);

    if (chatHistory.length === 0) {
        res.status(404).send('No chat history found for this session.');
        return;
    }

    const sections = [];

    // Add a title
     sections.push(
         new Paragraph({
             heading: HeadingLevel.TITLE,
             alignment: AlignmentType.CENTER,
             children: [new TextRun(`Chat History - Session ${sessionId}`)],
         })
     );
     sections.push(new Paragraph(" ")); // Spacer

    chatHistory.forEach((entry, index) => {
        // Add prompt
        sections.push(
            new Paragraph({
                heading: HeadingLevel.HEADING_2,
                children: [new TextRun(`Interaction ${index + 1}: You`)],
            })
        );
        // Handle potential newlines in prompt - split into paragraphs
        entry.prompt.split('\n').forEach(line => {
            sections.push(new Paragraph({ children: [new TextRun(line)] }));
        });
         sections.push(new Paragraph(" ")); // Spacer

        // Add response or error
        if (entry.response) {
            sections.push(
                new Paragraph({
                    heading: HeadingLevel.HEADING_2,
                    children: [new TextRun("Gemma:")],
                })
            );
            // Handle potential newlines in response
            entry.response.split('\n').forEach(line => {
                 sections.push(new Paragraph({ children: [new TextRun(line)] }));
            });
        } else if (entry.error) {
             sections.push(
                new Paragraph({
                    heading: HeadingLevel.HEADING_2,
                    children: [new TextRun({ text: "Error:", bold: true })],
                })
            );
            // Handle potential newlines in error
            entry.error.split('\n').forEach(line => {
                 sections.push(new Paragraph({ children: [new TextRun({ text: line, color: "FF0000" })] })); // Red text for error
            });
        }
         sections.push(new Paragraph("---")); // Separator
         sections.push(new Paragraph(" ")); // Spacer

    });

    // Create document
    const doc = new Document({
        sections: [{
            properties: {},
            children: sections,
        }],
    });

    try {
        // Generate buffer
        const buffer = await Packer.toBuffer(doc);

        // Set headers for file download
        res.setHeader('Content-Disposition', 'attachment; filename="chat_history.docx"');
        res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
        res.send(buffer);
        console.log(`[Session: ${sessionId}] DOCX file generated and sent.`);
    } catch (error) {
         console.error(`[Session: ${sessionId}] Error generating DOCX:`, error);
         res.status(500).send('Error generating Word document.');
    }
});




// <<< ADD NEW API ROUTE TO GET HISTORY >>>
app.get('/api/history', (req, res) => {
    // Session middleware should have run, attaching req.gemmaSession
    const userId = req.gemmaSession?.userId; // Check if userId was attached (means header was present)
    const sessionId = req.gemmaSession?.id;

    // We absolutely need the userId from the header for this to work correctly
    if (!userId) {
        console.warn(`Attempt to access /api/history without X-User-ID header (Session: ${sessionId})`);
        // Send empty history or an error? Let's send empty for now.
        return res.json({ chatHistory: [] });
        // Or send error: return res.status(400).json({ error: 'Missing X-User-ID header' });
    }

    console.log(`[Session: ${sessionId}, User: ${userId}] GET /api/history request`);
    // The sessionMiddleware already loaded the history based on cookie + header
    res.json({ chatHistory: req.gemmaSession.chatHistory || [] });
});






// --- Start the Server ---
app.listen(PORT, () => {
  console.log(`Server listening on port ${PORT}`);
  console.log(`Access the UI at http://localhost:${PORT}`);
});

export default app;