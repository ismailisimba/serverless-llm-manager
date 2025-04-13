// session-manager.js
import { v4 as uuidv4 } from 'uuid';
import { sign, unsign } from 'cookie-signature';
import { Storage } from '@google-cloud/storage';

// --- Configuration ---
const COOKIE_NAME = 'gemma-session';
const COOKIE_SECRET = process.env.COOKIE_SECRET;
const BUCKET_NAME = process.env.GCS_SESSION_BUCKET_NAME;
const SESSION_FOLDER_ROOT = 'sessions'; // Root folder for all user sessions

// --- Input Validation ---
if (!COOKIE_SECRET || !BUCKET_NAME) {
  console.error(
    'FATAL ERROR: COOKIE_SECRET or GCS_SESSION_BUCKET_NAME environment variable is not set!'
  );
  process.exit(1);
}

// --- Initialize GCS Client ---
const storage = new Storage();
const bucket = storage.bucket(BUCKET_NAME);
console.log(
  `Session manager configured for GCS bucket: ${BUCKET_NAME}/${SESSION_FOLDER_ROOT}`
);

/**
 * Initializes the default structure for session data.
 */
function initializeSessionData() {
  return {
    chatHistory: [],
    createdAt: new Date().toISOString(),
  };
}

/**
 * Constructs the GCS object path for a given user and session.
 * @param {string} userId
 * @param {string} sessionId
 * @returns {string} GCS object path e.g., "user_sessions/USER_ID/SESSION_ID.json"
 * @throws {Error} if userId or sessionId is missing.
 */
function getSessionPath(userId, sessionId) {
    if (!userId || !sessionId) {
        throw new Error("UserId and SessionId are required to construct session path.");
    }
    // Use encodeURIComponent for IDs just in case they ever contain special chars
    return `${SESSION_FOLDER_ROOT}/${encodeURIComponent(userId)}/${encodeURIComponent(sessionId)}.json`;
}


/**
 * Loads session data from GCS for a given user and session ID.
 * @param {string} userId The User ID owning the session.
 * @param {string} sessionId The session ID to load.
 * @returns {Promise<object|null>} Session data object or null if not found/error.
 */
async function loadSession(userId, sessionId) {
  if (!userId) {
       console.error("Attempted to load session without userId.");
       return null;
  }
  const objectPath = getSessionPath(userId, sessionId);
  const file = bucket.file(objectPath);

  try {
    //console.log(`DEBUG: Attempting download: ${objectPath}`);
    const [dataBuffer] = await file.download();
    const sessionData = JSON.parse(dataBuffer.toString());
    sessionData.chatHistory = Array.isArray(sessionData.chatHistory)
      ? sessionData.chatHistory
      : [];
    //console.log(`DEBUG: Loaded session ${sessionId} for user ${userId}`);
    return sessionData;
  } catch (error) {
    if (error.code === 404) {
      // console.log(`Session file not found: ${objectPath}`);
    } else {
      console.error(
        `Error loading session ${sessionId} for user ${userId} (${objectPath}):`,
        error.message
      );
    }
    return null;
  }
}

/**
 * Saves session data to GCS for a given user and session ID.
 * @param {string} userId The User ID owning the session.
 * @param {string} sessionId The session ID to save.
 * @param {object} sessionData The data object to save.
 * @returns {Promise<void>}
 * @throws {Error} If saving fails or userId/sessionId missing.
 */
async function saveSession(userId, sessionId, sessionData) {
   if (!userId) {
       throw new Error("Cannot save session without userId.");
   }
  const objectPath = getSessionPath(userId, sessionId);
  const file = bucket.file(objectPath);

  const dataToSave = {
    ...sessionData,
    chatHistory: Array.isArray(sessionData.chatHistory) ? sessionData.chatHistory : [],
    lastUpdated: new Date().toISOString(),
    // Ensure createdAt is preserved if it exists, otherwise set it
    createdAt: sessionData.createdAt || new Date().toISOString(),
  };

  const jsonString = JSON.stringify(dataToSave);

  try {
    // console.log(`DEBUG: Attempting save: ${objectPath}`);
    await file.save(jsonString, {
      contentType: 'application/json',
      resumable: false,
    });
    // console.log(`DEBUG: Saved session ${sessionId} for user ${userId}`);
  } catch (error) {
    console.error(
      `Error saving session ${sessionId} for user ${userId} (${objectPath}):`,
      error.message
    );
    throw new Error(`Failed to save session: ${error.message}`);
  }
}

/**
 * Middleware to manage user sessions via signed cookies and GCS persistence.
 * Reads 'X-User-ID' header. Attaches req.gemmaSession.
 */
export async function sessionMiddleware(req, res, next) {
  if (!req.cookies) {
    console.error('Cookies not parsed.');
    return next(new Error('Cookie parsing middleware required.'));
  }

  // <<< Get User ID from Header >>>
  const userId = req.headers['x-user-id'];

  if (!userId) {

      // This should ideally not happen if the frontend always sends it.
      // How to handle? Send error? Assign temporary ID? Block?
      // For now, log prominently and block requests that need session saving.
      // Allow reads (like GET /) to proceed maybe with empty history?
      console.error(`CRITICAL: Missing X-User-ID header for request path: ${req.path}. Session persistence will fail.`);
      // Let's create a temporary session object but flag it?
       req.gemmaSession = {
           id: 'invalid-session-' + uuidv4(),
           userId: null, // Mark userId as null
           chatHistory: [],
           save: async () => {
               console.error("Session save blocked: Missing User ID.");
               // Optionally throw an error here if routes should fail hard
               // throw new Error("Cannot save session without User ID.");
           }
       };
       // Allow request to proceed, but saving will be blocked.
       return next();

      // --- OR --- More strict approach:
      // return res.status(400).send('Bad Request: Missing X-User-ID header.');
  }

  let sessionId = null;
  let sessionData = null;
  let needsCookieSet = false;
  let loadedSessionId = null; // Track ID found in cookie

  // 1. Check cookie
  const rawCookieValue = req.cookies[COOKIE_NAME];
  if (rawCookieValue) {
    const unsignedValue = unsign(rawCookieValue, COOKIE_SECRET);
    if (unsignedValue !== false) {
        loadedSessionId = unsignedValue; // Store the session ID from the cookie
        sessionData = await loadSession(userId, loadedSessionId); // <<< Use userId here
        // If sessionData is null, it means file not found in GCS or load error
        if (sessionData === null) {
            sessionId = loadedSessionId; // Keep the existing session ID
            sessionData = initializeSessionData(); // Initialize fresh data
            // Don't set needsCookieSet = true, cookie ID is still valid
        } else {
             sessionId = loadedSessionId; // Successfully loaded
        }
    } else {
      console.warn(`[User: ${userId}] Invalid/tampered session cookie. Clearing.`);
      res.clearCookie(COOKIE_NAME);
      sessionId = null;
    }
  }

  // 2. If no valid session found/loaded, create new session
  if (!sessionId) {
    sessionId = uuidv4();
    sessionData = initializeSessionData();
    needsCookieSet = true; // Need to send cookie to client
    // console.log(`DEBUG: Initialized new session ${sessionId} for user ${userId}`); // Optional
  }

  // 3. Set cookie if needed
  if (needsCookieSet) {
    const signedSessionId = sign(sessionId, COOKIE_SECRET);
    res.cookie(COOKIE_NAME, signedSessionId, {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'lax',
      maxAge: 1000 * 60 * 60 * 24 * 7, // 7 days
    });
  }

  // 4. Attach session info to request object
  // Capture current state for the save closure
  const currentSessionId = sessionId;
  const currentUserId = userId; // Get userId from header
  const currentSessionData = sessionData; // Get the loaded or initialized data

  req.gemmaSession = {
    id: currentSessionId,
    userId: currentUserId, // Add userId to the session object
    chatHistory: currentSessionData.chatHistory,
    // Update save function closure to use captured IDs and current data
    save: async () => {
        // Create the object to save using the potentially modified chatHistory
        const dataToSave = {
            ...currentSessionData, // Include original fields like createdAt
            chatHistory: req.gemmaSession.chatHistory // Use potentially updated history
        };
        // Call the actual save function with captured IDs and current data
        await saveSession(currentUserId, currentSessionId, dataToSave);
    }
  };

  // 5. Continue
  next();
}