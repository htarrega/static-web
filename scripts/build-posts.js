#!/usr/bin/env node

const fs = require('fs');
const path = require('path');

/**
 * Simple markdown to HTML converter
 * Handles basic markdown syntax
 */
function markdownToHtml(markdown) {
    let html = markdown;

    // Extract fenced code blocks before any other processing
    const codeBlocks = [];
    html = html.replace(/```[\w]*\n([\s\S]*?)```/g, (match, code) => {
        const escaped = code
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;');
        const placeholder = `\x00CODEBLOCK${codeBlocks.length}\x00`;
        codeBlocks.push(`<pre><code>${escaped}</code></pre>`);
        return placeholder;
    });

    // Inline code
    html = html.replace(/`([^`]+)`/g, (match, code) => {
        const escaped = code
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;');
        return `<code>${escaped}</code>`;
    });

    // Headers
    html = html.replace(/^### (.*$)/gim, '<h3>$1</h3>');
    html = html.replace(/^## (.*$)/gim, '<h2>$1</h2>');
    html = html.replace(/^# (.*$)/gim, '<h1>$1</h1>');

    // Bold
    html = html.replace(/\*\*(.*?)\*\*/gim, '<strong>$1</strong>');

    // Italic
    html = html.replace(/\*(.*?)\*/gim, '<em>$1</em>');

    // Links
    html = html.replace(/\[([^\]]+)\]\(([^)]+)\)/gim, '<a href="$2" target="_blank">$1</a>');

    // Paragraphs (split by double newline)
    const lines = html.split('\n');
    let inParagraph = false;
    let inTable = false;
    let result = [];

    for (let i = 0; i < lines.length; i++) {
        const line = lines[i].trim();
        const isTableRow = line.startsWith('|') && line.endsWith('|');
        const isSeparatorRow = isTableRow && /^\|[\s\-|]+\|$/.test(line);

        if (isTableRow) {
            if (inParagraph) {
                result.push('</p>');
                inParagraph = false;
            }
            if (!inTable) {
                result.push('<table>');
                inTable = true;
            }
            if (isSeparatorRow) {
                // skip separator row
            } else {
                const cells = line.split('|').map(c => c.trim()).filter(c => c !== '');
                const tag = (inTable && result.filter(r => r === '<tr>').length === 0) ? 'th' : 'td';
                result.push('<tr>');
                cells.forEach(cell => result.push(`<${tag}>${cell}</${tag}>`));
                result.push('</tr>');
            }
        } else {
            if (inTable) {
                result.push('</table>');
                inTable = false;
            }

            if (line === '') {
                if (inParagraph) {
                    result.push('</p>');
                    inParagraph = false;
                }
            } else if (line.startsWith('<h') || line.startsWith('<div') || line.startsWith('\x00CODEBLOCK')) {
                if (inParagraph) {
                    result.push('</p>');
                    inParagraph = false;
                }
                result.push(line);
            } else {
                if (!inParagraph) {
                    result.push('<p>');
                    inParagraph = true;
                } else if (inParagraph && result[result.length - 1] !== '<p>') {
                    result.push(' ');
                }
                result.push(line);
            }
        }
    }

    if (inTable) result.push('</table>');


    if (inParagraph) {
        result.push('</p>');
    }

    let output = result.join('\n');

    // Restore code blocks
    codeBlocks.forEach((block, i) => {
        output = output.replace(`\x00CODEBLOCK${i}\x00`, block);
    });

    return output;
}

/**
 * Parse front matter and bilingual content from markdown file
 */
function parseFrontMatter(content) {
    // Remove leading empty lines
    content = content.replace(/^\s*\n+/, '');

    // Support table format: | Field | Content | followed by ***
    const tableRegex = /^\| Field\s+\| Content\s+\|\n\| -+\s+\| -+\s+\|\n((?:\|.*\|.*\n)+)\*\*\*\n([\s\S]*)$/;

    const match = content.match(tableRegex);

    if (!match) {
        throw new Error('No front matter found. Articles must start with a table format:\n| Field | Content |\n| ----- | ------- |\n| Title | ... |\n***');
    }

    const frontMatter = {};
    const tableRows = match[1].trim().split('\n');

    tableRows.forEach(row => {
        // Parse table row: | Field | Content |
        const cells = row.split('|').map(cell => cell.trim()).filter(cell => cell);
        if (cells.length === 2) {
            const key = cells[0].toLowerCase();
            const value = cells[1];
            frontMatter[key] = value;
        }
    });

    const bodyContent = match[2].trim();

    // Check for bilingual content (Spanish first, then ## [ENG] marker)
    const bilingualMarker = /^## \[ENG\]$/m;
    let spanishContent = bodyContent;
    let englishContent = null;

    if (bilingualMarker.test(bodyContent)) {
        const parts = bodyContent.split(bilingualMarker);
        spanishContent = parts[0].trim();
        englishContent = parts[1] ? parts[1].trim() : null;
    } else {
        // If no [ENG] marker, treat as Spanish-only
        englishContent = null;
    }

    return { frontMatter, spanishContent, englishContent };
}

/**
 * Generate HTML template for article
 */
function generateHtmlPage(frontMatter, spanishHtml, englishHtml, filename) {
    const slug = filename.replace('.md', '');
    const isBilingual = englishHtml !== null;

    // Language toggle HTML (only if bilingual) - Spanish first
    const languageToggleHtml = isBilingual ? `
        <div class="language-toggle">
            <button class="lang-btn active" onclick="switchLanguage('es')">Español</button>
            <button class="lang-btn" onclick="switchLanguage('en')">English</button>
        </div>` : '';

    // Content HTML - Spanish first (active by default)
    const contentHtml = isBilingual ? `
        <div id="es-content" class="lang-section active">
            ${spanishHtml}
        </div>

        <div id="en-content" class="lang-section">
            ${englishHtml}
        </div>` : spanishHtml;

    // Language switch script (only if bilingual)
    const languageScript = isBilingual ? `
    <script>
        function switchLanguage(lang) {
            document.getElementById('en-content').classList.remove('active');
            document.getElementById('es-content').classList.remove('active');

            document.querySelectorAll('.lang-btn').forEach(btn => btn.classList.remove('active'));

            if (lang === 'es') {
                document.getElementById('es-content').classList.add('active');
                document.querySelectorAll('.lang-btn')[0].classList.add('active');
            } else {
                document.getElementById('en-content').classList.add('active');
                document.querySelectorAll('.lang-btn')[1].classList.add('active');
            }
        }
    </script>` : '';

    return `<!DOCTYPE html>
<html lang="en">

<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <meta name="description" content="${frontMatter.excerpt || ''}" />
    <meta name="twitter:card" content="summary" />
    <meta name="twitter:site" content="@htarrega" />
    <link rel="canonical" href="http://htarrega.me/posts/${slug}.html" />
    <link rel="icon" href="../favicon/favicon.png" type="image/png">
    <link rel="apple-touch-icon" href="../favicon/apple-touch-icon.png">
    <link rel="stylesheet" href="../styles.css">
    <link rel="stylesheet" href="../post.css">
    <title>${frontMatter.title} - Hugo Tárrega</title>
</head>

<body>
    <nav>
        <ul>
            <li><a href="../index.html">[htarrega.me]</a></li>
            <li><a href="../cv.html">[cv]</a></li>
            <li><a href="../bookshelf.html">[bookshelf]</a></li>
            <li><a href="../posts.html">[posts]</a></li>
        </ul>
    </nav>
    <div id="maincontent">
        <h1>${frontMatter.title}</h1>
        <div class="post-meta">${frontMatter.date}</div>
        ${languageToggleHtml}
        ${contentHtml}
    </div>
${languageScript}
</body>

</html>`;
}

/**
 * Main build function
 */
function buildPosts() {
    const draftsDir = path.join(__dirname, '..', 'posts', 'drafts');
    const postsDir = path.join(__dirname, '..', 'posts');
    const postsJsonPath = path.join(__dirname, '..', 'resources', 'posts.json');

    // Check if drafts directory exists
    if (!fs.existsSync(draftsDir)) {
        console.error('Error: posts/drafts directory does not exist');
        process.exit(1);
    }

    // Read all markdown files
    const files = fs.readdirSync(draftsDir).filter(f => f.endsWith('.md'));

    if (files.length === 0) {
        console.log('No markdown files found in posts/drafts/');
        return;
    }

    const postsMetadata = [];

    // Process each markdown file
    files.forEach(file => {
        console.log(`Processing ${file}...`);

        const filePath = path.join(draftsDir, file);
        const content = fs.readFileSync(filePath, 'utf8');

        try {
            // Parse front matter and bilingual markdown
            const { frontMatter, spanishContent, englishContent } = parseFrontMatter(content);

            // Validate required fields
            if (!frontMatter.title || !frontMatter.date || !frontMatter.excerpt) {
                throw new Error('Missing required front matter fields: title, date, or excerpt');
            }

            // Convert markdown to HTML for both languages
            const spanishHtml = markdownToHtml(spanishContent);
            const englishHtml = englishContent ? markdownToHtml(englishContent) : null;

            // Generate full HTML page
            const htmlPage = generateHtmlPage(frontMatter, spanishHtml, englishHtml, file);

            // Write HTML file
            const slug = file.replace('.md', '');
            const htmlPath = path.join(postsDir, `${slug}.html`);
            fs.writeFileSync(htmlPath, htmlPage, 'utf8');

            // Add to metadata
            postsMetadata.push({
                title: frontMatter.title,
                date: frontMatter.date,
                excerpt: frontMatter.excerpt,
                url: `posts/${slug}.html`
            });

            console.log(`✓ Generated ${slug}.html`);
        } catch (error) {
            console.error(`Error processing ${file}: ${error.message}`);
            process.exit(1);
        }
    });

    // Sort by date descending, then by title ascending as tiebreaker
    postsMetadata.sort((a, b) => {
        const dateDiff = new Date(b.date) - new Date(a.date);
        if (dateDiff !== 0) return dateDiff;
        return a.title.localeCompare(b.title);
    });

    // Write posts.json
    fs.writeFileSync(postsJsonPath, JSON.stringify(postsMetadata, null, 2), 'utf8');
    console.log(`✓ Updated posts.json with ${postsMetadata.length} posts`);

    console.log('\n✓ Build complete!');
}

// Run the build
buildPosts();
