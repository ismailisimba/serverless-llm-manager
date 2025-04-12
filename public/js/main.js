// public/js/main.js
console.log('Main JS loaded V2 - Streaming Ready');

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
//document.addEventListener('DOMContentLoaded', applyTheme); // Apply theme on load
// --- Initialize User ID and Theme on Load --- <<< MODIFIED >>>
document.addEventListener('DOMContentLoaded', () => {
    initializeUserId(); // <<< CALL User ID initialization
    applyTheme();
    loadInitialHistory()
});

// --- Helper Functions ---

/**
 * Appends a complete chat entry (User Prompt + Gemma Response) to the chat history.
 * @param {string} promptText User's prompt.
 * @param {string} responseHtml Rendered HTML response from Gemma (or error text).
 * @param {boolean} isError Indicates if the response is an error message.
 */
/*function appendChatEntry(promptText, responseHtml, isError = false) {
    // Remove "No history" message if it exists
    if (noHistoryMsg) {
        noHistoryMsg.remove();
    }

    const entryDiv = document.createElement('div');
    entryDiv.className = 'history-entry';

    const promptDiv = document.createElement('div');
    promptDiv.className = 'history-prompt';
    promptDiv.innerHTML = `<strong>You:</strong><pre>${escapeHtml(promptText)}</pre>`; // Escape user prompt

    const responseDiv = document.createElement('div');
    responseDiv.className = isError ? 'history-error error-box' : 'history-response result-box';
    responseDiv.style.marginTop = '10px'; // Add space
    responseDiv.innerHTML = `<strong>${isError ? 'Error' : 'Gemma'}:</strong><div>${responseHtml}</div>`; // responseHtml is already rendered markdown OR error pre

    entryDiv.appendChild(promptDiv);
    entryDiv.appendChild(responseDiv);
    chatOutput.appendChild(entryDiv);

    // Scroll to bottom
    chatOutput.scrollTop = chatOutput.scrollHeight;
}*/

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
        // Clear any potential leftover content (though should be empty)
        // chatOutput.innerHTML = '<h2>Conversation</h2>'; // Keep header

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

function showJsError(message) {
    console.error("Frontend Error:", message);
    jsErrorBox.textContent = message;
    jsErrorBox.style.display = 'block';
    cssLoader.style.display = 'none'; // Hide CSS loader on JS error
    loadingIndicator.style.display = 'none'; // Hide text loader on JS error
    currentResponsePlaceholder.style.display = 'none';
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

/**
 * Displays an error message in the dedicated JS error box.
 * @param {string} message The error message to display.
 */
/*function showJsError(message) {
    console.error("Frontend Error:", message);
    jsErrorBox.textContent = message;
    jsErrorBox.style.display = 'block';
    // Hide loading indicator if it was visible
    loadingIndicator.style.display = 'none';
    currentResponsePlaceholder.style.display = 'none';
}*/





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
     // promptTextarea.value = ''; // Don't clear textarea here, clear form below
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
         throw new Error(`Server error ${response.status}: ${errorText || 'Unknown error'}`);
      }
      if (!response.body) throw new Error('Response body is null.');
  
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      let bigResData = ''; // For debugging
  
      while (true) {
        const { value, done } = await reader.read();
        if (done) {
          console.log('Stream finished.');
          if (!isStreamStarted) { // If stream ends before *any* data/event useful received
               cssLoader.style.display = 'none'; // Hide loader
               showJsError("Stream ended without receiving any data.");
          }
          // Final rendering should have happened via 'done' event if received
          try {
            const doneData = JSON.parse(bigResData);
            console.log('Received done event:', doneData);
            accumulatedResponse = doneData.fullResponse || accumulatedResponse;

            // Render final response and update history entry
            const renderedHtml = marked.parse(accumulatedResponse);
            if (latestEntryResponseDiv) {
                 latestEntryResponseDiv.innerHTML = renderedHtml; // Update final history item
                 latestEntryResponseDiv.closest('.history-entry')?.scrollIntoView({ behavior: 'smooth', block: 'end' });
             } else {
                 appendChatEntry(userPrompt, renderedHtml, false); // Fallback add
             }

            cssLoader.style.display = 'none'; // Hide loader
            streamingContent.innerHTML = ''; // Clear streaming area
            currentResponsePlaceholder.style.display = 'none'; // Hide placeholder

            await reader.cancel();
            return; // Exit processing loop
          } catch (e) { /* ... (error parsing done data) ... */
             console.error('Error parsing SSE done event data:', e, 'Data:', data);
              // Render accumulated markdown as best effort
             const renderedHtmlOnError = marked.parse(accumulatedResponse);
             if (latestEntryResponseDiv) {
                 latestEntryResponseDiv.innerHTML = renderedHtmlOnError;
             }
             cssLoader.style.display = 'none';
             streamingContent.innerHTML = '';
             currentResponsePlaceholder.style.display = 'none';
             await reader.cancel();
             return;
          }
          break;
        }
  
         // --- Hide loader on first received chunk --- <<< ADD LOGIC >>>
         if (!isStreamStarted) {
             isStreamStarted = true;
             cssLoader.style.display = 'none'; // Hide CSS loader now
             streamingContent.innerHTML = '<pre></pre>'; // Add pre tag now ready for text
         }
         // --- End hide loader logic ---
  
  
        buffer += decoder.decode(value, { stream: true });
        let boundaryIndex;
  
        while ((boundaryIndex = buffer.indexOf('\n\n')) >= 0) {
          const message = buffer.substring(0, boundaryIndex);
          buffer = buffer.substring(boundaryIndex + 2);
  
          let event = 'message';
          let data = '';
          message.split('\n').forEach(line => { /* ... (SSE parsing remains same) ... */
               if (line.startsWith('event:')) event = line.substring(6).trim();
               else if (line.startsWith('data:')) data = line.substring(5).trim();
          });
  
          if (event === 'message' || event === 'data') {
            try {
              const parsedData = JSON.parse(data);
              if (parsedData.text) {
                accumulatedResponse += parsedData.text;
                // Append text chunk to the PRE tag within streamingContent
                const preElement = streamingContent.querySelector('pre');
                if (preElement) {
                    preElement.textContent += parsedData.text;
                }
                currentResponsePlaceholder.scrollTop = currentResponsePlaceholder.scrollHeight;
              }
            } catch (e) { console.error('Error parsing SSE data JSON:', e, 'Data:', data); }
          } else if (event === 'error') {
            try {
              const errorData = JSON.parse(data);
              console.error('Received error event from server:', errorData.message);
              showJsError(`Server error: ${errorData.message}`); // Show error in dedicated box
              // Update history entry
               if (latestEntryResponseDiv) {
                   const parentEntry = latestEntryResponseDiv.closest('.history-entry');
                   parentEntry.innerHTML = `
                       <div class="history-prompt"><strong>You:</strong><pre>${escapeHtml(userPrompt)}</pre></div>
                       <div class="history-error error-box" style="margin-top: 10px;"><strong>Error:</strong><pre>${escapeHtml(errorData.message)}</pre></div>
                   `;
               }
              cssLoader.style.display = 'none'; // Ensure loader is hidden
              currentResponsePlaceholder.style.display = 'none'; // Hide placeholder area too
              await reader.cancel();
              return;
            } catch (e) { /* ... (error parsing error data) ... */
              showJsError('Received unparsable error event from server.');
              await reader.cancel();
              return;
            }
          } else if (event === 'done') {
          //Done rendering was here
          }
          bigResData=data
        } // end while boundaryIndex
      } // end while reader loop
  
    } catch (error) { // Catch errors from fetch() or initial stream setup
      showJsError(`Error submitting prompt: ${error.message}`);
       // Update history entry
      if (latestEntryResponseDiv) {
          const parentEntry = latestEntryResponseDiv.closest('.history-entry');
           parentEntry.innerHTML = `
               <div class="history-prompt"><strong>You:</strong><pre>${escapeHtml(userPrompt)}</pre></div>
               <div class="history-error error-box" style="margin-top: 10px;"><strong>Error:</strong><pre>${escapeHtml(error.message)}</pre></div>
           `;
       }
    } finally {
      submitButton.disabled = false; // Re-enable button
       // Ensure loaders are hidden if loop exited unexpectedly
       cssLoader.style.display = 'none';
       loadingIndicator.style.display = 'none';
       // We leave the placeholder visible if there was content, otherwise hide?
       // Hiding it seems cleaner unless an error occurred above.
       // Let's hide it unless an error was shown in jsErrorBox
       if(jsErrorBox.style.display === 'none') {
          // currentResponsePlaceholder.style.display = 'none'; // Let's keep it visible if stream ended abruptly
       }
    }
  });




  // --- Download Button Logic ---
const downloadTxtButton = document.getElementById('download-txt');
const downloadDocxButton = document.getElementById('download-docx');

if (downloadTxtButton) {
    downloadTxtButton.addEventListener('click', () => {
        console.log('Download TXT clicked');
        // Trigger download by navigating to the backend endpoint
        window.location.href = '/download/txt';
    });
}

if (downloadDocxButton) {
    downloadDocxButton.addEventListener('click', () => {
        console.log('Download DOCX clicked');
        // Trigger download by navigating to the backend endpoint
        window.location.href = '/download/docx';
    });
}