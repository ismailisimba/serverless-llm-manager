// bigquery-logger.js
import { BigQuery } from '@google-cloud/bigquery';
import dotenv from 'dotenv';

dotenv.config();

const DATASET_ID = process.env.BIGQUERY_DATASET;
const TABLE_ID = process.env.BIGQUERY_TABLE;

// Basic check for environment variables
if (!DATASET_ID || !TABLE_ID) {
  console.warn(
    'BigQuery logging is disabled: BIGQUERY_DATASET or BIGQUERY_TABLE environment variables are not set.'
  );
}

let bigquery;
let table;

// Initialize only if configured
if (DATASET_ID && TABLE_ID) {
  try {
    bigquery = new BigQuery(); // Assumes ADC
    table = bigquery.dataset(DATASET_ID).table(TABLE_ID);
    console.log(
      `BigQuery Logger initialized for table: ${DATASET_ID}.${TABLE_ID}`
    );
  } catch (error) {
    console.error('CRITICAL: Failed to initialize BigQuery client!', error);
    // Continue running, but logging will be disabled
    bigquery = null;
    table = null;
  }
}

/**
 * Logs a session event record to BigQuery.
 * Silently fails if BigQuery is not configured or if insertion fails.
 * @param {object} eventData - Object matching the BigQuery table schema.
 */
export async function logSessionEvent(eventData) {
  // Do nothing if BQ client wasn't initialized
  if (!table) {
    // console.log("Skipping BQ log: Client not initialized."); // Optional debug
    return;
  }

  // Ensure timestamp is set, default to now if not provided
  const recordToInsert = {
    event_timestamp: BigQuery.timestamp(new Date()), // Use BQ timestamp
    ...eventData, // Spread the rest of the data
  };

  try {
    // console.log("Logging event to BigQuery:", recordToInsert); // Optional debug
    await table.insert([recordToInsert], {
        ignoreUnknownValues: true, // Ignore fields not in schema
        skipInvalidRows: true // Skip if row itself is invalid (e.g., wrong type)
    });
    // console.log("BQ event logged successfully."); // Optional debug
  } catch (error) {
    console.error('Failed to insert event into BigQuery:', error?.message);
    // Log detailed errors if available (often nested)
    if (error.errors && error.errors.length > 0) {
      console.error('BigQuery Insertion Errors:', JSON.stringify(error.errors, null, 2));
    }
  }
}