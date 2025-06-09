This codebase implements a "Serverless LLM Manager," a web application designed for interacting with a Google Gemma Large Language Model (LLM). It provides a chat interface, supports multimodal inputs (text and images), manages session history, allows downloading chat transcripts in various formats, logs interactions, and includes a donation feature via the ClickPesa payment gateway.

Here's a detailed review of what the codebase does, broken down by its components:

**I. Overall Purpose & Key Features**

*   **LLM Chat Interface:** Users can send text prompts (and optionally images) to a Gemma LLM and receive responses. Responses are streamed in real-time.
*   **Session Management & History:**
    *   Each user is assigned a persistent ID (stored in browser `localStorage`).
    *   Chat sessions are maintained using signed cookies.
    *   Chat history (prompts, responses, errors) for each session is stored persistently in Google Cloud Storage (GCS), linked to the user and session.
*   **Chat History Download:** Users can download their current session's chat history in:
    *   **TXT:** Plain text format.
    *   **DOCX:** Microsoft Word format, with Markdown styling from LLM responses preserved.
    *   **PDF:** PDF format, also preserving Markdown styling by rendering an HTML version of the chat.
*   **Logging & Analytics:**
    *   Detailed session events (prompts, response lengths, image counts, LLM processing times, errors) are logged to Google BigQuery.
    *   Donation-related events are also logged to BigQuery.
*   **Donation System (ClickPesa):**
    *   Allows users (primarily targeting Tanzanian users with `+255` phone numbers) to make donations.
    *   Integrates with ClickPesa to initiate USSD push payment requests.
    *   Provides client-side polling to check the status of the donation.
    *   Includes a webhook endpoint to receive payment status updates from ClickPesa.
*   **User Interface (UI):**
    *   A web-based UI for chat interactions, viewing history, and accessing features.
    *   Supports light and dark themes, with user preference saved in `localStorage`.
    *   A collapsible menu provides access to downloads, theme settings, and the donation feature.

**II. Backend Components (Node.js/Express.js)**

1.  **`server.js` (Main Application Server)**
    *   **Framework:** Uses Express.js to handle HTTP requests and routing.
    *   **Templating:** Uses EJS to render the main HTML page (`views/index.ejs`).
    *   **Middleware:**
        *   Serves static files (CSS, client-side JS) from the `public` directory.
        *   `cookie-parser`: Parses cookies from incoming requests.
        *   `sessionMiddleware` (custom): Manages user sessions (see `session-manager.js`).
        *   `express.json()` and `express.urlencoded()`: Parse JSON and URL-encoded request bodies.
    *   **Routes:**
        *   `GET /`: Renders the main chat interface.
        *   `POST /generate`: Handles non-streaming LLM requests (seems less used in favor of streaming).
        *   `POST /generate-stream`: Handles streaming LLM requests. It uses `formidable` to parse multipart/form-data (for text prompts and image uploads), then initiates a streaming connection with the Gemma LLM service. Responses are sent to the client via Server-Sent Events (SSE). It logs interaction details to BigQuery.
        *   `GET /download/:format (txt|docx|pdf)`: Generates and streams the requested file format of the chat history.
        *   `GET /api/history`: Returns the chat history for the current user's session.
        *   `POST /api/initiate-donation`: Starts the ClickPesa USSD donation process.
        *   `GET /api/check-donation-status/:orderReference`: Allows the client to poll for the status of a donation.
        *   `POST /api/clickpesa-webhook`: Receives asynchronous payment status updates from ClickPesa.

2.  **`session-manager.js` (Session Persistence)**
    *   **Functionality:** Manages user sessions.
    *   **User Identification:** Relies on an `X-User-ID` header sent by the client.
    *   **Session ID:** Uses signed cookies (`gemma-session`) to store a session ID.
    *   **Storage:** Persists chat history and session metadata (like `createdAt`, `lastUpdated`) as JSON files in a Google Cloud Storage (GCS) bucket. Files are organized by `USER_ID/SESSION_ID.json`.
    *   **Middleware (`sessionMiddleware`)**:
        *   Extracts `userId` from the `X-User-ID` header.
        *   Loads existing session data from GCS based on `userId` and the `sessionId` from the cookie.
        *   If no valid session exists, it creates a new session ID and initializes data.
        *   Attaches `req.gemmaSession` to the request object, containing `id`, `userId`, `chatHistory`, and a `save()` method to persist changes to GCS.

3.  **`gemma-client.js` (LLM Service Client)**
    *   **Functionality:** Communicates with the external Gemma LLM service (assumed to be on Google Cloud Run and using an Ollama backend).
    *   **Authentication:** `fetchIdentityToken()` obtains an OIDC Identity Token from Google Auth Library to authenticate requests to the Cloud Run service.
    *   **Request Formatting:** `transformHistoryToMessages()` converts the application's chat history into the format expected by the Ollama API (an array of user/assistant messages, including images).
    *   **API Calls:**
        *   `callGemmaChatService()`: Makes a standard (non-streaming) request to the LLM's `/api/chat` endpoint.
        *   `callGemmaChatServiceStream()`: Makes a streaming request to the LLM's `/api/chat` endpoint, handling base64 encoded images for multimodal input and processing the NDJSON (Newline Delimited JSON) stream.
    *   Uses `axios` for HTTP requests.

4.  **`download-generator.js` (File Generation Logic)**
    *   **Functionality:** Generates downloadable files from chat history.
    *   `generateTxt()`: Creates a simple plain text file of the chat.
    *   `generateDocx()`:
        *   Uses the `docx` library.
        *   Converts Markdown from LLM responses into DOCX elements (headings, paragraphs, lists, code blocks, links, bold, italics, etc.).
        *   Applies custom styling and formatting. Includes a helper `applyCustomBoldToParagraph` for specific bolding needs.
    *   `generatePdf()`:
        *   Uses `puppeteer` (headless Chrome).
        *   Converts the chat history into an HTML string (using `marked` for Markdown parts).
        *   Applies CSS (from `public/css/style.css` or defaults) to the HTML.
        *   Renders the HTML to a PDF buffer.

5.  **`bigquery-logger.js` (Event Logging)**
    *   **Functionality:** Logs events to a specified Google BigQuery table.
    *   Reads `BIGQUERY_DATASET` and `BIGQUERY_TABLE` from environment variables.
    *   `logSessionEvent()`: Inserts a record into BigQuery, automatically adding a timestamp. Handles potential BQ client initialization issues and insertion errors.

6.  **`clickpesa-client.js` (Payment Gateway Client)**
    *   **Functionality:** Interacts with the ClickPesa API.
    *   `getClickPesaAuthToken()`: Fetches an authentication token from ClickPesa.
    *   `initiateClickPesaUssdPush()`: Initiates a USSD payment request with details like amount, currency, order reference, and phone number.
    *   `queryClickPesaPaymentStatus()`: Checks the status of a previously initiated payment.
    *   Uses `axios` for HTTP requests.

**III. Frontend Components (`public` directory)**

1.  **`js/main.js` (Main Client-Side Logic)**
    *   **User ID Management:** Generates or retrieves a unique user ID using `localStorage` and sends it in the `X-User-ID` header for backend requests.
    *   **Theme Management:** Toggles between light and dark themes and saves the preference in `localStorage`.
    *   **Chat Interaction:**
        *   Handles prompt submission (text and image uploads via `FormData`).
        *   Communicates with the `/generate-stream` backend endpoint using `fetch`.
        *   Processes Server-Sent Events (SSE) to display streamed LLM responses in real-time.
        *   Uses `marked.js` to render Markdown in chat responses.
        *   Displays chat history loaded from the server (`/api/history`).
    *   **Download Triggers:** Handles clicks on download buttons, making requests to the backend download routes and initiating browser file downloads.
    *   **UI Updates:** Manages loading indicators, error messages, and the collapsible menu.
    *   **Donation Flow:** Initializes and interacts with `DonationHandler.js`.

2.  **`js/DonationHandler.js` (Client-Side Donation Logic)**
    *   Manages the UI flow for making a donation.
    *   Validates the phone number format (Tanzanian).
    *   Calls the backend `/api/initiate-donation` endpoint.
    *   If initiation is successful, it polls the `/api/check-donation-status/:orderReference` endpoint at intervals to get payment status updates.
    *   Updates the UI with status messages (processing, success, failure).

3.  **`js/marked.js` (Markdown Parser)**
    *   A third-party library used to convert Markdown text (from LLM responses) into HTML for display in the browser and for PDF generation.

4.  **`css/style.css` (Stylesheets)**
    *   Provides all the visual styling for the application, including:
        *   Layout, typography, form elements.
        *   Light and dark theme definitions.
        *   Chat history display, prompt/response boxes.
        *   Loading indicators, menu, and donation section.

5.  **`css/test.html`**
    *   An isolated HTML file demonstrating a "Bouncing Bird" CSS animation. It does not appear to be part of the main application's functionality.

**IV. Configuration & Dependencies**

*   **`package.json` / `package-lock.json`:** Define project metadata, scripts, and dependencies (Express, Axios, Google Cloud libraries, DOCX, Puppeteer, Marked, etc.).
*   **`.env` (via `dotenv` library):** Used to load environment variables for configuration (e.g., API keys, bucket names, Cloud Run URLs, BigQuery details, cookie secret).

**V. Workflow Summary**

1.  **User Visits:** The user opens the web page. `main.js` initializes a user ID (from `localStorage` or new) and loads any existing chat history for that user from the backend (`/api/history`), which in turn fetches it from GCS.
2.  **User Sends Prompt:** The user types a prompt, optionally uploads images, and submits.
3.  **Backend Processing (Stream):**
    *   `server.js` (`/generate-stream`) receives the request.
    *   `sessionMiddleware` loads/initializes the session.
    *   Uploaded images are processed into base64.
    *   `gemma-client.js` gets an auth token and calls the Gemma LLM service with the prompt, images, and chat history.
    *   The LLM response is streamed back to `server.js`.
4.  **Streaming to Client:**
    *   `server.js` sends the LLM response chunks as SSE to `main.js`.
    *   `main.js` updates the UI in real-time, rendering Markdown as it arrives.
5.  **History & Logging:**
    *   Once the LLM response is complete, `server.js` updates the chat history in `req.gemmaSession` and calls `save()` to persist it to GCS.
    *   Interaction details are logged to BigQuery via `bigquery-logger.js`.
6.  **Download:** User clicks a download button. `main.js` requests the specific format from the backend. `server.js` uses `download-generator.js` to create the file from GCS-stored history and sends it to the client.
7.  **Donation:** User enters their phone number and clicks "Donate."
    *   `DonationHandler.js` calls `/api/initiate-donation`.
    *   `server.js` uses `clickpesa-client.js` to request a USSD push from ClickPesa.
    *   `DonationHandler.js` polls `/api/check-donation-status` until a final status is received or it times out.
    *   ClickPesa can also send asynchronous updates to `/api/clickpesa-webhook`.
    *   Donation events are logged to BigQuery.

This codebase provides a comprehensive solution for a serverless LLM chat application with several advanced features like session persistence, various download formats, and payment integration.
