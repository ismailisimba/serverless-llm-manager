// gemma-client.js
import { GoogleAuth } from 'google-auth-library';
import axios, { AxiosError } from 'axios';

// --- fetchIdentityToken remains the same ---
export async function fetchIdentityToken(targetAudience) {
    if (!targetAudience) {
        throw new Error(
            'Target Audience (Cloud Run service URL) is required for fetchIdentityToken.'
        );
    }
    try {
        const auth = new GoogleAuth();
        const client = await auth.getIdTokenClient(targetAudience);
        const headers = await client.getRequestHeaders(targetAudience);
        if (!headers || !headers.Authorization) {
            throw new Error('Failed to obtain Authorization header.');
        }
        const token = headers.Authorization.split(' ')[1];
        if (!token) {
            throw new Error('Obtained Authorization header, but token part was missing.');
        }
        return token;
    } catch (error) {
        console.error('Error fetching Identity Token:', error.message);
        throw new Error(`Failed to fetch Identity Token: ${error.message}`);
    }
}

/**
 * Helper function to transform chat history into Ollama's message format.
 * @param {Array<object>} chatHistory - Array of { prompt, response?, error? }
 * @param {string} currentPrompt - The latest user prompt.
 * @param {string[]|null} currentImages - Base64 images for the current prompt.
 * @returns {Array<object>} Array of { role: 'user'|'assistant', content: string, images?: string[] }
 */
function transformHistoryToMessages(chatHistory = [], currentPrompt, currentImages = null) {
    const messages = [];
    for (const entry of chatHistory) {
        // Add previous user prompt
        if (entry.prompt) {
            messages.push({ role: 'user', content: entry.prompt });
        }
        // Add previous assistant response (only if no error occurred for that entry)
        if (entry.response && !entry.error) {
            messages.push({ role: 'assistant', content: entry.response });
        }
        // Skip entries that resulted in an error for context
    }

    // Add the current user prompt
    const currentUserMessage = { role: 'user', content: currentPrompt };
    if (currentImages && Array.isArray(currentImages) && currentImages.length > 0) {
        currentUserMessage.images = currentImages; // Add images to the last message
    }
    messages.push(currentUserMessage);

    return messages;
}


/**
 * Calls the deployed Gemma/Ollama Cloud Run service's CHAT endpoint.
 * @param {string} serviceUrl The base URL of the Cloud Run service.
 * @param {string} bearerToken The OIDC Identity Token (without "Bearer ").
 * @param {string} prompt The *current* text prompt.
 * @param {string} modelName The name/tag of the Ollama model.
 * @param {Array<object>} [chatHistory=[]] Optional: The conversation history.
 * @param {number} [timeout=60000] Optional: Request timeout.
 * @returns {Promise<object>} A Promise resolving with the Ollama API response (contains `message` object).
 * @throws {Error} If the API call fails.
 */
export async function callGemmaChatService( // Renamed for clarity
    serviceUrl,
    bearerToken,
    prompt,
    modelName,
    chatHistory = [], // <<< ADD chatHistory parameter
    timeout = 60000
) {
    if (!serviceUrl || !bearerToken || !prompt || !modelName) {
        throw new Error(
            'Service URL, Token, Prompt, and Model Name are required.'
        );
    }

    const apiUrl = `${serviceUrl.replace(/\/$/, '')}/api/chat`; // <<< CHANGE Endpoint
    console.log(`Calling Gemma CHAT service: ${apiUrl} with model: ${modelName}`);

    // <<< TRANSFORM HISTORY and create messages payload >>>
    const messages = transformHistoryToMessages(chatHistory, prompt);

    const requestData = {
        model: modelName,
        messages: messages, // <<< Use messages array
        stream: false,
    };

    const config = {
        method: 'post', url: apiUrl,
        headers: {
            Authorization: `Bearer ${bearerToken}`,
            'Content-Type': 'application/json',
        },
        data: requestData,
        timeout: timeout,
    };

    try {
        const response = await axios(config);
        if (response.status >= 200 && response.status < 300) {
            // console.log('Successful response from Gemma CHAT service.');
            // The response structure for /api/chat (non-stream) includes the assistant's message
            // e.g., { model: '...', created_at: '...', message: { role: 'assistant', content: '...' }, done: true, ...stats }
            return response.data; // <<< Return the full response object
        } else {
            throw new Error(`Request failed with status code: ${response.status}`);
        }
    } catch (error) {
        // Error handling remains similar
        console.error('Error calling Gemma CHAT service:', error.message);
        if (axios.isAxiosError(error)) {
            const axiosError = error;
            let detail = axiosError.message;
            if (axiosError.response) {
                detail = `Status ${axiosError.response.status}: ${JSON.stringify(
                    axiosError.response.data
                )}`;
            } else if (axiosError.request) {
                detail = 'No response received from service.';
            }
            throw new Error(`Gemma CHAT service call failed: ${detail}`);
        }
        throw error;
    }
}


/**
 * Initiates a STREAMING request to the Gemma/Ollama Cloud Run service CHAT endpoint.
 * @param {string} serviceUrl
 * @param {string} bearerToken
 * @param {string} prompt The *current* text prompt.
 * @param {string} modelName
 * @param {Array<object>} [chatHistory=[]] Optional: The conversation history.
 * @param {string[]} [images] Optional array of base64 encoded image strings for the *current* prompt.
 * @param {number} [timeout=600000]
 * @returns {Promise<import('axios').AxiosResponse<NodeJS.ReadableStream>>}
 * @throws {Error}
 */
export async function callGemmaChatServiceStream( // Renamed for clarity
    serviceUrl,
    bearerToken,
    prompt,
    modelName,
    chatHistory = [], // <<< ADD chatHistory parameter
    images = null,
    timeout = 600000
) {
    if (!serviceUrl || !bearerToken || !prompt || !modelName) {
        throw new Error(
            'Service URL, Token, Prompt, and Model Name are required.'
        );
    }

    const apiUrl = `${serviceUrl.replace(/\/$/, '')}/api/chat`; // <<< CHANGE Endpoint
    const isMultimodal = images && Array.isArray(images) && images.length > 0;
    console.log(`Calling Gemma CHAT stream: ${apiUrl} | Model: ${modelName} | Multimodal: ${isMultimodal}`);

    // <<< TRANSFORM HISTORY and create messages payload >>>
    // Pass current prompt's images to the transformer
    const messages = transformHistoryToMessages(chatHistory, prompt, images);

    const requestData = {
        model: modelName,
        messages: messages, // <<< Use messages array
        stream: true,
    };
    // Note: The 'images' array is now inside the last message object, not at the top level.

    const config = {
        method: 'post', url: apiUrl,
        headers: {
            Authorization: `Bearer ${bearerToken}`,
            'Content-Type': 'application/json',
            Accept: 'application/x-ndjson',
        },
        data: requestData,
        responseType: 'stream',
        timeout: timeout,
    };

    try {
        const response = await axios(config);
        if (response.status >= 400) {
            // Attempt to read error details from stream if possible (might be tricky)
             const errorBody = await response.data.read()?.toString();
             console.error(`[Gemma Client Stream Error] Status ${response.status}: ${errorBody}`);
            throw new Error(`Request failed with status code: ${response.status}. Body: ${errorBody || '(empty)'}`);
        }
        return response;
    } catch (error) {
        // Error handling remains similar
        console.error('Error initiating Gemma CHAT stream request:', error.message);
        if (axios.isAxiosError(error) && error.response) {
             // If we got an error response object from axios (e.g., 4xx, 5xx before stream starts)
             const errorDetail = JSON.stringify(error.response.data) || error.message;
             throw new Error(`Gemma CHAT stream initiation failed: Status ${error.response.status} - ${errorDetail}`);
        } else if (axios.isAxiosError(error)) {
              throw new Error(`Gemma CHAT stream initiation failed: ${error.message}`);
        }
        throw error;
    }
}

// --- Deprecated callGemmaService and callGemmaServiceStream ---
// You can optionally remove the old functions or leave them commented out/renamed
// export async function callGemmaService(...) { /* ... old code ... */ }
// export async function callGemmaServiceStream(...) { /* ... old code ... */ }