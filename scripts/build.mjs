import { mkdir, readdir, readFile, writeFile, cp, rm, stat } from 'node:fs/promises';
import { basename } from 'node:path';

const postsDir = new URL('../content/posts/', import.meta.url);
const out = new URL('../dist/', import.meta.url);
const escapeHtml = (value) => String(value).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const slugify = (name) => name.toLowerCase().replace(/[^a-z0-9\u4e00-\u9fff]+/g, '-').replace(/^-|-$/g, '');

function inline(source, prefix) {
  const tokens = [];
  let text = escapeHtml(source);
  const save = (html) => `@@TOKEN${tokens.push(html) - 1}@@`;
  text = text.replace(/!\[([^\]]*)\]\(([^)]+)\)/g, (_, alt, src) => save(image(src, alt, prefix)));
  text = text.replace(/\[([^\]]+)\]\((https?:\/\/[^)]+)\)/g, (_, label, url) => save(`<a href="${url}" rel="noopener noreferrer">${label}</a>`));
  text = text.replace(/`([^`]+)`/g, '<code>$1</code>');
  text = text.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  text = text.replace(/\*([^*]+)\*/g, '<em>$1</em>');
  return text.replace(/@@TOKEN(\d+)@@/g, (_, n) => tokens[Number(n)]);
}

function image(src, alt, prefix) {
  if (!/^photo\/[a-zA-Z0-9._-]+\.(?:png|jpe?g|webp|gif|avif|svg)$/i.test(src)) {
    throw new Error(`图片路径不受支持：${src}。请将图片放在 photo/，并使用 photo/文件名.png 这样的路径。`);
  }
  return `<img src="${prefix}${escapeHtml(src)}" alt="${escapeHtml(alt)}" loading="lazy">`;
}

async function validateImages(source, name) {
  const refs = [
    ...source.matchAll(/!\[[^\]]*\]\(([^)]+)\)/g),
    ...source.matchAll(/<img\s[^>]*\bsrc=["']([^"']+)["'][^>]*>/gi),
  ];
  for (const match of refs) {
    const src = match[1];
    image(src, '', '');
    try {
      const file = await stat(new URL(`../../${src}`, postsDir));
      if (!file.isFile()) throw new Error('not a file');
    } catch {
      throw new Error(`${name} 引用了不存在的图片：${src}`);
    }
  }
}

function outline(source) {
  const headings = source.split('\n').map((line) => line.trim().match(/^(#{1,3})\s+(.+)$/)).filter(Boolean);
  const numbered = headings.filter((match) => match[1].length === 1 && /^(?:\d+\.\s|Final Statement$)/.test(match[2]));
  const chosen = numbered.length >= 3 ? numbered : headings.filter((match) => match[1].length === Math.min(...headings.map((item) => item[1].length)));
  return chosen.map((match, index) => ({ text: match[2], level: match[1].length, id: `section-${index + 1}` }));
}

function markdown(source, prefix, toc = []) {
  const lines = source.replace(/\r\n/g, '\n').split('\n');
  const html = [];
  const tocIds = new Map(toc.map(({ text, level, id }) => [`${level}:${text}`, id]));
  let paragraph = [];
  let list = null;
  let quote = [];
  const flushParagraph = () => { if (paragraph.length) html.push(`<p>${inline(paragraph.join(' '), prefix)}</p>`); paragraph = []; };
  const flushList = () => { if (list) html.push(`</${list}>`); list = null; };
  const flushQuote = () => { if (quote.length) html.push(`<blockquote>${quote.filter(Boolean).map((line) => `<p>${inline(line, prefix)}</p>`).join('')}</blockquote>`); quote = []; };
  for (const raw of lines) {
    const line = raw.trim();
    if (!line) { flushParagraph(); flushList(); flushQuote(); continue; }
    const heading = line.match(/^(#{1,6})\s+(.+)$/);
    const bullet = line.match(/^[-*]\s+(.+)$/);
    const numbered = line.match(/^\d+\.\s+(.+)$/);
    if (heading) {
      flushParagraph(); flushList(); flushQuote();
      const level = Math.min(heading[1].length + 1, 6);
      const id = tocIds.get(`${heading[1].length}:${heading[2]}`);
      html.push(`<h${level}${id ? ` id="${id}"` : ''}>${inline(heading[2], prefix)}</h${level}>`);
    } else if (/^(-{3,}|\*{3,})$/.test(line)) {
      flushParagraph(); flushList(); flushQuote(); html.push('<hr>');
    } else if (line === '>' || line.startsWith('> ')) {
      flushParagraph(); flushList(); quote.push(line.replace(/^(?:&gt;|>)\s?/, ''));
    } else if (bullet || numbered) {
      flushParagraph(); flushQuote();
      const kind = bullet ? 'ul' : 'ol';
      if (list !== kind) { flushList(); html.push(`<${kind}>`); list = kind; }
      html.push(`<li>${inline((bullet || numbered)[1], prefix)}</li>`);
    } else if (/^<img\s/i.test(line)) {
      flushParagraph(); flushList(); flushQuote();
      const src = line.match(/\bsrc=["']([^"']+)["']/i)?.[1];
      const alt = line.match(/\balt=["']([^"']*)["']/i)?.[1] || '';
      if (src) html.push(`<figure>${image(src, alt, prefix)}</figure>`);
    } else {
      flushList(); flushQuote(); paragraph.push(line);
    }
  }
  flushParagraph(); flushList(); flushQuote();
  return html.join('\n');
}

function shell({ title, description, content, prefix, page }) {
  return `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="color-scheme" content="light"><meta name="description" content="${escapeHtml(description)}">
<title>${escapeHtml(title)} · Hero Journey</title><link rel="icon" href="${prefix}assets/favicon.svg" type="image/svg+xml"><link rel="stylesheet" href="${prefix}assets/site.css">${page === 'article' ? `<script src="${prefix}assets/site.js" defer></script>` : ''}</head>
<body class="${page}"><div class="site-frame">
<aside class="rail" aria-label="网站导航"><a class="brand" href="${prefix}" aria-label="文章列表">H.</a><a class="rail-link" href="${prefix}" aria-label="文章列表" ${page === 'index' ? 'aria-current="page"' : ''}><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 6.5h14M5 12h14M5 17.5h10"/></svg></a></aside>
<div class="mobile-bar"><a class="mobile-brand" href="${prefix}" aria-label="文章列表">H.</a><a href="${prefix}">文章</a></div>
<main id="main">${content}</main>
</div></body></html>`;
}

const names = (await readdir(postsDir)).filter((name) => name.endsWith('.md')).sort();
const sources = [];
const slugs = new Set();
for (const name of names) {
  const source = await readFile(new URL(name, postsDir), 'utf8');
  const slug = slugify(basename(name, '.md'));
  if (!slug || slugs.has(slug)) throw new Error(`文章文件名无法生成唯一网址：${name}`);
  slugs.add(slug);
  const leading = source.replace(/\r\n/g, '\n').trimStart().match(/^#\s+([^\n]+)(?:\n\s*\n#\s+([^\n]+))?/);
  if (!leading) throw new Error(`${name} 缺少开头的一级标题（# 标题）`);
  await validateImages(source, name);
  sources.push({ name, source, slug, leading });
}

await rm(out, { recursive: true, force: true });
await mkdir(new URL('assets/', out), { recursive: true });
await cp(new URL('../photo/', import.meta.url), new URL('photo/', out), { recursive: true });
await cp(new URL('../assets/site.css', import.meta.url), new URL('assets/site.css', out));
await cp(new URL('../assets/site.js', import.meta.url), new URL('assets/site.js', out));
await cp(new URL('../assets/favicon.svg', import.meta.url), new URL('assets/favicon.svg', out));

const posts = [];
for (const { name, source, slug, leading } of sources) {
  const lines = source.replace(/\r\n/g, '\n').split('\n');
  const firstHeading = leading[1].trim();
  const secondHeading = leading[2]?.trim();
  const bilingual = secondHeading && /^[\x00-\x7F]+$/.test(firstHeading) && /[\u4e00-\u9fff]/.test(secondHeading);
  const title = bilingual ? secondHeading : firstHeading;
  const english = bilingual ? firstHeading : '';
  const firstText = lines.find((line) => line.trim() && !/^(#|>|-|<|\d+\.|\*)/.test(line.trim())) || '';
  const description = firstText.slice(0, 90);
  const reading = Math.max(1, Math.ceil(source.replace(/\s/g, '').length / 450));
  const headingBlock = bilingual ? leading[0] : leading[0].match(/^#\s+[^\n]+/)?.[0];
  const body = source.trimStart().slice(headingBlock.length).trimStart();
  const toc = outline(body);
  const tocLinks = toc.map(({ text, id }) => {
    const numbered = text.match(/^(\d+)\.\s+(.+)$/);
    return `<a href="#${id}" data-toc-link><span class="toc-number">${numbered ? numbered[1].padStart(2, '0') : '—'}</span><span>${escapeHtml(numbered ? numbered[2] : text)}</span></a>`;
  }).join('');
  const content = `<article class="article-page"><a class="back-link" href="../../"><span aria-hidden="true">←</span> 文章</a>
  <header class="article-header"><h1>${escapeHtml(title)}</h1>${english ? `<p class="article-subtitle">${escapeHtml(english)}</p>` : ''}<p class="article-meta">约 ${reading} 分钟阅读</p></header>
  ${toc.length ? `<details class="toc-mobile"><summary>目录 <span>${toc.length} 节</span></summary><nav aria-label="文章目录">${tocLinks}</nav></details>` : ''}
  <div class="prose">${markdown(body, '../../', toc)}</div>
  <a class="end-link" href="../../">← 返回文章列表</a></article>
  ${toc.length ? `<details class="toc-drawer"><summary>目录</summary><nav aria-label="文章目录">${tocLinks}</nav></details><nav class="toc-desktop" aria-label="文章目录"><p class="toc-heading">目录</p><div class="toc-list">${tocLinks}</div></nav>` : ''}`;
  const dir = new URL(`posts/${slug}/`, out);
  await mkdir(dir, { recursive: true });
  await writeFile(new URL('index.html', dir), shell({ title, description, content, prefix: '../../', page: 'article' }));
  posts.push({ slug, title, description, reading, english });
}

const cards = posts.map((post) => `<a class="post-row" href="./posts/${post.slug}/"><span class="post-info"><span class="post-title">${escapeHtml(post.title)}</span>${post.english ? `<span class="post-subtitle">${escapeHtml(post.english)}</span>` : ''}</span><span class="post-meta">约 ${post.reading} 分钟</span></a>`).join('\n');
const home = `<div class="index-page"><header class="intro"><p class="intro-label">Writing</p><h1>文章</h1></header>
<section class="posts-section" aria-label="文章列表"><div class="post-list">${cards || '<p class="empty">暂无文章</p>'}</div></section></div>`;
await writeFile(new URL('index.html', out), shell({ title: '文章', description: '文章列表', content: home, prefix: './', page: 'index' }));
console.log(`Built ${posts.length} article(s) in dist/`);
