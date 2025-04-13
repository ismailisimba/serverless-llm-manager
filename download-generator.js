import { marked } from 'marked';
import * as fs from 'fs/promises';
import path from 'path';
import { escape } from 'html-escaper';
import puppeteer from 'puppeteer';
import {
    Document, Packer, Paragraph, TextRun, HeadingLevel, AlignmentType,
    ExternalHyperlink, ShadingType, Numbering, Indent, convertInchesToTwip
} from 'docx';

// Helper function to apply custom bold formatting (**text**) to TextRuns within a Paragraph
function applyCustomBoldToParagraph(paragraph) {
    if (!paragraph || !paragraph.root || !Array.isArray(paragraph.root)) {
        // Not a paragraph with children or children format is unexpected
        return paragraph;
    }

    const newChildren = [];
    // Regex to find text enclosed in double asterisks (non-greedy)
    const boldRegex = /\*\*(.*?)\*\*/g;

    for (const child of paragraph.root) {
        // Only process TextRun objects
        if (child instanceof TextRun && typeof child.properties.text === 'string') {
            const originalText = child.options.text;
            const originalOptions = { ...child.options }; // Clone options
            delete originalOptions.text; // Remove text property from base options
            delete originalOptions.children; // Ensure no nested children array confusion

            let lastIndex = 0;
            let match;
            let textAdded = false; // Flag to track if any runs were added for this child

            // Resetting regex state for each text run
            boldRegex.lastIndex = 0; 

            while ((match = boldRegex.exec(originalText)) !== null) {
                // 1. Add preceding text (if any)
                if (match.index > lastIndex) {
                    newChildren.push(new TextRun({
                        ...originalOptions, // Keep original styles (italics, etc.)
                        text: originalText.substring(lastIndex, match.index)
                    }));
                }
                // 2. Add the bolded text (captured group 1)
                if (match[1]) { // Ensure there's content between asterisks
                    newChildren.push(new TextRun({
                        ...originalOptions, // Keep original styles
                        text: match[1],
                        bold: true // Apply bold
                    }));
                }
                lastIndex = boldRegex.lastIndex;
                textAdded = true;
            }

            // 3. Add remaining text (if any)
            if (lastIndex < originalText.length) {
                newChildren.push(new TextRun({
                    ...originalOptions, // Keep original styles
                    text: originalText.substring(lastIndex)
                }));
                textAdded = true;
            }
            
            // If the regex didn't match anything in this TextRun, add the original child back
            if (!textAdded) {
                 newChildren.push(child);
            }

        } else {
            // If not a TextRun, add it directly
            newChildren.push(child);
        }
    }

    // Replace the paragraph's children with the processed ones
    // In docx v7/v8, children are typically under paragraph.options.children
    // In v9+, they might be directly under paragraph.root (check your docx version)
    // This example assumes a structure where modifying paragraph.root is effective
    // or that options.children reflects the same array.
    // For robustness with newer versions (v9+), directly manipulating paragraph.root is safer.
    paragraph.root = newChildren;

    // If using older docx library versions, you might need:
    // paragraph.options.children = newChildren;

    return paragraph; // Return the modified paragraph
}


// Helper function to convert Markdown tokens to DOCX components
async function renderTokensToDocx(tokens, docxComponentsList, numberingConfig = null) {
    for (const token of tokens) {
        switch (token.type) {
            case 'heading':
                docxComponentsList.push(new Paragraph({
                    children: await renderTokensToDocx(token.tokens, [], numberingConfig),
                    heading: `Heading${token.depth}`,
                    spacing: { after: 120 }
                }));
                break;
            case 'paragraph':
                 // Render inner tokens first
                const paragraphChildren = await renderTokensToDocx(token.tokens, [], numberingConfig);
                docxComponentsList.push(new Paragraph({
                    children: paragraphChildren,
                    spacing: { after: 100 }
                }));
                break;
            case 'list':
                 if (!numberingConfig) {
                      // Define default or ensure it's passed properly if needed outside generateDocx scope
                      numberingConfig = { config: [ /* ... your default list config ... */ ] };
                 }
                 const listStyleRef = token.ordered ? "markdownNumbering" : "markdownBullet";
                 for (const item of token.items) {
                      // Lists contain 'list_item' tokens, which themselves contain 'paragraph' or other block tokens.
                      // We need to render the content of the list item.
                      // Assuming list items contain paragraph-like structures ('text', 'strong', etc.)
                      // marked often wraps list item content in a 'text' token which might have its own 'tokens'.
                      // Let's target the actual content tokens within the item.
                      let itemContentTokens = item.tokens;
                      // Sometimes marked wraps list item content in a paragraph token with loose: false
                      if (item.tokens.length === 1 && item.tokens[0].type === 'paragraph') {
                          itemContentTokens = item.tokens[0].tokens;
                      } else if (item.tokens.length === 1 && item.tokens[0].type === 'text' && item.tokens[0].tokens) {
                           itemContentTokens = item.tokens[0].tokens; // Handle nested tokens within text for list items
                      }

                      docxComponentsList.push(new Paragraph({
                           children: await renderTokensToDocx(itemContentTokens || [], [], numberingConfig), // Render inner tokens of the list item
                           numbering: { reference: listStyleRef, level: token.depth || 0 },
                           indent: { left: convertInchesToTwip(0.5 * (token.depth || 0)) }
                      }));
                 }
                 break;
            case 'code': // Code block
                // Split code into lines and create separate paragraphs for styling
                const codeLines = token.text.split('\n');
                codeLines.forEach(line => {
                     docxComponentsList.push(new Paragraph({
                           children: [new TextRun({ text: line, style: "codeFontStyle" })], // Apply font via style
                           style: "codeBlockStyle", // Apply background/spacing via style
                     }));
                });
                 docxComponentsList.push(new Paragraph("")); // Add spacing after code block
                break;
            case 'blockquote':
                  // Render inner tokens first
                  const blockquoteContent = await renderTokensToDocx(token.tokens, [], numberingConfig);
                  // Wrap the content in a paragraph with blockquote styling
                  docxComponentsList.push(new Paragraph({
                      children: blockquoteContent,
                      style: "blockquoteStyle", // Use a dedicated style if needed
                      indent: { left: convertInchesToTwip(0.5) }, // Or include indent in the style
                      spacing: { after: 100 }
                  }));
                  break;
            // --- Inline Tokens ---
            // These should return TextRun or ExternalHyperlink instances
            case 'strong': // Standard markdown bold
                const boldContent = await renderTokensToDocx(token.tokens, [], numberingConfig);
                boldContent.forEach(run => {
                    if (run instanceof TextRun) { run.properties.bold = true; } // Modify options directly
                });
                docxComponentsList.push(...boldContent);
                break;
            case 'em': // Standard markdown italics
                const italicContent = await renderTokensToDocx(token.tokens, [], numberingConfig);
                italicContent.forEach(run => {
                    if (run instanceof TextRun) { run.properties.italics = true; } // Modify options directly
                });
                docxComponentsList.push(...italicContent);
                break;
            case 'codespan':
                docxComponentsList.push(new TextRun({ text: token.text, style: "inlineCodeStyle" }));
                break;
            case 'link':
                 // Render link text tokens, which might include strong, em, etc.
                 const linkTextContent = await renderTokensToDocx(token.tokens, [], numberingConfig);
                 docxComponentsList.push(new ExternalHyperlink({
                     children: linkTextContent, // Use rendered TextRuns for link content
                     link: token.href,
                 }));
                 break;
            case 'image':
                // Represent image as placeholder text for DOCX
                docxComponentsList.push(new TextRun({ text: `[Image: ${token.alt || token.href || 'image'}]`, italics: true }));
                break;
            case 'text':
                // Make sure to handle potential nested tokens if marked produces them here
                if (token.tokens && token.tokens.length > 0) {
                     docxComponentsList.push(...await renderTokensToDocx(token.tokens, [], numberingConfig));
                } else {
                     // Replace potential multiple spaces with single space for cleaner DOCX
                     const cleanedText = token.text.replace(/ +/g, ' ');
                     docxComponentsList.push(new TextRun(cleanedText));
                }
                break;
             case 'html':
                 console.warn("Skipping raw HTML token for DOCX:", token.raw);
                 // Optionally render as plain text: docxComponentsList.push(new TextRun(token.raw));
                 break;
             case 'space':
                 // Usually handled by paragraph spacing, but can add a space TextRun if needed between inline elements
                 // docxComponentsList.push(new TextRun(" "));
                 break;
             case 'br': // Handle line breaks within paragraphs
                 docxComponentsList.push(new TextRun({ break: 1 }));
                 break;
             case 'del': // Strikethrough
                  const delContent = await renderTokensToDocx(token.tokens, [], numberingConfig);
                  delContent.forEach(run => {
                      if (run instanceof TextRun) { run.options.strike = true; }
                  });
                  docxComponentsList.push(...delContent);
                  break;
             default:
                 console.warn(`Unhandled DOCX token type: ${token.type}`);
                 // Attempt basic rendering if text exists
                 if(token.raw) { docxComponentsList.push(new TextRun(token.raw)); }
                 else if (token.tokens) { docxComponentsList.push(...await renderTokensToDocx(token.tokens, [], numberingConfig)); }
        }
    }
    return docxComponentsList; // Return the array of generated docx components (Paragraphs, TextRuns, etc.)
}


class DownloadGenerator {

    constructor() {
        // Can add configuration options here if needed later
        console.log("DownloadGenerator initialized.");
        // Configure marked (optional: customize if needed)
        // marked.setOptions({ ... });
    }

    // --- TXT Generation ---
    generateTxt(chatHistory, sessionId) {
        if (!chatHistory || chatHistory.length === 0) {
            throw new Error('No chat history provided for TXT generation.');
        }

        let formattedText = `Chat History - Session: ${sessionId}\n`;
        formattedText += "========================================\n\n";

        chatHistory.forEach((entry, index) => {
            formattedText += `Interaction ${index + 1}:\n`;
            formattedText += `You:\n${entry.prompt}\n\n`;
            if (entry.response) {
                // Basic cleanup for TXT: remove markdown-like formatting users might see
                const cleanResponse = entry.response
                    .replace(/`/g, '') // Remove backticks
                    .replace(/\*\*/g, '') // Remove double asterisks
                    .replace(/[*_]/g, ''); // Remove single asterisks/underscores
                formattedText += `Gemma:\n${cleanResponse}\n\n`;
            } else if (entry.error) {
                formattedText += `Error:\n${entry.error}\n\n`;
            }
            formattedText += "---\n\n";
        });

        return formattedText; // Return the string content
    }

    // --- DOCX Generation ---
    async generateDocx(chatHistory, sessionId) {
        if (!chatHistory || chatHistory.length === 0) {
            throw new Error('No chat history provided for DOCX generation.');
        }

        const docxSections = [];
        const numberingConfig = { // Define numbering/bullets for the document
             config: [
                  {
                       reference: "markdownNumbering", levels: [
                            { level: 0, format: "decimal", text: "%1.", alignment: AlignmentType.LEFT, style: { paragraph: { indent: { left: convertInchesToTwip(0.25), hanging: convertInchesToTwip(0.25) } } } },
                            { level: 1, format: "lowerLetter", text: "%2)", alignment: AlignmentType.LEFT, style: { paragraph: { indent: { left: convertInchesToTwip(0.5), hanging: convertInchesToTwip(0.25) } } } },
                            { level: 2, format: "lowerRoman", text: "%3.", alignment: AlignmentType.LEFT, style: { paragraph: { indent: { left: convertInchesToTwip(0.75), hanging: convertInchesToTwip(0.25) } } } },
                            // Add more levels if needed
                       ],
                  },{
                       reference: "markdownBullet", levels: [
                            { level: 0, format: "bullet", text: "\u2022", alignment: AlignmentType.LEFT, style: { paragraph: { indent: { left: convertInchesToTwip(0.25), hanging: convertInchesToTwip(0.25) } } } },
                            { level: 1, format: "bullet", text: "\u25E6", alignment: AlignmentType.LEFT, style: { paragraph: { indent: { left: convertInchesToTwip(0.5), hanging: convertInchesToTwip(0.25) } } } },
                            { level: 2, format: "bullet", text: "\u25AA", alignment: AlignmentType.LEFT, style: { paragraph: { indent: { left: convertInchesToTwip(0.75), hanging: convertInchesToTwip(0.25) } } } },
                            // Add more levels if needed
                       ],
                  }]
             };

        // Add title
        docxSections.push(
            new Paragraph({ heading: HeadingLevel.TITLE, alignment: AlignmentType.CENTER, children: [new TextRun(`Chat History - Session ${sessionId}`)] })
        );
        docxSections.push(new Paragraph(" ")); // Spacer

        for (const [index, entry] of chatHistory.entries()) {
            // User Prompt
            docxSections.push(new Paragraph({ heading: HeadingLevel.HEADING_2, children: [new TextRun(`Interaction ${index + 1}: You`)], spacing: { before: 240, after: 120 } }));
            // Split prompt by lines and create separate paragraphs if needed, or keep as one block
            const promptLines = entry.prompt.split('\n');
             // Simple prompt rendering: one paragraph per line
             promptLines.forEach(line => {
                  if (line.trim()) { // Avoid adding paragraphs for empty lines if desired
                       docxSections.push(new Paragraph({ children: [new TextRun(line)] }));
                  } else {
                       docxSections.push(new Paragraph("")); // Keep empty lines as empty paragraphs
                  }
             });
             docxSections.push(new Paragraph(" ")); // Spacer after prompt block

            // Gemma Response / Error
            if (entry.response) {
                docxSections.push(new Paragraph({ heading: HeadingLevel.HEADING_2, children: [new TextRun("Gemma:")], spacing: { after: 120 } }));
                const tokens = marked.lexer(entry.response); // Use lexer to get token stream
                // console.log("Tokens:", JSON.stringify(tokens, null, 2)); // Debug: See the tokens
                const renderedComponents = await renderTokensToDocx(tokens, [], numberingConfig);
                // console.log("Rendered Components (Before Custom Bold):", renderedComponents); // Debug

                // --- Apply Custom Bold Formatting ---
                const processedComponents = renderedComponents.map(component => {
                    if (component instanceof Paragraph) {
                         // Apply the custom bold logic to each paragraph generated from the markdown
                         return applyCustomBoldToParagraph(component);
                    }
                    // Return non-paragraph components (like standalone TextRuns if any) as is
                    return component;
                });
                // console.log("Processed Components (After Custom Bold):", processedComponents); // Debug

                docxSections.push(...processedComponents);

            } else if (entry.error) {
                docxSections.push(new Paragraph({ heading: HeadingLevel.HEADING_2, children: [new TextRun({ text: "Error:", bold: true })], spacing: { after: 120 } }));
                 const errorLines = entry.error.split('\n');
                 errorLines.forEach(line => {
                      docxSections.push(new Paragraph({ children: [new TextRun({ text: line, color: "FF0000" })] }));
                 });
            }
            // Separator between interactions (optional)
            // docxSections.push(new Paragraph({ text: "---", alignment: AlignmentType.CENTER })); // Maybe too much?
            docxSections.push(new Paragraph(" ")); // Add space before next interaction
        }

        // --- Define Styles ---
        const docStyles = {
             paragraphStyles: [
                  {
                       id: "codeBlockStyle", name: "Code Block Style", basedOn: "Normal", next: "Normal",
                       paragraph: {
                            spacing: { before: 100, after: 100 },
                            shading: { type: ShadingType.CLEAR, color: "auto", fill: "F0F0F0" }, // Light grey background
                            // Consider adding indentation or borders if desired
                            // indent: { left: convertInchesToTwip(0.2) },
                       },
                       run: { // Default run style for code block (can be overridden by char style)
                           // Font defined in character style below is usually preferred
                       }
                  },
                   {
                       id: "blockquoteStyle", name: "Blockquote Style", basedOn: "Normal", next: "Normal",
                       paragraph: {
                           indent: { left: convertInchesToTwip(0.5) },
                           spacing: { before: 80, after: 80 },
                           // Optional: Add a border
                           // border: { left: { style: BorderStyle.SINGLE, size: 6, color: "C0C0C0" } },
                       },
                       run: {
                           italics: true, // Example: style blockquotes as italic
                           // color: "595959", // Example: slightly muted color
                       }
                   },
                   // Heading styles are usually defined by default, but can be customized
                   { id: "Heading1", name: "Heading 1", basedOn: "Normal", next: "Normal", quickFormat: true, run: { size: 32, bold: true }, paragraph: { spacing: { before: 240, after: 120 } } },
                   { id: "Heading2", name: "Heading 2", basedOn: "Normal", next: "Normal", quickFormat: true, run: { size: 28, bold: true }, paragraph: { spacing: { before: 200, after: 100 } } },
                   // Add other heading levels (Heading3, etc.) if needed
             ],
             characterStyles: [
                  {
                       id: "codeFontStyle", name: "Code Font", basedOn: "DefaultParagraphFont",
                       run: { font: { name: "Consolas", // Use a common monospace font
                                      hint: "eastAsia" // Hint helps Word choose correct font variations
                                    },
                              size: 19 } // Size 9.5pt (19 half-points)
                  },
                  {
                       id: "inlineCodeStyle", name: "Inline Code", basedOn: "DefaultParagraphFont",
                       run: {
                            font: { name: "Consolas", hint: "eastAsia" },
                            size: 19, // 9.5pt
                            // Optional: Add subtle background shading to inline code
                            // shading: { type: ShadingType.CLEAR, color: "auto", fill: "F5F5F5" }
                       }
                  },
                  // Default Hyperlink style (Word usually provides one, but can override)
                  // { id: "Hyperlink", name: "Hyperlink", basedOn: "DefaultParagraphFont", run: { color: "0563C1", underline: { type: UnderlineType.SINGLE } } }
             ],
             default: { // Define document defaults
                  heading1: { run: { size: 32, bold: true, color: "2E74B5" }, paragraph: { spacing: { before: 240, after: 120 } } },
                  heading2: { run: { size: 28, bold: true, color: "2E74B5" }, paragraph: { spacing: { before: 200, after: 100 } } },
                  // Define defaults for lists if needed, although the numbering config handles specifics
             }
        };


        // --- Create Document ---
        const doc = new Document({
            creator: "YourAppName", // Optional: Add creator metadata
            title: `Chat History - Session ${sessionId}`, // Optional: Add title metadata
            description: "Chat history generated from the application.", // Optional
            styles: docStyles,
            numbering: numberingConfig, // Use the defined numbering config
            sections: [{
                properties: {}, // Default section properties
                children: docxSections // Add all collected paragraphs and components
            }],
        });

        // Generate and return buffer
        const buffer = await Packer.toBuffer(doc);
        return buffer;
    }

    // --- PDF Generation ---
    async generatePdf(chatHistory, sessionId, cssPath) {
        if (!chatHistory || chatHistory.length === 0) {
            throw new Error('No chat history provided for PDF generation.');
        }
        if (!cssPath) {
            console.warn('[PDF Gen] CSS file path not provided. PDF will have minimal styling.');
            // Consider providing a default minimal CSS string here if cssPath is optional
        }

        let browser = null;
        try {
            // --- 1. Generate HTML Content ---
            let cssContent = '';
            if (cssPath) {
                try {
                    cssContent = await fs.readFile(cssPath, 'utf8');
                } catch (cssError) {
                    console.error(`[PDF Gen] WARNING: Could not read CSS file at ${cssPath}. PDF will be unstyled. Error: ${cssError.message}`);
                }
            }

            // Basic default styles if CSS fails or isn't provided
            const defaultStyles = `
                body { font-family: sans-serif; max-width: 800px; margin: 30px auto; line-height: 1.6; }
                h1 { text-align: center; border-bottom: 1px solid #ccc; padding-bottom: 10px; }
                .history-entry { margin-bottom: 25px; padding-bottom: 15px; border-bottom: 1px solid #eee; }
                .history-prompt strong, .history-response strong, .history-error strong { display: block; margin-bottom: 5px; font-size: 1.1em; }
                pre { white-space: pre-wrap !important; word-wrap: break-word !important; background-color: #f4f4f4; padding: 10px; border-radius: 4px; border: 1px solid #ddd; font-family: monospace; }
                .history-prompt pre { background-color: #e9e9e9; }
                .history-response div { padding: 5px; border-radius: 3px; } /* Basic container for parsed markdown */
                .history-error pre { background-color: #fdd; color: #800; border-color: #fbb; }
                /* Add basic markdown element styling for PDF */
                code { background-color: #eee; padding: 0.2em 0.4em; margin: 0; font-size: 85%; border-radius: 3px; font-family: monospace; }
                pre code { background-color: transparent; padding: 0; margin: 0; font-size: inherit; border-radius: 0; } /* Reset style for code inside pre */
                blockquote { border-left: 3px solid #ccc; padding-left: 10px; color: #555; margin-left: 0; }
                ul, ol { padding-left: 20px; }
                table { border-collapse: collapse; width: 100%; margin-bottom: 1em; }
                th, td { border: 1px solid #ddd; padding: 8px; text-align: left; }
                th { background-color: #f2f2f2; }
            `;

            // Build HTML string
            let htmlString = `
                <!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"><title>Chat History - ${sessionId}</title>
                <style>${defaultStyles} ${cssContent /* Provided CSS will override defaults */}</style>
                </head><body><h1>Chat History - Session ${sessionId}</h1>`; // Removed <hr>, added styling via CSS

            chatHistory.forEach((entry, index) => {
                 // Using classes for easier CSS targeting
                htmlString += `<div class="history-entry">`;
                htmlString += `<div class="history-prompt"><strong>Interaction ${index + 1}: You</strong><pre>${escape(entry.prompt)}</pre></div>`; // Wrap prompt in pre for formatting
                if (entry.response) {
                    // Use marked to parse the response for richer PDF output
                    const parsedResponse = marked.parse(entry.response);
                    htmlString += `<div class="history-response"><strong>Gemma:</strong><div>${parsedResponse}</div></div>`; // Wrap parsed response in a div
                } else if (entry.error) {
                    htmlString += `<div class="history-error"><strong>Error:</strong><pre>${escape(entry.error)}</pre></div>`; // Wrap error in pre
                }
                htmlString += `</div>`; // Close history-entry
            });
            htmlString += `</body></html>`;

            // --- 2. Use Puppeteer to Generate PDF ---
            // Use PUPPETEER_EXECUTABLE_PATH env var if running in restricted envs like Cloud Functions
            const executablePath = process.env.PUPPETEER_EXECUTABLE_PATH;
            browser = await puppeteer.launch({
                 args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'], // Common args for server environments
                 executablePath: executablePath, // Undefined is fine if not set
            });
            const page = await browser.newPage();

            // Set content and wait for rendering/network activity to settle
            await page.setContent(htmlString, { waitUntil: 'networkidle0' });

             // Wait for fonts to load if necessary (adjust timeout as needed)
             try {
                  await page.waitForFunction('document.fonts.ready');
             } catch(e) {
                  console.warn("Timeout waiting for document.fonts.ready, proceeding anyway.");
             }

             // Optional: Emulate screen media type if CSS relies on it
             // await page.emulateMediaType('screen');

            const pdfBuffer = await page.pdf({
                format: 'A4',
                printBackground: true, // Crucial for background colors/styles
                margin: { top: '25mm', right: '20mm', bottom: '25mm', left: '20mm' },
                // Consider adding header/footer templates if needed
                // displayHeaderFooter: true,
                // headerTemplate: `<div style="font-size: 9px; margin: 0 auto;">Header - ${sessionId}</div>`,
                // footerTemplate: `<div style="font-size: 9px; margin: 0 auto;">Page <span class="pageNumber"></span> of <span class="totalPages"></span></div>`,
            });

            await browser.close(); // Close browser immediately after getting buffer
            browser = null; // Ensure it's nullified

            return pdfBuffer;

        } catch (error) {
            console.error(`[PDF Generation Error] Failed for session ${sessionId}:`, error);
            // Ensure browser is closed if an error occurred mid-process
            if (browser !== null) {
                try {
                    await browser.close();
                } catch (closeError) {
                    console.error("Error closing browser after PDF generation failed:", closeError);
                }
            }
            // Re-throw a more informative error
            throw new Error(`PDF Generation Failed: ${error.message}`);
        }
    }
}

// Export the class
export default DownloadGenerator;