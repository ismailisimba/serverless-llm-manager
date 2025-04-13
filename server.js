// server.js
import express from 'express';
import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';
import cookieParser from 'cookie-parser';
import { marked } from 'marked';
import { formidable } from 'formidable';
import * as fs from 'fs/promises';
import { logSessionEvent } from './bigquery-logger.js';
import { v4 as uuidv4 } from 'uuid';
import axios from 'axios';

// Import our Gemma client and GCS Session Manager
// <<< USE THE NEW CHAT FUNCTIONS >>>
import { fetchIdentityToken, callGemmaChatService, callGemmaChatServiceStream } from './gemma-client.js';
import { sessionMiddleware } from './session-manager.js';
import DownloadGenerator from './download-generator.js';

// <<< Import the ClickPesa client functions >>>
import { getClickPesaAuthToken, initiateClickPesaUssdPush } from './clickpesa-client.js';


dotenv.config();
const app = express();
const PORT = process.env.PORT || 8080;
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const downloadGenerator = new DownloadGenerator();

app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));

// --- Middleware (remains the same) ---
app.use(express.static(path.join(__dirname, 'public')));
app.use(cookieParser());
app.use(sessionMiddleware);
app.use(express.json());
// Body parsers are applied per-route where needed

// --- Routes ---

// Homepage route (remains the same)
app.get('/', (req, res) => {
    res.render('index', { marked: marked });
});

// Route to handle non-streaming generation (MODIFIED)
app.post('/generate', express.urlencoded({ extended: true }), async (req, res) => {
    const sessionId = req.gemmaSession.id;
    const chatHistory = req.gemmaSession.chatHistory; // Get history reference

    const userPrompt = req.body.prompt;
    let resultText = null;
    let errorMsg = null;

    if (!userPrompt || userPrompt.trim() === '') {
        errorMsg = 'Please enter a prompt.';
        return res.render('index', { result: null, error: errorMsg, chatHistory, marked });
    }

    const targetAudience = process.env.CLOUD_RUN_GEMMA_URL;
    const modelName = process.env.OLLAMA_MODEL || 'gemma3:4b'; // Ensure this matches your Ollama model

    if (!targetAudience) {
        errorMsg = 'Server configuration error: Target Gemma service URL is not set.';
        console.error(errorMsg);
        return res.render('index', { result: null, error: errorMsg, chatHistory, marked });
    }

    const currentEntry = { prompt: userPrompt };

    try {
        console.log(`[Session: ${sessionId}] Received prompt, fetching token...`);
        const token = await fetchIdentityToken(targetAudience);

        console.log(`[Session: ${sessionId}] Token fetched, calling Gemma CHAT service (Model: ${modelName})...`);

        // <<< CALL callGemmaChatService and PASS chatHistory >>>
        const gemmaResponse = await callGemmaChatService(
            targetAudience,
            token,
            userPrompt,
            modelName,
            chatHistory, // <<< Pass the history
            60000 // Timeout
        );

        console.log(`[Session: ${sessionId}] Gemma CHAT service call successful.`);
        // <<< EXTRACT content from message object >>>
        resultText = gemmaResponse?.message?.content ?? 'Model returned no text.';
        currentEntry.response = resultText;

    } catch (error) {
        console.error(`[Session: ${sessionId}] Error during Gemma CHAT call:`, error);
        errorMsg = `Failed to get response: ${error.message}`;
        currentEntry.error = errorMsg;
    }

    // Add the current interaction entry to the history array
    chatHistory.push(currentEntry);

    // --- Persist the updated session data to GCS ---
    try {
        console.log(`[Session: ${sessionId}] Saving updated chat history to GCS...`);
        await req.gemmaSession.save();
        console.log(`[Session: ${sessionId}] Session saved successfully.`);
    } catch (saveError) {
        console.error(`[Session: ${sessionId}] CRITICAL: Failed to save session to GCS!`, saveError);
        if (!errorMsg) {
            errorMsg = "Error saving chat history. Your session might be inconsistent.";
        }
    }

    // Render the page
    res.render('index', { result: resultText, error: errorMsg, chatHistory, marked });
});

// Route to handle streaming generation (MODIFIED)
app.post('/generate-stream', async (req, res) => {
    const startTime = Date.now();
    const requestId = uuidv4();

    // --- Formidable Parsing (remains the same) ---
    const form = formidable({ multiples: true, maxFileSize: 5 * 1024 * 1024, allowEmptyFiles: true, minFileSize: 0 });
    let fields;
    let files;
    try {
        [fields, files] = await form.parse(req);
    } catch (err) {
        console.error('Error parsing form data:', err);
        // Log error before returning
        await logSessionEvent({
            session_id: req.gemmaSession?.id || 'unknown', request_id: requestId,
            model_name: process.env.OLLAMA_MODEL || 'gemma3:4b', // Use consistent model name
            prompt_length: fields?.prompt?.[0]?.length || 0,
            image_count: (files?.images || []).length,
            duration_ms: Date.now() - startTime, was_success: false,
            error_message: `Form parsing error: ${err.message}`.substring(0, 1000),
        });
         // Ensure response is sent correctly
         if (!res.headersSent) {
             res.writeHead(400, { 'Content-Type': 'text/plain' });
         }
         if (!res.writableEnded) {
             res.end('Error parsing form data.');
         }
        return;
    }

    // --- Start SSE (remains the same) ---
    res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
    });

    // --- Extract Data & Session (remains the same) ---
    const userPrompt = fields.prompt?.[0]?.trim();
    const uploadedFiles = files.images || [];
    const sessionId = req.gemmaSession.id;
    const chatHistory = req.gemmaSession.chatHistory; // Get history reference

    // --- Validation (remains the same) ---
    if (!userPrompt) {
        const errorMessage = "Prompt is missing.";
        res.write(`event: error\ndata: ${JSON.stringify({ message: errorMessage })}\n\n`);
        await logSessionEvent({
            session_id: sessionId, request_id: requestId, was_success: false,
            error_message: errorMessage, duration_ms: Date.now() - startTime,
             model_name: process.env.OLLAMA_MODEL || 'gemma3:4b'
        });
        return res.end();
    }

    const targetAudience = process.env.CLOUD_RUN_GEMMA_URL;
    const modelName = process.env.OLLAMA_MODEL || 'gemma3:4b'; // Ensure consistency

    if (!targetAudience) {
         const errorMessage = "Server configuration error: Target URL missing.";
        console.error(`[Session: ${sessionId}] ${errorMessage}`);
        res.write(`event: error\ndata: ${JSON.stringify({ message: "Server configuration error." })}\n\n`);
        await logSessionEvent({
            session_id: sessionId, request_id: requestId, was_success: false,
            error_message: errorMessage, duration_ms: Date.now() - startTime,
             model_name: modelName
        });
        return res.end();
    }

    // --- Prepare History & Ollama Call (slight modification for prompt) ---
    let fullResponseAccumulator = '';
    const promptForHistory = uploadedFiles.length > 0
        ? `${userPrompt} (+ ${uploadedFiles.length} image${uploadedFiles.length > 1 ? 's' : ''})`
        : userPrompt;
    const currentEntry = { prompt: promptForHistory }; // Use potentially modified prompt for history display
    let base64Images = null;
    let ollamaStats = null; // To store final Ollama stats

    try {
        // --- Process Uploaded Files (remains the same) ---
        if (uploadedFiles.length > 0) {
            console.log(`[Session: ${sessionId}] Processing ${uploadedFiles.length} uploaded image(s)...`);
            base64Images = [];
            let validFiles = 0;
            for (const file of uploadedFiles) {
                if (file.size === 0) continue;
                 validFiles++;
                if (!file.mimetype?.startsWith('image/')) {
                    console.warn(`[Session: ${sessionId}] Skipping non-image file: ${file.originalFilename} (${file.mimetype})`);
                    continue;
                }
                try {
                    const fileBuffer = await fs.readFile(file.filepath);
                    base64Images.push(fileBuffer.toString('base64'));
                } catch (readError) {
                    console.error(`[Session: ${sessionId}] Error reading uploaded file ${file.originalFilename}:`, readError);
                    throw new Error(`Failed to read uploaded file: ${file.originalFilename}`);
                }
            }
            console.log(`[Session: ${sessionId}] Processed ${base64Images.length} image(s) to base64.`);
             if(base64Images.length === 0 && uploadedFiles.length > 0 && validFiles > 0) {
               throw new Error("Uploaded files were not valid images.");
             }
        }

        // --- Fetch Auth Token (remains the same) ---
        console.log(`[Session: ${sessionId}] Stream request: Fetching token...`);
        const token = await fetchIdentityToken(targetAudience);

        // --- Initiate Streaming Call (MODIFIED) ---
        console.log(`[Session: ${sessionId}] Stream request: Calling Ollama CHAT stream...`);

        // <<< CALL callGemmaChatServiceStream and PASS chatHistory >>>
        const ollamaResponse = await callGemmaChatServiceStream(
            targetAudience,
            token,
            userPrompt, // Original prompt sent to LLM
            modelName,
            chatHistory, // <<< Pass the history
            base64Images, // Pass processed images
             600000 // Timeout
        );

        // --- Process Stream (MODIFIED) ---
        const stream = ollamaResponse.data;

        stream.on('data', (chunk) => {
            try {
                const chunkString = chunk.toString();
                chunkString.split('\n').forEach(line => {
                    if (line.trim()) {
                        const parsed = JSON.parse(line);
                        // <<< Extract content from message object in chunk >>>
                        if (parsed.message && parsed.message.content) {
                            fullResponseAccumulator += parsed.message.content;
                            res.write(`data: ${JSON.stringify({ text: parsed.message.content })}\n\n`);
                        }
                        // Capture final stats if present (usually in the last chunk when done=true)
                        if (parsed.done) {
                             ollamaStats = {
                                 total_duration: parsed.total_duration,
                                 load_duration: parsed.load_duration,
                                 prompt_eval_count: parsed.prompt_eval_count,
                                 prompt_eval_duration: parsed.prompt_eval_duration,
                                 eval_count: parsed.eval_count,
                                 eval_duration: parsed.eval_duration
                             };
                            console.log(`[Session: ${sessionId}] Ollama stream 'done' received. Stats captured.`);
                            // Signal done (history save happens on 'end')
                            res.write(`event: done\ndata: ${JSON.stringify({ fullResponse: fullResponseAccumulator })}\n\n`);
                        }
                    }
                });
            } catch (parseError) {
                console.error(`[Session: ${sessionId}] Error parsing stream chunk: ${parseError}. Chunk: "${chunk.toString()}"`);
                 // Optionally send an error event to the client?
                 // res.write(`event: error\ndata: ${JSON.stringify({ message: "Error processing response stream." })}\n\n`);
            }
        });

        stream.on('end', async () => {
            console.log(`[Session: ${sessionId}] Ollama stream ended.`);
            currentEntry.response = fullResponseAccumulator;
            chatHistory.push(currentEntry);
            try {
                await req.gemmaSession.save();
                console.log(`[Session: ${sessionId}] Session history saved after stream end.`);
                // Log SUCCESS event
                 await logSessionEvent({
                     session_id: sessionId, request_id: requestId, model_name: modelName,
                     prompt_length: userPrompt.length, image_count: base64Images?.length || 0,
                     response_length: fullResponseAccumulator.length,
                     duration_ms: Date.now() - startTime, was_success: true, error_message: null,
                     gemma_total_duration_ns: ollamaStats?.total_duration,
                     gemma_load_duration_ns: ollamaStats?.load_duration,
                     gemma_prompt_eval_count: ollamaStats?.prompt_eval_count,
                     gemma_eval_count: ollamaStats?.eval_count
                 });
            } catch (saveError) {
                console.error(`[Session: ${sessionId}] CRITICAL: Failed to save session after stream end!`, saveError);
            }
             if (!res.writableEnded) {
                res.end();
            }
        });

        stream.on('error', async (streamError) => {
            const errorMessage = `Stream error: ${streamError.message}`;
            console.error(`[Session: ${sessionId}] Error during Ollama stream:`, streamError);
            currentEntry.error = errorMessage;
            chatHistory.push(currentEntry);
            try { await req.gemmaSession.save(); } catch (saveError) { console.error(`[Session: ${sessionId}] Failed to save session after stream error:`, saveError); }

             // Log FAILURE event
             await logSessionEvent({
                 session_id: sessionId, request_id: requestId, model_name: modelName,
                 prompt_length: userPrompt.length, image_count: base64Images?.length || 0,
                 response_length: fullResponseAccumulator.length, // Log partial response length
                 duration_ms: Date.now() - startTime, was_success: false,
                 error_message: errorMessage.substring(0, 1000)
             });

            if (!res.writableEnded) {
                 // Check if headers were already sent before trying to write error event
                 if (res.headersSent) {
                      res.write(`event: error\ndata: ${JSON.stringify({ message: errorMessage })}\n\n`);
                 } else {
                      // If headers not sent, maybe send a plain error response?
                       res.writeHead(500, { 'Content-Type': 'text/plain' });
                       res.write(`Error during generation: ${errorMessage}`);
                 }
                res.end();
            }
        });

    } catch (initialError) {
         const errorMessage = `Failed to start generation: ${initialError.message}`;
        console.error(`[Session: ${sessionId}] Error setting up stream or processing files:`, initialError);
        currentEntry.error = errorMessage;
        chatHistory.push(currentEntry);
        try { await req.gemmaSession.save(); } catch(saveError) { console.error(`[Session: ${sessionId}] Failed to save session after initial error:`, saveError); }

        // Log FAILURE event
        await logSessionEvent({
            session_id: sessionId, request_id: requestId, model_name: modelName,
            prompt_length: userPrompt?.length || 0, image_count: base64Images?.length || 0,
            duration_ms: Date.now() - startTime, was_success: false,
            error_message: errorMessage.substring(0, 1000)
        });

        if (!res.headersSent) {
             res.writeHead(500, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', 'Connection': 'keep-alive' });
        }
         if (!res.writableEnded) {
            res.write(`event: error\ndata: ${JSON.stringify({ message: errorMessage })}\n\n`);
            res.end();
        }
    }
}); // End POST /generate-stream


// --- Download Routes (remain the same) ---
// GET /download/txt
app.get('/download/txt', (req, res) => {
    const sessionId = req.gemmaSession.id;
    const chatHistory = req.gemmaSession.chatHistory || [];
    console.log(`[Session: ${sessionId}] Requested TXT download.`);
    if (chatHistory.length === 0) { return res.status(404).send('No chat history found for this session.'); }
    try {
        const formattedText = downloadGenerator.generateTxt(chatHistory, sessionId);
        res.setHeader('Content-Type', 'text/plain');
        res.setHeader('Content-Disposition', 'attachment; filename="chat_history.txt"');
        res.send(formattedText);
        console.log(`[Route: /download/txt] [Session: ${sessionId}] TXT file sent.`);
    } catch (error) {
        console.error(`[Route: /download/txt] [Session: ${sessionId}] Error generating TXT:`, error);
        res.status(500).send('Error generating text file.');
    }
});

// GET /download/docx
app.get('/download/docx', async (req, res) => {
    const sessionId = req.gemmaSession.id;
    const chatHistory = req.gemmaSession.chatHistory || [];
    console.log(`[Session: ${sessionId}] Requested DOCX download.`);
     if (chatHistory.length === 0) { return res.status(404).send('No chat history found for this session.'); }
    try {
        const buffer = await downloadGenerator.generateDocx(chatHistory, sessionId);
        res.setHeader('Content-Disposition', 'attachment; filename="chat_history.docx"');
        res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
        res.send(buffer);
        console.log(`[Session: ${sessionId}] DOCX file generated and sent.`);
    } catch (error) {
        console.error(`[Session: ${sessionId}] Error generating DOCX:`, error);
        res.status(500).send('Error generating Word document.');
    }
});

// GET /download/pdf
app.get('/download/pdf', async (req, res) => {
    const sessionId = req.gemmaSession.id;
    const chatHistory = req.gemmaSession.chatHistory || [];
    console.log(`[Session: ${sessionId}] Requested PDF download.`);
    const cssPath = path.join(__dirname, 'public', 'css', 'style.css');
     if (chatHistory.length === 0) { return res.status(404).send('No chat history found for this session.'); }
    try {
        const pdfBuffer = await downloadGenerator.generatePdf(chatHistory, sessionId, cssPath);
        res.setHeader('Content-Disposition', 'attachment; filename="chat_history.pdf"');
        res.setHeader('Content-Type', 'application/pdf');
        res.send(pdfBuffer);
        console.log(`[Session: ${sessionId}] PDF file sent.`);
    } catch (error) {
        console.error(`[Session: ${sessionId}] Error generating PDF:`, error);
        res.status(500).send(`Error generating PDF document: ${error.message}`);
    }
});




// --- Route to Initiate Donation (Updated) ---
app.post('/api/initiate-donation', async (req, res) => {
    const sessionId = req.gemmaSession.id;
    const userId = req.gemmaSession.userId || 'anonymous';
    const { phoneNumber } = req.body;

    console.log(`[Session: ${sessionId}] Donation attempt. Phone: ${phoneNumber}`);

    if (!phoneNumber || !/^\+255[67]\d{8}$/.test(phoneNumber)) {
        return res.status(400).json({ success: false, message: "Nambari ya simu si sahihi. Umbizo: +255xxxxxxxxx (Invalid phone number. Format: +255xxxxxxxxx)" });
    }

    // <<< Retrieve ClickPesa Credentials from environment (set via Secret Manager) >>>
    const CLICKPESA_CLIENT_ID = process.env.CLICKPESA_CLIENT_ID;
    const CLICKPESA_API_KEY = process.env.CLICKPESA_API_KEY;
    const CLICKPESA_WEBHOOK_URL = process.env.CLICKPESA_WEBHOOK_URL; // Set via --set-env-vars

    if (!CLICKPESA_CLIENT_ID || !CLICKPESA_API_KEY || !CLICKPESA_WEBHOOK_URL) {
        console.error(`[Session: ${sessionId}] ClickPesa credentials or Webhook URL missing server-side.`);
        return res.status(500).json({ success: false, message: "Tatizo la kimtandao. (Server configuration error.)" });
    }

    const amount = "1500"; // Amount must be string per ClickPesa docs
    const currency = "TZS";
    const orderReference = uuidv4().substring(0, 8); // Shorter, unique ID
    const description = "Gemma UI Donation"; // Optional, check if ClickPesa uses it

    try {
        // 1. Get Auth Token
        console.log(`[Session: ${sessionId}] Getting ClickPesa Auth Token. Ref: ${orderReference}`);
        const authToken = await getClickPesaAuthToken(CLICKPESA_CLIENT_ID, CLICKPESA_API_KEY);
        console.log(authToken, "authToken")

        // 2. Prepare Payload for USSD Push
        const payload = {
            amount: amount,
            currency: currency,
            orderReference: orderReference,
            phoneNumber: phoneNumber.replaceAll("+",""),
            // checksum: "...", // Add if required and calculated
             // description: description, // Add if supported/useful
             // webhook_url: CLICKPESA_WEBHOOK_URL // Add if required in this specific request
        };
         // Note: The webhook URL might be configured globally in ClickPesa dashboard
         // rather than per-request. Confirm with ClickPesa docs.

        // 3. Initiate USSD Push
        console.log(`[Session: ${sessionId}] Calling ClickPesa Initiate USSD Push. Ref: ${orderReference}`);
        const clickPesaResponse = await initiateClickPesaUssdPush(authToken, payload);

        // 4. Handle Response (adapt based on actual ClickPesa response)
        // Docs suggest response includes status: PROCESSING on successful initiation
        if (clickPesaResponse && clickPesaResponse.status === 'PROCESSING') {
            console.log(`[Session: ${sessionId}] ClickPesa initiation successful. Ref: ${orderReference}. Status: ${clickPesaResponse.status}`);
             // Log initiation attempt maybe?
             logSessionEvent({
                  session_id: sessionId,
                  user_id: userId,
                  request_id: orderReference, // Use orderRef as request ID for donation
                  event_type: 'donation_initiated',
                  merchant_ref: orderReference,
                  donation_amount: parseInt(amount),
                  // phone_number_hash: require('crypto').createHash('sha256').update(phoneNumber).digest('hex') // Hash PII if logging
                  clickpesa_txn_id: clickPesaResponse.id // Log ClickPesa's ID
             });
            res.json({ success: true, message: "Tafadhali angalia simu yako kuidhinisha malipo TZS 1500. (Please check your phone to authorize the TZS 1500 payment.)" });
        } else {
            // Handle cases where initiation didn't return PROCESSING status
            console.warn(`[Session: ${sessionId}] ClickPesa initiation did not return PROCESSING status. Ref: ${orderReference}`, clickPesaResponse);
            res.status(400).json({ success: false, message: `ClickPesa Error: ${clickPesaResponse?.message || 'Initiation failed. Status: ' + clickPesaResponse?.status}` });
        }

    } catch (error) {
        console.error(`[Session: ${sessionId}] Failed donation process. Ref: ${orderReference}:`, error.message);
        // Log system error maybe?
        res.status(500).json({ success: false, message: `Tatizo la mfumo: ${error.message}` });
    }
});

// --- Route to Handle ClickPesa Webhook Notifications (Concept remains) ---
app.post('/api/clickpesa-webhook', express.json(), async (req, res) => {
    // <<< IMPLEMENT WEBHOOK VERIFICATION BASED ON CLICKPESA DOCS >>>
    // const isValid = verifyClickPesaSignature(req.headers['x-clickpesa-signature'], req.body);
    // if (!isValid) { return res.status(403).send('Invalid Signature'); }

    console.log("Received ClickPesa Webhook:", JSON.stringify(req.body, null, 2));
    const notification = req.body;
    const orderReference = notification?.orderReference; // Use the field from ClickPesa docs
    const transactionStatus = notification?.status; // e.g., SUCCESS, FAILED
    const clickpesaTxnId = notification?.id; // ClickPesa's transaction ID

    if (orderReference && transactionStatus && clickpesaTxnId) {
        try {
            await logSessionEvent({
                session_id: 'webhook-' + (orderReference.split('-')[1] || 'unknown'), // Infer session part? Needs better linking.
                request_id: orderReference,
                event_type: `donation_${transactionStatus.toLowerCase()}`, // donation_success, donation_failed
                merchant_ref: orderReference,
                clickpesa_txn_id: clickpesaTxnId,
                donation_amount: notification?.collectedAmount ? parseFloat(notification.collectedAmount) : null,
                // phone_number_hash: notification?.phoneNumber ? require('crypto').createHash('sha256').update(notification.phoneNumber).digest('hex') : null, // Hash PII
                webhook_payload: JSON.stringify(notification).substring(0, 1000)
            });
            console.log(`Webhook for OrderRef: ${orderReference} logged. Status: ${transactionStatus}`);
        } catch (logError) {
            console.error(`Failed to log webhook event for OrderRef: ${orderReference}`, logError);
        }
    } else {
        console.warn("Received incomplete webhook data.");
    }

    res.status(200).send('OK'); // Acknowledge receipt
});













// --- API Route to get history (remains the same) ---
app.get('/api/history', (req, res) => {
    const userId = req.gemmaSession?.userId;
    const sessionId = req.gemmaSession?.id;
    if (!userId) {
        console.warn(`Attempt to access /api/history without X-User-ID header (Session: ${sessionId})`);
        return res.json({ chatHistory: [] });
    }
    console.log(`[Session: ${sessionId}, User: ${userId}] GET /api/history request`);
    res.json({ chatHistory: req.gemmaSession.chatHistory || [] });
});

// --- Start the Server (remains the same) ---
app.listen(PORT, () => {
    console.log(`Server listening on port ${PORT}`);
    console.log(`Access the UI at http://localhost:${PORT}`);
});

export default app; // Assuming you might use this for testing