// clickpesa-client.js
import axios from 'axios';

const CLICKPESA_BASE_URL = 'https://api.clickpesa.com/third-parties'; // Use the base URL

/**
 * Generates a short-lived JWT Authorization token from ClickPesa.
 * @param {string} clientId - Your ClickPesa Client ID.
 * @param {string} apiKey - Your ClickPesa API Key.
 * @returns {Promise<string>} The Bearer token string (e.g., "Bearer xxx...")
 * @throws {Error} If token generation fails.
 */
export async function getClickPesaAuthToken(clientId, apiKey) {
    if (!clientId || !apiKey) {
        throw new Error('ClickPesa Client ID and API Key are required.');
    }
    const url = `${CLICKPESA_BASE_URL}/generate-token`;
    try {
        const response = await axios.post(url, null, { // No body needed for token generation
            headers: {
                'api-key': apiKey,
                'client-id': clientId,
                //'Content-Type': 'application/json' // Still good practice
            },
            timeout: 10000 // 10 seconds timeout
        });

        if (response.data && response.data.success && response.data.token) {
            // Ensure the token includes "Bearer " if the API expects it directly
            // The example shows "Bearer token" in the response, let's assume it needs adding
            // return response.data.token.startsWith('Bearer ') ? response.data.token : `Bearer ${response.data.token}`;
            // Update: Docs show response is just "Bearer token", so likely includes it. Let's just return it.
             if (!response.data.token.includes('Bearer')) {
                  console.warn("ClickPesa token response did not include 'Bearer ' prefix. Adding it.");
                  return `Bearer ${response.data.token}`;
             }
             return response.data.token;

        } else {
            throw new Error('Failed to retrieve valid token from ClickPesa response.');
        }
    } catch (error) {
        console.error('Error generating ClickPesa auth token:', error.response?.data || error.message);
        console.log(error,"error")
        throw new Error(`ClickPesa auth token generation failed: ${error.response?.data?.message || error.message}`);
    }
}

/**
 * Initiates a USSD Push request via ClickPesa.
 * @param {string} authToken - The full Bearer token obtained from getClickPesaAuthToken.
 * @param {object} payload - The request body payload.
 * @param {string} payload.amount - Amount as a string.
 * @param {string} payload.currency - e.g., "TZS".
 * @param {string} payload.orderReference - Your unique reference.
 * @param {string} payload.phoneNumber - User's phone number.
 * @returns {Promise<object>} The response data from ClickPesa.
 * @throws {Error} If the API call fails.
 */
export async function initiateClickPesaUssdPush(authToken, payload) {
    if (!authToken) {
        throw new Error('ClickPesa Auth Token is required.');
    }
     // Verify URL: Docs page title implies /payments/initiate-ussd-push-request
     // but CURL example showed /third-parties/... Let's use the one from the page title.
     // **USER SHOULD CONFIRM THE CORRECT ENDPOINT WITH CLICKPESA**
    const url = `${CLICKPESA_BASE_URL}/payments/initiate-ussd-push-request`;

    try {
        const response = await axios.post(url, payload, {
            headers: {
                'Authorization': authToken, // Assumes token includes "Bearer "
                'Content-Type': 'application/json'
            },
            timeout: 20000 // 20 seconds timeout for initiation
        });

        // ClickPesa docs show 200 is success, but payload structure varies.
        // Let's return the whole data object for the route handler to process.
        console.log('ClickPesa USSD Push response:', response?.data||response);
        
        return response.data;

    } catch (error) {
        console.error('Error initiating ClickPesa USSD Push:', error.response?.data || error.message);
         // Try to extract a meaningful error message from ClickPesa response
         const errorMessage = error.response?.data?.message || error.response?.data?.error || error.message;
        throw new Error(`ClickPesa USSD Push failed: ${errorMessage}`);
    }
}





// --- NEW: Function to Query Payment Status ---
/**
 * Queries the status of a specific payment using its Order Reference.
 * @param {string} authToken - The full Bearer token.
 * @param {string} orderReference - The unique order reference of the payment to query.
 * @returns {Promise<object|null>} The payment status object from ClickPesa (first element of array), or null if not found (404).
 * @throws {Error} If the API call fails for reasons other than 404.
 */
export async function queryClickPesaPaymentStatus(authToken, orderReference) {
    if (!authToken || !orderReference) {
        throw new Error('ClickPesa Auth Token and Order Reference are required for status query.');
    }
    // ** VERIFY THIS ENDPOINT WITH CLICKPESA ** (especially if it needs /third-parties/ prefix)
    const url = `${CLICKPESA_BASE_URL}/payments/${encodeURIComponent(orderReference)}`;

    try {
        const response = await axios.get(url, {
            headers: {
                'Authorization': authToken // Assumes token includes "Bearer "
            },
            timeout: 10000 // 10 seconds timeout for status check
        });

        // Docs show response is an array, usually with one item for a specific orderRef query
        if (response.data && Array.isArray(response.data) && response.data.length > 0) {
            return response.data[0]; // Return the first (and likely only) payment object
        } else {
            // Could happen if the reference is valid but has no status yet? Treat as pending/processing.
            console.warn(`ClickPesa status query for ${orderReference} returned empty array or unexpected data.`);
            return { status: 'PENDING' }; // Or 'PROCESSING', decide how to handle
        }

    } catch (error) {
        if (axios.isAxiosError(error) && error.response?.status === 404) {
            // Payment not found - might not have been processed by provider yet, or bad ref
            console.log(`ClickPesa status query for ${orderReference} returned 404 (Not Found).`);
            return null; // Indicate not found
        } else {
            console.error(`Error querying ClickPesa payment status for ${orderReference}:`, error.response?.data || error.message);
            const errorMessage = error.response?.data?.message || error.response?.data?.error || error.message;
            throw new Error(`ClickPesa status query failed: ${errorMessage}`);
        }
    }
}