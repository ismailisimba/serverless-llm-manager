// public/js/main.js
console.log('Main JS loaded V2 - Streaming Ready');



// Add near the top of your main.js or inside DOMContentLoaded

const menuToggleButton = document.getElementById('menu-toggle');
const menuContent = document.getElementById('app-menu-content');

if (menuToggleButton && menuContent) {
    menuToggleButton.addEventListener('click', () => {
        const isExpanded = menuToggleButton.getAttribute('aria-expanded') === 'true';
        menuContent.classList.toggle('menu-open');
        menuToggleButton.setAttribute('aria-expanded', !isExpanded);
    });

    // Optional: Close menu if clicking outside
    document.addEventListener('click', (event) => {
        const isClickInsideMenu = menuContent.contains(event.target);
        const isClickOnToggleButton = menuToggleButton.contains(event.target);

        if (!isClickInsideMenu && !isClickOnToggleButton && menuContent.classList.contains('menu-open')) {
            menuContent.classList.remove('menu-open');
            menuToggleButton.setAttribute('aria-expanded', 'false');
        }
    });
}



// --- DOM Elements ---
const themeToggleButton = document.getElementById('theme-toggle');
const bodyElement = document.body;
const promptForm = document.getElementById('prompt-form');
const promptTextarea = document.getElementById('prompt');
const submitButton = document.getElementById('submit-button');
const chatOutput = document.getElementById('chat-output');
const currentResponsePlaceholder = document.getElementById(
  'current-response-placeholder'
);
const streamingContent = document.getElementById('streaming-content');
const loadingIndicator = document.getElementById('loading-indicator'); // Text indicator
const cssLoader = document.getElementById('css-loader'); // CSS spinner
const jsErrorBox = document.getElementById('js-error-box');
const noHistoryMsg = document.getElementById('no-history-msg');


// --- Persistent User ID --- <<< NEW SECTION >>>
let userId = null; // Variable to hold the user ID

function initializeUserId() {
    const storageKey = 'gemma-user-id';
    let storedId = localStorage.getItem(storageKey);

    if (!storedId) {
        // Generate a new UUID if one doesn't exist
        // crypto.randomUUID() is available in modern secure contexts (HTTPS/localhost)
        if (window.crypto && window.crypto.randomUUID) {
            storedId = crypto.randomUUID();
            localStorage.setItem(storageKey, storedId);
            console.log('Generated and saved new User ID:', storedId);
        } else {
            // Fallback for older/insecure contexts (less ideal)
            storedId = 'user-' + Date.now() + '-' + Math.random().toString(36).substring(2, 15);
            console.warn('crypto.randomUUID not available, using fallback ID:', storedId);
            // Note: localStorage might not be available in all contexts either (e.g., private Browse sometimes)
             try {
                  localStorage.setItem(storageKey, storedId);
             } catch (e) {
                   console.error("LocalStorage not available or write failed. User ID won't persist.", e);
                   // Keep generated ID just for this session
             }
        }
    } else {
        console.log('Retrieved existing User ID:', storedId);
    }
    userId = storedId; // Assign to the global variable
}
// --- End User ID Section --

// --- Theme Toggle Functionality ---
const applyTheme = () => {
  const savedTheme = localStorage.getItem('theme') || 'light';
  if (savedTheme === 'dark') {
    bodyElement.classList.add('dark-theme');
  } else {
    bodyElement.classList.remove('dark-theme');
  }
};
themeToggleButton.addEventListener('click', () => {
  bodyElement.classList.toggle('dark-theme');
  const newTheme = bodyElement.classList.contains('dark-theme') ? 'dark' : 'light';
  localStorage.setItem('theme', newTheme);
});

// --- Initialize User ID and Theme on Load --- <<< MODIFIED >>>
document.addEventListener('DOMContentLoaded', () => {
    initializeUserId(); // <<< CALL User ID initialization
    applyTheme();
    loadInitialHistory()
});

// --- Helper Functions ---

function appendChatEntry(promptText, responseHtml, isError = false, isInitialLoad = false) {
    if (noHistoryMsg) {
        noHistoryMsg.remove();
    }
    const entryDiv = document.createElement('div');
    entryDiv.className = 'history-entry';

    const promptDiv = document.createElement('div');
    promptDiv.className = 'history-prompt';
    promptDiv.innerHTML = `<strong>You:</strong><pre>${escapeHtml(promptText)}</pre>`;

    const responseDiv = document.createElement('div');
    responseDiv.className = isError ? 'history-error error-box' : 'history-response result-box';
    responseDiv.style.marginTop = '10px';
    // Ensure inner div exists even if responseHtml is just a loader/placeholder initially
    responseDiv.innerHTML = `<strong>${isError ? 'Error' : 'Gemma'}:</strong><div>${responseHtml}</div>`;

    entryDiv.appendChild(promptDiv);
    entryDiv.appendChild(responseDiv);
    chatOutput.appendChild(entryDiv);

    // Scroll to bottom only for new entries, not initial load
    if (!isInitialLoad) {
        // Scroll chat output to the bottom
        chatOutput.scrollTop = chatOutput.scrollHeight;
        // Also scroll the main window if the new entry is near the bottom
         entryDiv.scrollIntoView({ behavior: 'smooth', block: 'end' });
    }
}

// --- NEW: Function to load initial chat history ---
async function loadInitialHistory() {
    if (!userId) {
        console.error("Cannot load history: User ID not available.");
        // Display message if loading fails and no history exists
        if (noHistoryMsg) noHistoryMsg.textContent = "Could not load history: User ID missing.";
        return;
    }
    console.log("Loading initial history for user:", userId);

    try {
        const response = await fetch('/api/history', {
            method: 'GET',
            headers: {
                'X-User-ID': userId
            }
        });

        if (!response.ok) {
            throw new Error(`Failed to fetch history: Server status ${response.status}`);
        }

        const data = await response.json();
        const history = data.chatHistory || [];

        console.log(`Received ${history.length} history entries.`);

        // Clear the initial "Loading..." message
        if (noHistoryMsg) noHistoryMsg.remove();

        if (history.length > 0) {
            history.forEach(entry => {
                let content = '';
                let isError = false;
                if (entry.response) {
                    // Render markdown from saved history
                    content = marked.parse(entry.response);
                } else if (entry.error) {
                    content = `<pre>${escapeHtml(entry.error)}</pre>`; // Display error preformatted
                    isError = true;
                }
                appendChatEntry(entry.prompt, content, isError, true); // Pass true for isInitialLoad
            });
             // Scroll to bottom after initial load if there's history
             chatOutput.scrollTop = chatOutput.scrollHeight;
        } else {
            // Re-add the "No history" message if needed (or create it)
             if (!document.getElementById('no-history-msg')) { // Avoid duplicates
                  const noHistory = document.createElement('p');
                  noHistory.id = 'no-history-msg';
                  noHistory.textContent = 'No chat history yet for this session.';
                  // Find where to insert it - after the H2?
                  const historyH2 = chatOutput.querySelector('h2');
                  if (historyH2) {
                        historyH2.insertAdjacentElement('afterend', noHistory);
                  } else {
                        chatOutput.appendChild(noHistory); // Fallback
                  }
             } else {
                  document.getElementById('no-history-msg').textContent = 'No chat history yet for this session.';
             }
        }

    } catch (error) {
        console.error("Error loading initial history:", error);
        showJsError(`Failed to load chat history: ${error.message}`);
        if (noHistoryMsg) noHistoryMsg.textContent = "Error loading history.";
    }
}

/**
 * Displays an error message in the dedicated JS error box.
 * @param {string} message The error message to display.
 */
function showJsError(message) {
    console.error("Frontend Error:", message);
    jsErrorBox.textContent = message;
    jsErrorBox.style.display = 'block';
    cssLoader.style.display = 'none'; // Hide CSS loader on JS error
    loadingIndicator.style.display = 'none'; // Hide text loader on JS error
    // Ensure the streaming area is also hidden on error
    if (currentResponsePlaceholder) currentResponsePlaceholder.style.display = 'none';
}

/**
 * Basic HTML escaping
 * @param {string} unsafe Potentially unsafe string
 * @returns {string} Escaped string
 */
function escapeHtml(unsafe) {
    if (!unsafe) return '';
    return unsafe
         .replace(/&/g, "&amp;")
         .replace(/</g, "&lt;")
         .replace(/>/g, "&gt;")
         .replace(/"/g, "&quot;")
         .replace(/'/g, "&#039;");
}

// --- Form Submission & Streaming Logic ---
promptForm.addEventListener('submit', async (event) => {
    event.preventDefault();

    // Ensure userId is initialized (should be by DOMContentLoaded, but double-check)
  if (!userId) {
      console.error("User ID not initialized!");
      showJsError("User ID could not be determined. Please reload.");
      return;
  }


    const formData = new FormData(promptForm);
    const userPrompt = formData.get('prompt')?.toString().trim(); // Get prompt from FormData

    if (!userPrompt) {
      showJsError("Please enter a prompt.");
      return;
    }

    // Check how many files were selected (optional feedback)
    const imageFiles = formData.getAll('images').filter(file => file.size > 0); // Filter out empty file inputs
    console.log(`Form submitted. Prompt: "${userPrompt}", Files: ${imageFiles.length}`);


    // --- UI Updates ---
    submitButton.disabled = true;
  promptForm.reset(); // Clear form including file input
    jsErrorBox.style.display = 'none';
    currentResponsePlaceholder.style.display = 'block'; // Show placeholder area
    streamingContent.innerHTML = ''; // Clear previous stream content
    cssLoader.style.display = 'block'; // <<< SHOW CSS Loader >>>
    loadingIndicator.style.display = 'none'; // <<< HIDE Text Loader >>>

     // Immediately add user prompt to history (indicate if images were sent)
  const promptDisplay = imageFiles.length > 0
  ? `${userPrompt} (+ ${imageFiles.length} image${imageFiles.length > 1 ? 's' : ''})`
  : userPrompt;
  // Add a placeholder for the response with a loader inside
  appendChatEntry(promptDisplay, '<div class="loader" style="margin: 5px 0;"></div>', false);
  const historyEntries = chatOutput.querySelectorAll('.history-entry');
  const latestEntryResponseDiv = historyEntries[historyEntries.length - 1]?.querySelector('.history-response div');




    // --- Fetch and Process Stream ---
    let accumulatedResponse = '';
    let isStreamStarted = false; // Flag to track if first chunk received

    try {
        const response = await fetch('/generate-stream', {
            method: 'POST',
            headers: {
              // DO NOT set Content-Type, browser sets it for FormData
              'X-User-ID': userId // <<< ADD User ID Header >>>
            },
            body: formData,
          });

        if (!response.ok) {
           const errorText = await response.text();
           // If the latest history entry exists, update it with the server error
           if (latestEntryResponseDiv) {
               const parentEntry = latestEntryResponseDiv.closest('.history-entry');
               parentEntry.innerHTML = `
                   <div class="history-prompt"><strong>You:</strong><pre>${escapeHtml(promptDisplay)}</pre></div>
                   <div class="history-error error-box" style="margin-top: 10px;"><strong>Error:</strong><pre>${escapeHtml(`Server error ${response.status}: ${errorText || 'Unknown error'}`)}</pre></div>
               `;
           } else { // Fallback if history entry wasn't added correctly
               showJsError(`Server error ${response.status}: ${errorText || 'Unknown error'}`);
           }
           throw new Error(`Server error ${response.status}: ${errorText || 'Unknown error'}`); // Still throw to stop processing
        }
        if (!response.body) throw new Error('Response body is null.');

        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let buffer = '';
        let finalDoneData = null; // Store the data from the 'done' event

        while (true) {
            const { value, done } = await reader.read();
            if (done) {
                console.log('Stream finished.');
                if (!isStreamStarted && !finalDoneData) { // If stream ends before *any* data/event useful received
                    cssLoader.style.display = 'none'; // Hide loader
                    showJsError("Stream ended unexpectedly without receiving any data.");
                    if (latestEntryResponseDiv) {
                       latestEntryResponseDiv.innerHTML = `<span class="error-text">[Empty Response]</span>`;
                    }
                } else if (finalDoneData) { // Process the 'done' event data received just before stream ended
                    console.log('Processing final done event data:', finalDoneData);
                    accumulatedResponse = finalDoneData.fullResponse || accumulatedResponse;
                    const renderedHtml = marked.parse(accumulatedResponse);
                     if (latestEntryResponseDiv) {
                         latestEntryResponseDiv.innerHTML = renderedHtml; // Update final history item
                         latestEntryResponseDiv.closest('.history-entry')?.scrollIntoView({ behavior: 'smooth', block: 'end' });
                     } else {
                          // This case shouldn't happen if placeholder was added, but as fallback:
                         appendChatEntry(promptDisplay, renderedHtml, false);
                     }
                } else if (accumulatedResponse && latestEntryResponseDiv) {
                     // If stream ended without a 'done' event but we got some data
                     console.warn("Stream ended without a 'done' event. Rendering accumulated content.");
                     const renderedHtml = marked.parse(accumulatedResponse);
                     latestEntryResponseDiv.innerHTML = renderedHtml;
                }
                // Final cleanup regardless of how the stream ended
                cssLoader.style.display = 'none'; // Ensure loader is hidden
                streamingContent.innerHTML = ''; // Clear streaming area
                currentResponsePlaceholder.style.display = 'none'; // Hide placeholder
                await reader.cancel().catch(e => console.warn("Error cancelling reader:", e)); // Cancel and ignore potential error
                break; // Exit processing loop
            }


            // --- Hide loader on first received chunk --- <<< ADD LOGIC >>>
            if (!isStreamStarted) {
                isStreamStarted = true;
                cssLoader.style.display = 'none'; // Hide CSS loader now
                // Instead of separate streamingContent, update the history entry directly
                if (latestEntryResponseDiv) {
                    latestEntryResponseDiv.innerHTML = '<pre></pre>'; // Replace loader with pre tag for streaming
                }
                 currentResponsePlaceholder.style.display = 'none'; // Hide the main placeholder wrapper
            }
            // --- End hide loader logic ---


            buffer += decoder.decode(value, { stream: true });
            let boundaryIndex;

            while ((boundaryIndex = buffer.indexOf('\n\n')) >= 0) {
                const message = buffer.substring(0, boundaryIndex);
                buffer = buffer.substring(boundaryIndex + 2);

                let event = 'message';
                let data = '';
                message.split('\n').forEach(line => {
                     if (line.startsWith('event:')) event = line.substring(6).trim();
                     else if (line.startsWith('data:')) data = line.substring(5).trim();
                });

                if (event === 'message' || event === 'data') {
                    try {
                        const parsedData = JSON.parse(data);
                        if (parsedData.text) {
                            accumulatedResponse += parsedData.text;
                            // Append text chunk to the PRE tag within the latest history entry
                            if (latestEntryResponseDiv) {
                                const preElement = latestEntryResponseDiv.querySelector('pre');
                                if (preElement) {
                                    preElement.textContent += parsedData.text;
                                     // Scroll the chat output down as content streams in
                                    chatOutput.scrollTop = chatOutput.scrollHeight;
                                }
                            }
                        }
                    } catch (e) { console.error('Error parsing SSE data JSON:', e, 'Data:', data); }
                } else if (event === 'error') {
                    try {
                        const errorData = JSON.parse(data);
                        console.error('Received error event from server:', errorData.message);
                        showJsError(`Server error: ${errorData.message}`); // Show error in dedicated box
                        // Update history entry to show the error permanently
                         if (latestEntryResponseDiv) {
                             const parentEntry = latestEntryResponseDiv.closest('.history-entry');
                              parentEntry.innerHTML = `
                                  <div class="history-prompt"><strong>You:</strong><pre>${escapeHtml(promptDisplay)}</pre></div>
                                  <div class="history-error error-box" style="margin-top: 10px;"><strong>Error:</strong><pre>${escapeHtml(errorData.message)}</pre></div>
                              `;
                         }
                        cssLoader.style.display = 'none'; // Ensure loader is hidden
                        currentResponsePlaceholder.style.display = 'none'; // Hide placeholder area too
                        await reader.cancel().catch(e => console.warn("Error cancelling reader:", e)); // Cancel stream on error
                        return; // Stop processing on server error event
                    } catch (e) {
                         console.error('Error parsing SSE error event data:', e, 'Data:', data);
                         showJsError('Received unparsable error event from server.');
                         if (latestEntryResponseDiv) {
                            latestEntryResponseDiv.innerHTML = `<span class="error-text">[Unparsable Server Error]</span>`;
                         }
                         await reader.cancel().catch(err => console.warn("Error cancelling reader:", err));
                         return;
                    }
                } else if (event === 'done') {
                    try {
                         // Store the 'done' event data - don't process/render yet
                         finalDoneData = JSON.parse(data);
                         console.log("Received 'done' event, data stored.");
                         // Rendering happens when the reader loop finishes (done=true)
                    } catch (e) {
                       console.error('Error parsing SSE done event data:', e, 'Data:', data);
                       // If done event is bad, render what we have accumulated so far
                       if (latestEntryResponseDiv) {
                           const renderedHtmlOnError = marked.parse(accumulatedResponse);
                           latestEntryResponseDiv.innerHTML = renderedHtmlOnError;
                       }
                       // No need to cancel here, the stream will end naturally
                    }
                }
            } // end while boundaryIndex
        } // end while reader loop

    } catch (error) { // Catch errors from fetch() or initial stream setup
      console.error("Error during fetch/stream setup:", error);
      showJsError(`Error submitting prompt: ${error.message}`);
       // Update history entry if possible
       if (latestEntryResponseDiv) {
           const parentEntry = latestEntryResponseDiv.closest('.history-entry');
            parentEntry.innerHTML = `
                 <div class="history-prompt"><strong>You:</strong><pre>${escapeHtml(promptDisplay)}</pre></div>
                 <div class="history-error error-box" style="margin-top: 10px;"><strong>Error:</strong><pre>${escapeHtml(error.message)}</pre></div>
             `;
        }
    } finally {
      submitButton.disabled = false; // Re-enable button
       // Ensure loaders/placeholders are hidden unless an error is explicitly shown
       cssLoader.style.display = 'none';
       loadingIndicator.style.display = 'none';
       if(jsErrorBox.style.display === 'none') {
           currentResponsePlaceholder.style.display = 'none'; // Hide if no JS error shown
           streamingContent.innerHTML = ''; // Clear just in case
       }
    }
});


// --- NEW Download Button Logic ---
const downloadTxtButton = document.getElementById('download-txt');
const downloadDocxButton = document.getElementById('download-docx');
const downloadPdfButton = document.getElementById('download-pdf');

/**
 * Extracts filename from Content-Disposition header.
 * Handles quoted and unquoted filenames.
 * @param {string | null} headerValue The Content-Disposition header value.
 * @returns {string | null} The extracted filename or null if not found.
 */
function extractFilename(headerValue) {
    if (!headerValue) return null;

    // Match filename="xyz"
    let match = headerValue.match(/filename="([^"]+)"/i);
    if (match && match[1]) {
        return match[1];
    }

    // Match filename=xyz (unquoted)
    match = headerValue.match(/filename=([^;]+)/i);
    if (match && match[1]) {
        // Trim potential whitespace
        return match[1].trim();
    }

    return null; // No filename found
}

/**
 * Handles the download request using fetch.
 * @param {string} format - The download format ('txt' or 'docx').
 */
async function handleDownload(format) {
    if (!userId) {
        showJsError("Cannot download: User ID not available.");
        return;
    }
    console.log(`Requesting download for format: ${format}`);
    jsErrorBox.style.display = 'none'; // Clear previous errors

    // Add a visual indicator (optional, e.g., disable button)
    const button = format === 'txt' ? downloadTxtButton : downloadDocxButton;
    if (button) button.disabled = true;

    const acceptHeader = {
               'txt': 'text/plain',
                'docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
                'pdf': 'application/pdf'
            };

    try {
        const response = await fetch(`/download/${format}`, {
            method: 'GET',
            headers: {
                'X-User-ID': userId, // Include the User ID header
                'Accept': acceptHeader[format] || '*/*' // Optional: Hint expected type
            }
        });

        if (!response.ok) {
            const errorText = await response.text();
            throw new Error(`Server error ${response.status}: ${errorText || 'Download failed'}`);
        }

        // Get the blob data (the file content)
        const blob = await response.blob();

        // Extract filename from header, provide default if missing
        const disposition = response.headers.get('Content-Disposition');
        const filename = extractFilename(disposition) || `chat_history.${format}`;
        console.log(`Received blob type: ${blob.type}, size: ${blob.size}, filename: ${filename}`);


        // Create a temporary URL for the blob
        const url = window.URL.createObjectURL(blob);

        // Create a temporary link element to trigger the download
        const a = document.createElement('a');
        a.style.display = 'none';
        a.href = url;
        a.download = filename; // Set the filename for download prompt
        document.body.appendChild(a);

        // Trigger the download
        a.click();

        // Clean up: remove the link and revoke the blob URL
        window.URL.revokeObjectURL(url);
        document.body.removeChild(a);

    } catch (error) {
        console.error(`Error downloading ${format}:`, error);
        showJsError(`Failed to download ${format}: ${error.message}`);
    } finally {
        // Re-enable the button
        if (button) button.disabled = false;
    }
}


// Add event listeners using the new handler
if (downloadTxtButton) {
    downloadTxtButton.addEventListener('click', () => handleDownload('txt'));
}

if (downloadDocxButton) {
    downloadDocxButton.addEventListener('click', () => handleDownload('docx'));
}

if (downloadPdfButton) { // <<< ADD Listener for PDF
      downloadPdfButton.addEventListener('click', () => handleDownload('pdf'));
}









// Add this within your existing main.js, perhaps inside a DOMContentLoaded listener

const donateButton = document.getElementById('donate-button');
const phoneNumberInput = document.getElementById('phone-number');
const donationStatus = document.getElementById('donation-status');

if (donateButton && phoneNumberInput && donationStatus) {
    donateButton.addEventListener('click', async () => {
        const phoneNumber = phoneNumberInput.value.trim();

        // Basic validation (redundant with backend, but good for UX)
        const phoneRegex = /^\+255[67]\d{8}$/;
        if (!phoneRegex.test(phoneNumber)) {
            donationStatus.textContent = 'Nambari ya simu si sahihi. (Invalid phone number.)';
            donationStatus.className = 'status-message error';
            return;
        }

        donationStatus.textContent = 'Inashughulikia... (Processing...)';
        donationStatus.className = 'status-message processing';
        donateButton.disabled = true; // Prevent multiple clicks

        try {
            const response = await fetch('/api/initiate-donation', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    // Add X-User-ID header if needed by your session/logging logic
                     'X-User-ID': userId // Replace with how you get/store user ID on client
                },
                body: JSON.stringify({ phoneNumber: phoneNumber })
            });

            const result = await response.json();

            if (response.ok && result.success) {
                donationStatus.textContent = result.message; // "Check your phone..."
                donationStatus.className = 'status-message success';
                phoneNumberInput.value = ''; // Clear input on success maybe?
            } else {
                donationStatus.textContent = `Error: ${result.message || 'Failed to initiate.'}`;
                donationStatus.className = 'status-message error';
            }

        } catch (error) {
            console.error('Error initiating donation:', error);
            donationStatus.textContent = 'System error. Please try again.';
            donationStatus.className = 'status-message error';
        } finally {
            donateButton.disabled = false; // Re-enable button
        }
    });
}

