#!/usr/bin/env node

const fs = require('fs');
const path = require('path');

/**
 * Simple markdown to HTML converter
 * Handles basic markdown syntax
 */
function markdownToHtml(markdown) {
    let html = markdown;

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
    let result = [];

    for (let i = 0; i < lines.length; i++) {
        const line = lines[i].trim();

        if (line === '') {
            if (inParagraph) {
                result.push('</p>');
                inParagraph = false;
            }
        } else if (line.startsWith('<h') || line.startsWith('<div')) {
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

    if (inParagraph) {
        result.push('</p>');
    }

    return result.join('\n');
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

    // Language toggle HTML and styles (only if bilingual) - Spanish first
    const languageToggleHtml = isBilingual ? `
        <div class="language-toggle">
            <button class="lang-btn active" onclick="switchLanguage('es')">Español</button>
            <button class="lang-btn" onclick="switchLanguage('en')">English</button>
        </div>` : '';

    const languageStyles = isBilingual ? `
        .language-toggle {
            display: flex;
            gap: 10px;
            margin-bottom: 20px;
        }

        .lang-btn {
            background-color: black;
            color: white;
            border: 1px solid white;
            padding: 8px 15px;
            cursor: pointer;
            font-size: 14px;
            text-decoration: none;
            transition: all 0.2s;
        }

        .lang-btn:hover {
            background-color: rgb(0, 172, 75);
            color: black;
            border-color: rgb(0, 172, 75);
        }

        .lang-btn.active {
            background-color: white;
            color: black;
            border-color: white;
        }

        .lang-section {
            display: none;
        }

        .lang-section.active {
            display: block;
        }` : '';

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
    <style>
        body {
            font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", sans-serif;
            line-height: 1.6;
            font-size: 17px;
            padding: 0 10px;
            margin: 50px auto;
            max-width: 650px;
            background-color: black;
            color: white;
        }

        #maincontent {
            max-width: 42em;
            margin: 15px auto;
            margin-top: 70px;
        }

        h1 {
            font-size: 28px;
            font-weight: 700;
            margin-bottom: 8px;
        }

        h2 {
            font-size: 24px;
            font-weight: 600;
            margin-top: 30px;
            margin-bottom: 15px;
        }

        h3 {
            font-size: 20px;
            font-weight: 600;
            margin-top: 25px;
            margin-bottom: 12px;
        }

        .post-meta {
            font-size: 14px;
            color: rgb(120, 120, 120);
            margin-bottom: 30px;
            padding-bottom: 20px;
            border-bottom: 1px solid rgb(50, 50, 50);
        }

        a {
            color: white;
            text-decoration: underline;
        }

        a:hover {
            color: rgb(0, 172, 75);
            text-decoration: none;
        }

        a:visited {
            color: white;
        }

        a:active {
            color: rgb(0, 172, 75);
        }

        nav {
            position: fixed;
            top: 0;
            left: 0;
            right: 0;
            background-color: black;
            padding: 10px 0;
            z-index: 1000;
        }

        nav ul {
            list-style: none;
            display: flex;
            justify-content: center;
            gap: 30px;
            margin: 0;
            padding: 0;
            max-width: 650px;
            margin: 0 auto;
            padding: 10px;
        }

        nav a {
            text-decoration: none;
            font-size: 16px;
        }

        nav a:hover {
            color: rgb(0, 172, 75);
        }

        p {
            margin-bottom: 16px;
            line-height: 1.8;
        }

        strong {
            font-weight: 600;
        }

        em {
            font-style: italic;
        }
${languageStyles}
    </style>
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

    // Sort by date (newest first) - simple string comparison works for "Month YYYY" format
    postsMetadata.sort((a, b) => {
        const dateA = new Date(a.date);
        const dateB = new Date(b.date);
        return dateB - dateA;
    });

    // Write posts.json
    fs.writeFileSync(postsJsonPath, JSON.stringify(postsMetadata, null, 2), 'utf8');
    console.log(`✓ Updated posts.json with ${postsMetadata.length} posts`);

    console.log('\n✓ Build complete!');
}

// Run the build
buildPosts();
