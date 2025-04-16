// public/js/DonationHandler.js

class DonationHandler {
    // Constants for polling
    static MAX_POLL_ATTEMPTS = 20; // Approx 90 seconds
    static POLL_INTERVAL_MS = 17000; // 5 seconds

    // Properties to store state and elements
    donateButton;
    phoneNumberInput;
    statusElement;
    pollingIntervalId = null;
    pollAttempts = 0;
    currentOrderReference = null;

    /**
     * Initializes the DonationHandler.
     * @param {HTMLButtonElement} donateButtonElement - The donate button element.
     * @param {HTMLInputElement} phoneInputElement - The phone number input element.
     * @param {HTMLElement} statusOutputElement - The element to display status messages.
     */
    constructor(donateButtonElement, phoneInputElement, statusOutputElement) {
        if (!donateButtonElement || !phoneInputElement || !statusOutputElement) {
            throw new Error("DonationHandler requires valid button, input, and status elements.");
        }
        this.donateButton = donateButtonElement;
        this.phoneNumberInput = phoneInputElement;
        this.statusElement = statusOutputElement;
    }

    /**
     * Sets up the event listener for the donate button. Call this once on page load.
     */
    init() {
        this.donateButton.addEventListener('click', () => this._handleDonateClick());
        console.log("Donation Handler Initialized.");
    }

    /**
     * Handles the donate button click event.
     * @private
     */
    async _handleDonateClick() {
        this._stopPolling(); // Stop any previous polling

        const phoneNumber = this.phoneNumberInput.value.trim();

        if (!this._validatePhoneNumber(phoneNumber)) {
            this._updateStatusUI('Nambari ya simu si sahihi. (Invalid phone number.)', 'error');
            return;
        }

        this._updateStatusUI('Inashughulikia... (Processing...)', 'processing');
        this.donateButton.disabled = true;

        try {
            // Initiate the donation via backend API
            const response = await fetch('/api/initiate-donation', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'X-User-ID': this._getUserId() // If needed
                },
                body: JSON.stringify({ phoneNumber: phoneNumber })
            });

            const result = await response.json();

            if (response.ok && result.success && result.orderReference) {
                this._updateStatusUI(result.message, 'processing'); // "Check your phone..."
                this._startPolling(result.orderReference); // Start polling on success
            } else {
                // Initiation failed
                this._updateStatusUI(`Error: ${result.message || 'Failed to initiate.'}`, 'error');
                this.donateButton.disabled = false; // Re-enable button
            }

        } catch (error) {
            console.error('Error initiating donation:', error);
            this._updateStatusUI('System error. Please try again.', 'error');
            this.donateButton.disabled = false; // Re-enable button
        }
        // Button remains disabled if polling starts; _stopPolling re-enables it
    }

    /**
     * Validates the phone number format.
     * @param {string} phoneNumber
     * @returns {boolean}
     * @private
     */
    _validatePhoneNumber(phoneNumber) {
        const phoneRegex = /^\+255[67]\d{8}$/; // Tanzanian format
        return phoneRegex.test(phoneNumber);
    }

    /**
     * Starts the polling process for the given order reference.
     * @param {string} orderReference
     * @private
     */
    _startPolling(orderReference) {
        this._stopPolling(); // Ensure no old interval is running
        this.currentOrderReference = orderReference;
        this.pollAttempts = 0;
        console.log(`Starting polling for ${this.currentOrderReference}`);

        // Initial immediate check after short delay
        setTimeout(() => this._checkStatus(), 1000); // Check after 1 sec

        // Set interval for subsequent checks
        this.pollingIntervalId = setInterval(
            () => this._checkStatus(),
            DonationHandler.POLL_INTERVAL_MS
        );
    }

    /**
     * Performs a single status check by calling the backend.
     * @private
     */
    async _checkStatus() {
        if (!this.currentOrderReference) return; // Should not happen if polling started

        this.pollAttempts++;
        console.log(`Polling attempt ${this.pollAttempts} for ${this.currentOrderReference}`);

        if (this.pollAttempts > DonationHandler.MAX_POLL_ATTEMPTS) {
            console.log("Max polling attempts reached.");
            this._updateStatusUI('Hali haijulikani. Tafadhali angalia historia ya muamala wako. (Status unknown. Please check your transaction history.)', 'error');
            this._stopPolling();
            return;
        }

        try {
            const response = await fetch(`/api/check-donation-status/${this.currentOrderReference}`,{
                method: 'GET',
                headers: {
                    'X-User-ID': this._getUserId(), // Include User ID if needed
                }
            });
            if (!response.ok) {
                // Handle server errors during polling (e.g., 500 from our backend)
                 const errorData = await response.json().catch(() => ({})); // Try get error details
                throw new Error(`Server error checking status: ${response.status} ${response.statusText} - ${errorData.message || ''}`);
            }
            const result = await response.json(); // { status: '...' }

            console.log("Poll status received:", result.status);

            switch (result.status) {
                case 'SUCCESS':
                case 'SETTLED':
                    this._updateStatusUI('Asante! Malipo yamepokelewa. (Thank you! Payment received successfully.)', 'success');
                    this._stopPolling();
                    this.phoneNumberInput.value = ''; // Clear input on final success
                    break;
                case 'FAILED':
                    this._updateStatusUI('Samahani, malipo hayakufanikiwa. (Sorry, the payment failed.)', 'error');
                    this._stopPolling();
                    break;
                case 'PROCESSING':
                case 'PENDING':
                    this._updateStatusUI(`Utapokea menu ya malipo kwa simu kwenye simu yenye namba uliyoweka hapo juu. Tafadhali usihame programu kwenye kifaa chako... (${this.pollAttempts}/${DonationHandler.MAX_POLL_ATTEMPTS}) (Waiting for confirmation...)`, 'processing');
                    break;
                case 'ERROR': // Specific error reported by our backend status check endpoint
                    this._updateStatusUI(`Error checking status: ${result.message || 'Unknown error'}`, 'error');
                    this._stopPolling();
                    break;
                default: // Unknown status or still effectively processing
                    this._updateStatusUI(`Tafadhali subiri hadi dk 5... (${this.pollAttempts}/${DonationHandler.MAX_POLL_ATTEMPTS}) (Waiting...)`, 'processing');
                    break;
            }

        } catch (error) {
            console.error('Error during status poll fetch:', error);
            // Update UI but let the max attempts logic handle stopping polling for network issues
            this._updateStatusUI('Tatizo la mtandao kuangalia hali. (Network error checking status.)', 'error');
        }
    }

    /**
     * Stops the polling interval and resets state.
     * @private
     */
    _stopPolling() {
        if (this.pollingIntervalId) {
            clearInterval(this.pollingIntervalId);
            this.pollingIntervalId = null;
            this.pollAttempts = 0;
            this.currentOrderReference = null; // Clear reference once polling stops
            console.log("Polling stopped.");
        }
        // Always ensure button is enabled when polling stops
        if(this.donateButton) this.donateButton.disabled = false;
    }

    /**
     * Updates the status message UI element.
     * @param {string} message - The message to display.
     * @param {string} type - 'processing', 'success', or 'error'.
     * @private
     */
    _updateStatusUI(message, type = 'processing') {
        if (this.statusElement) {
            this.statusElement.textContent = message;
            // Add specific classes for styling based on type
            this.statusElement.className = `status-message ${type}`;
        }
    }

     /**
      * Placeholder for getting User ID if needed for API calls
      * @returns {string}
      * @private
      */
     _getUserId() {
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
        return storedId; // Placeholder
    }
}