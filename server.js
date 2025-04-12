// server.js
import express from 'express';
import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';

// Import our Gemma client functions
import { fetchIdentityToken, callGemmaService } from './gemma-client.js';

dotenv.config();
const app = express();
const PORT = process.env.PORT || 8080;
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));

// --- Middleware --- <<< ADD THESE LINES >>>
// Middleware to parse URL-encoded bodies (as sent by HTML forms)
app.use(express.urlencoded({ extended: true }));
// Middleware to parse JSON bodies (useful if you build an API later)
app.use(express.json());

// --- Routes ---

// Homepage route (renders the form)
app.get('/', (req, res) => {
  res.render('index', { result: null, error: null });
});

// Route to handle form submission <<< ADD THIS ROUTE >>>
app.post('/generate', async (req, res) => {
  // 1. Get prompt from form submission
  const userPrompt = req.body.prompt;
  let resultText = null;
  let errorMsg = null;

  // Basic validation
  if (!userPrompt || userPrompt.trim() === '') {
    errorMsg = 'Please enter a prompt.';
    return res.render('index', { result: null, error: errorMsg });
  }

  // 2. Get target service URL and model name from environment
  const targetAudience = process.env.CLOUD_RUN_GEMMA_URL;
  const modelName = process.env.OLLAMA_MODEL || 'gemma3:4b'; // Default if not set

  if (!targetAudience) {
      errorMsg = 'Server configuration error: Target Gemma service URL is not set.';
      console.error(errorMsg);
      return res.render('index', { result: null, error: errorMsg });
  }


  try {
    console.log(`Received prompt, fetching token for ${targetAudience}...`);
    // 3. Fetch authentication token
    const token = await fetchIdentityToken(targetAudience);

    console.log(`Token fetched, calling Gemma service with model ${modelName}...`);
    // 4. Call the Gemma service
    const gemmaResponse = await callGemmaService(
      targetAudience,
      token,
      userPrompt,
      modelName,
      60000 // Timeout 60 seconds (adjust if needed)
    );

    console.log('Gemma service call successful.');
    // 5. Extract the response text (handle potential missing field)
    resultText = gemmaResponse?.response ?? 'Model returned a response, but no text field was found.';

  } catch (error) {
    console.error('Error during Gemma call:', error);
    errorMsg = `Failed to get response: ${error.message}`;
  }

  // 6. Render the page again with the result or error
  res.render('index', { result: resultText, error: errorMsg });
});


// --- Start the Server ---
app.listen(PORT, () => {
  console.log(`Server listening on port ${PORT}`);
  console.log(`Access the UI at http://localhost:${PORT}`);
});

export default app;