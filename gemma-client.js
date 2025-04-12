// gemma-client.js
import { GoogleAuth } from 'google-auth-library';
import axios, { AxiosError } from 'axios';

/**
 * Fetches an OIDC Identity Token for authenticating with a secure Google Cloud service.
 * Uses Application Default Credentials (ADC).
 * @param {string} targetAudience The URL of the target Cloud Run service.
 * @returns {Promise<string>} A Promise that resolves with the fetched Identity Token (without "Bearer ").
 * @throws {Error} If fetching the token fails.
 */
export async function fetchIdentityToken(targetAudience) {
  if (!targetAudience) {
    throw new Error(
      'Target Audience (Cloud Run service URL) is required for fetchIdentityToken.'
    );
  }
  // console.log(`Workspaceing Identity Token for audience: ${targetAudience}`); // Optional: uncomment for debugging
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
    // console.log('Successfully fetched Identity Token.'); // Optional: uncomment for debugging
    return token;
  } catch (error) {
    console.error('Error fetching Identity Token:', error.message);
    throw new Error(`Failed to fetch Identity Token: ${error.message}`);
  }
}

/**
 * Calls the deployed Gemma/Ollama Cloud Run service to generate text.
 * @param {string} serviceUrl The base URL of the Cloud Run service.
 * @param {string} bearerToken The OIDC Identity Token (without "Bearer ").
 * @param {string} prompt The text prompt to send to the model.
 * @param {string} modelName The name/tag of the Ollama model to use (e.g., 'gemma3:4b').
 * @param {number} [timeout=60000] Optional: Request timeout in milliseconds.
 * @returns {Promise<object>} A Promise that resolves with the full response data object from the Ollama API.
 * @throws {Error} If the API call fails.
 */
export async function callGemmaService(
  serviceUrl,
  bearerToken,
  prompt,
  modelName,
  timeout = 60000
) {
  // Basic validation
  if (!serviceUrl || !bearerToken || !prompt || !modelName) {
    throw new Error(
      'Service URL, Bearer Token, Prompt, and Model Name are required for callGemmaService.'
    );
  }

  const apiUrl = `${serviceUrl.replace(/\/$/, '')}/api/generate`;
  // console.log(`Calling Gemma service: ${apiUrl} with model: ${modelName}`); // Optional: uncomment for debugging

  const requestData = {
    model: modelName,
    prompt: prompt,
    stream: false,
  };

  const config = {
    method: 'post',
    url: apiUrl,
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
      // console.log('Received successful response from Gemma service.'); // Optional: uncomment for debugging
      return response.data;
    } else {
      // Should be caught by axios, but included for completeness
      throw new Error(`Request failed with status code: ${response.status}`);
    }
  } catch (error) {
    console.error('Error calling Gemma service:', error.message);
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
      throw new Error(`Gemma service call failed: ${detail}`);
    }
    // Rethrow other errors
    throw error;
  }
}

// Note: We are not including the multimodal function here for simplicity,
// but it could be added to this file later if needed.


/**
 * Initiates a STREAMING request to the Gemma/Ollama Cloud Run service.
 * Handles both text-only and multimodal requests.
 * Returns the Axios response stream object for processing.
 * @param {string} serviceUrl
 * @param {string} bearerToken
 * @param {string} prompt
 * @param {string} modelName
 * @param {string[]} [images] Optional array of base64 encoded image strings.
 * @param {number} [timeout=600000]
 * @returns {Promise<import('axios').AxiosResponse<NodeJS.ReadableStream>>}
 * @throws {Error}
 */
export async function callGemmaServiceStream(
    serviceUrl,
    bearerToken,
    prompt,
    modelName,
    images = null, // <<< ADD optional images parameter
    timeout = 600000
  ) {
    if (!serviceUrl || !bearerToken || !prompt || !modelName) {
      throw new Error(
        'Service URL, Bearer Token, Prompt, and Model Name are required for callGemmaServiceStream.'
      );
    }
  
    const apiUrl = `${serviceUrl.replace(/\/$/, '')}/api/generate`;
    const isMultimodal = images && Array.isArray(images) && images.length > 0;
    // console.log(`Calling Gemma stream: ${apiUrl} | Model: ${modelName} | Multimodal: ${isMultimodal}`); // Debug
  
    // --- Construct Payload --- <<< MODIFIED >>>
    const requestData = {
      model: modelName,
      prompt: prompt,
      stream: true,
    };
    if (isMultimodal) {
      requestData.images = images; // Add images array if present
    }
    // --- End modification ---
  
    const config = {
      method: 'post',
      url: apiUrl,
      headers: {
        Authorization: `Bearer ${bearerToken}`,
        'Content-Type': 'application/json', // Ollama API still expects JSON body
        Accept: 'application/x-ndjson',
      },
      data: requestData, // Send the potentially multimodal payload
      responseType: 'stream',
      timeout: timeout,
    };
  
    try {
      const response = await axios(config);
       if (response.status >= 400) {
            throw new Error(`Request failed with status code: ${response.status}`);
       }
      return response;
    } catch (error) {
      console.error('Error initiating Gemma stream request:', error.message);
       if (axios.isAxiosError(error)) {
         throw new Error(`Gemma stream initiation failed: ${error.message}`);
       }
      throw error;
    }
  }