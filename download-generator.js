// download-generator.js
import { marked } from 'marked';
import * as fs from 'fs/promises';
import path from 'path';
import { escape } from 'html-escaper';
import puppeteer from 'puppeteer';
import {
    Document, Packer, Paragraph, TextRun, HeadingLevel, AlignmentType,
    ExternalHyperlink, ShadingType, Numbering, Indent, convertInchesToTwip
} from 'docx';

// Helper function to convert Markdown tokens to DOCX components (kept within the module scope)
// (This function remains the same as provided in the previous step)
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
                docxComponentsList.push(new Paragraph({
                    children: await renderTokensToDocx(token.tokens, [], numberingConfig),
                    spacing: { after: 100 }
                }));
                break;
            case 'list':
                 if (!numberingConfig) {
                      numberingConfig = { /* ... default config ... */ }; // Should ideally be passed in or configured once
                 }
                 const listStyleRef = token.ordered ? "markdownNumbering" : "markdownBullet";
                 for (const item of token.items) {
                     docxComponentsList.push(new Paragraph({
                        children: await renderTokensToDocx(item.tokens, [], numberingConfig),
                        numbering: { reference: listStyleRef, level: token.depth || 0 },
                        indent: { left: convertInchesToTwip(0.5 * (token.depth || 0)) }
                     }));
                 }
                break;
            case 'code': // Code block
                docxComponentsList.push(new Paragraph({
                    text: token.text,
                    style: "codeStyle",
                    spacing: { after: 100 }
                }));
                break;
             case 'blockquote':
                  const blockquoteContent = await renderTokensToDocx(token.tokens, [], numberingConfig);
                  docxComponentsList.push(new Paragraph({
                        children: blockquoteContent,
                        indent: { left: convertInchesToTwip(0.5) },
                        spacing: { after: 100 }
                  }));
                 break;
            // --- Inline Tokens ---
            case 'strong':
                 const boldContent = await renderTokensToDocx(token.tokens, [], numberingConfig);
                 boldContent.forEach(run => run.properties.bold = true);
                 docxComponentsList.push(...boldContent);
                 break;
             case 'em':
                 const italicContent = await renderTokensToDocx(token.tokens, [], numberingConfig);
                 italicContent.forEach(run => run.properties.italics = true);
                 docxComponentsList.push(...italicContent);
                 break;
            case 'codespan':
                docxComponentsList.push(new TextRun({ text: token.text, style: "inlineCodeStyle" }));
                break;
            case 'link':
                  docxComponentsList.push(new ExternalHyperlink({
                    children: [ new TextRun({ text: token.text || token.href, style: "Hyperlink" }) ],
                    link: token.href,
                  }));
                 break;
             case 'image':
                 docxComponentsList.push(new TextRun({ text: `[Image: ${token.text || token.href}]`, italics: true }));
                 break;
            case 'text':
                docxComponentsList.push(new TextRun(token.text));
                break;
            case 'html':
                 console.warn("Skipping raw HTML token for DOCX:", token.text);
                 break;
             case 'space':
                 break;
            default:
                console.warn(`Unhandled DOCX token type: ${token.type}`);
                if(token.text) { docxComponentsList.push(new TextRun(token.text)); }
                else if (token.tokens) { docxComponentsList.push(...await renderTokensToDocx(token.tokens, [], numberingConfig)); }
        }
    }
    return docxComponentsList;
}


class DownloadGenerator {

    constructor() {
        // Can add configuration options here if needed later
        console.log("DownloadGenerator initialized.");
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
                formattedText += `Gemma:\n${entry.response}\n\n`;
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
            config: [/* ... same config as before ... */
             {
                 reference: "markdownNumbering", levels: [
                     { level: 0, format: "decimal", text: "%1.", alignment: AlignmentType.LEFT, style: { paragraph: { indent: { left: 720, hanging: 360 } } } },
                     { level: 1, format: "lowerLetter", text: "%2.", alignment: AlignmentType.LEFT, style: { paragraph: { indent: { left: 1440, hanging: 360 } } } },
                 ],
             },{
                 reference: "markdownBullet", levels: [
                     { level: 0, format: "bullet", text: "\u2022", alignment: AlignmentType.LEFT, style: { paragraph: { indent: { left: 720, hanging: 360 } } } },
                     { level: 1, format: "bullet", text: "\u25E6", alignment: AlignmentType.LEFT, style: { paragraph: { indent: { left: 1440, hanging: 360 } } } },
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
            docxSections.push(new Paragraph({ heading: HeadingLevel.HEADING_2, children: [new TextRun(`Interaction ${index + 1}: You`)], spacing: { before: 200 } }));
            entry.prompt.split('\n').forEach(line => { docxSections.push(new Paragraph({ children: [new TextRun(line)] })); });
            docxSections.push(new Paragraph(" "));

            // Gemma Response / Error
            if (entry.response) {
                docxSections.push(new Paragraph({ heading: HeadingLevel.HEADING_2, children: [new TextRun("Gemma:")] }));
                const tokens = marked.lexer(entry.response);
                const renderedComponents = await renderTokensToDocx(tokens, [], numberingConfig);
                docxSections.push(...renderedComponents);
            } else if (entry.error) {
                docxSections.push(new Paragraph({ heading: HeadingLevel.HEADING_2, children: [new TextRun({ text: "Error:", bold: true })] }));
                entry.error.split('\n').forEach(line => { docxSections.push(new Paragraph({ children: [new TextRun({ text: line, color: "FF0000" })] })); });
            }
            docxSections.push(new Paragraph({ text: "---", alignment: AlignmentType.CENTER }));
            docxSections.push(new Paragraph(" "));
        }

        // Create document
        const doc = new Document({
            styles: { /* ... same styles config as before ... */
                 paragraphStyles: [{
                     id: "codeStyle", name: "Code Block Style", basedOn: "Normal", next: "Normal",
                     run: { font: "Courier New", size: 20 },
                     paragraph: { spacing: { before: 100, after: 100 }, shading: { type: ShadingType.CLEAR, color: "auto", fill: "F0F0F0" } },
                 }],
                  characterStyles: [{
                    id: "inlineCodeStyle", name: "Inline Code Style", basedOn: "DefaultParagraphFont",
                    run: { font: "Courier New", size: 20 },
                 }],
             },
            numbering: numberingConfig,
            sections: [{ properties: {}, children: docxSections }],
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
            throw new Error('CSS file path is required for PDF generation.');
        }

        let browser = null;
        try {
            // --- 1. Generate HTML Content ---
            let cssContent = '';
            try {
                cssContent = await fs.readFile(cssPath, 'utf8');
            } catch (cssError) {
                console.error(`[PDF Gen] WARNING: Could not read CSS file at ${cssPath}. PDF will be unstyled.`, cssError);
            }

            // Build HTML string (same logic as before)
            let htmlString = `
                <!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"><title>Chat History - ${sessionId}</title>
                <style>${cssContent} body { max-width: 90%; margin: 20px auto; } pre { white-space: pre-wrap !important; word-wrap: break-word !important; }</style>
                </head><body class="light-theme"><h1>Chat History - Session ${sessionId}</h1><hr>`;

            chatHistory.forEach((entry, index) => {
                htmlString += `<div class="history-entry" style="margin-bottom: 15px; padding-bottom: 10px; border-bottom: 1px solid #eee;"><div class="history-prompt" style="margin-bottom: 10px;"><strong>Interaction ${index + 1}: You</strong><pre style="white-space: pre-wrap; word-wrap: break-word; background: #f0f0f0; padding: 5px; border-radius: 3px;">${escape(entry.prompt)}</pre></div>`;
                if (entry.response) {
                    htmlString += `<div class="history-response result-box" style="border: none; padding: 0;"><strong>Gemma:</strong><div style="padding: 5px; border-radius: 3px; background: #f9f9f9;">${marked.parse(entry.response)}</div></div>`;
                } else if (entry.error) {
                    htmlString += `<div class="history-error error-box" style="margin-top: 10px;"><strong>Error:</strong><pre style="white-space: pre-wrap; word-wrap: break-word;">${escape(entry.error)}</pre></div>`;
                }
                htmlString += `</div>`;
            });
            htmlString += `</body></html>`;

            // --- 2. Use Puppeteer to Generate PDF ---
            browser = await puppeteer.launch({ args: ['--no-sandbox', '--disable-setuid-sandbox'] });
            const page = await browser.newPage();
            await page.setContent(htmlString, { waitUntil: 'networkidle0' });
            const pdfBuffer = await page.pdf({ format: 'A4', printBackground: true, margin: { top: '20mm', right: '20mm', bottom: '20mm', left: '20mm' } });
            await browser.close(); // Close browser immediately after getting buffer
            browser = null; // Ensure it's nullified

            return pdfBuffer;

        } catch (error) {
            // Ensure browser is closed if an error occurred mid-process
            if (browser !== null) {
                await browser.close();
            }
            // Re-throw the error to be caught by the route handler
            throw new Error(`PDF Generation Failed: ${error.message}`);
        }
    }
}

// Export the class
export default DownloadGenerator;