import { mkdir, readdir, readFile, writeFile, cp, rm, stat } from 'node:fs/promises';
import { basename } from 'node:path';

const postsDir = new URL('../content/posts/', import.meta.url);
const out = new URL('../dist/', import.meta.url);
const escapeHtml = (value) => String(value).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const slugify = (name) => name.toLowerCase().replace(/[^a-z0-9\u4e00-\u9fff]+/g, '-').replace(/^-|-$/g, '');

function postMetadata(raw, name) {
  const normalized = raw.replace(/\r\n/g, '\n');
  const blocks = [...normalized.matchAll(/<!--\s*post-meta\b([\s\S]*?)-->/g)];
  const starts = [...normalized.matchAll(/<!--\s*post-meta\b/g)];
  if (starts.length !== blocks.length || blocks.length > 1) throw new Error(`${name} 的 post-meta 必须是一个完整的注释块`);
  const metadata = { tags: [] };
  const seen = new Set();
  for (const line of (blocks[0]?.[1] || '').split('\n').filter((line) => line.trim())) {
    const field = line.match(/^\s*(published|updated|tags|summary):\s*(.*?)\s*$/);
    if (!field) throw new Error(`${name} 的元信息行不受支持：${line}`);
    const [, key, value] = field;
    if (seen.has(key)) throw new Error(`${name} 的 ${key} 重复填写`);
    seen.add(key);
    if (!value) throw new Error(`${name} 的 ${key} 不能为空；没有信息时请省略该字段`);
    if (key === 'tags') {
      metadata.tags = [...new Set(value.split(/[,，]/).map((tag) => tag.trim()).filter(Boolean))];
      if (!metadata.tags.length || metadata.tags.length > 3) throw new Error(`${name} 请填写 1–3 个标签`);
    } else if (key === 'published' || key === 'updated') {
      const date = new Date(`${value}T00:00:00Z`);
      if (!/^\d{4}-\d{2}-\d{2}$/.test(value) || !Number.isFinite(date.getTime()) || date.toISOString().slice(0, 10) !== value) throw new Error(`${name} 的 ${key} 必须是有效的 YYYY-MM-DD 日期`);
      metadata[key] = value;
    } else metadata[key] = value;
  }
  if (metadata.published && metadata.updated && metadata.updated < metadata.published) throw new Error(`${name} 的更新日期不能早于发布日期`);
  return { source: normalized.replace(/<!--\s*post-meta\b[\s\S]*?-->/g, '').trimStart(), metadata };
}

function metadataHtml(metadata, article = false) {
  const date = (value) => `<time datetime="${value}">${value.replaceAll('-', '.')}</time>`;
  const items = [metadata.published ? date(metadata.published) : '', article && metadata.updated && metadata.updated !== metadata.published ? `<span>更新于 ${date(metadata.updated)}</span>` : '', ...metadata.tags.map((tag) => `<span class="post-tag">${escapeHtml(tag)}</span>`)].filter(Boolean);
  return items.length ? `<${article ? 'div' : 'span'} class="${article ? 'article-meta' : 'post-meta'}">${items.join('')}<${article ? '/div' : '/span'}>` : '';
}

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
  const homeIcon = '<svg class="home-icon" viewBox="0 0 24 24" aria-hidden="true"><path fill-rule="evenodd" d="M11.36 2.23a1 1 0 0 1 1.28 0l9 7.5a1 1 0 0 1-1.28 1.54L20 10.97V21a1 1 0 0 1-1 1h-4v-6H9v6H5a1 1 0 0 1-1-1V10.97l-.36.3a1 1 0 0 1-1.28-1.54ZM12 6a2.5 2.5 0 1 0 0 5 2.5 2.5 0 0 0 0-5Z"/><path class="home-chimney" d="M17 2h3v4l-3-2.5Z"/></svg>';
  const postsIcon = '<svg class="posts-icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M5 6.5h14"/><path d="M5 12h14"/><path d="M5 17.5h10"/></svg>';
  const themeButton = `<button class="rail-link theme-toggle" type="button" data-theme-toggle aria-label="切换到夜间模式" aria-pressed="false"><svg class="moon-icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M20.5 14A8.7 8.7 0 0 1 10 3.5 8.7 8.7 0 1 0 20.5 14Z"/></svg><svg class="sun-icon" viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="4"/><path d="M12 2v2m0 16v2M2 12h2m16 0h2M5 5l1.4 1.4m11.2 11.2L19 19M5 19l1.4-1.4M17.6 6.4 19 5"/></svg><span class="rail-tooltip" aria-hidden="true">切换到夜间模式</span></button>`;
  const navigation = (mobile = false) => [
    { label: '首页', href: prefix, icon: homeIcon, current: page === 'home', active: page === 'home' },
    { label: '文章列表', href: `${prefix}posts/`, icon: postsIcon, current: page === 'index', active: page !== 'home' },
  ].map(({ label, href, icon, current, active }) => `<a class="rail-link${active ? ' is-active' : ''}" href="${href}" aria-label="${label}"${current ? ' aria-current="page"' : ''}>${icon}<span class="${mobile ? 'mobile-label' : 'rail-tooltip'}"${mobile ? '' : ' aria-hidden="true"'}>${label}</span></a>`).join('');
  return `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="color-scheme" content="light dark"><meta name="description" content="${escapeHtml(description)}">
<title>${escapeHtml(title)} · Hero Journey</title><link rel="icon" href="${prefix}assets/favicon.svg" type="image/svg+xml"><script src="${prefix}assets/theme.js"></script><link rel="stylesheet" href="${prefix}assets/site.css">${page === 'article' ? `<script src="${prefix}assets/site.js" defer></script>` : ''}</head>
<body class="${page}"><div class="site-frame">
<aside class="rail" aria-label="网站导航"><a class="brand" href="${prefix}" aria-label="henryDai 首页">henry<span>Dai</span></a><div class="rail-controls"><nav class="rail-nav" aria-label="主导航">${navigation()}</nav>${themeButton}</div></aside>
<div class="mobile-bar"><a class="mobile-brand" href="${prefix}" aria-label="henryDai 首页">henry<span>Dai</span></a><div class="mobile-controls"><nav class="mobile-nav" aria-label="主导航">${navigation(true)}</nav>${themeButton}</div></div>
<main id="main"${page === 'home' ? ' aria-label="首页"' : ''}>${content}</main>
</div></body></html>`;
}

const names = (await readdir(postsDir)).filter((name) => name.endsWith('.md')).sort();
const sources = [];
const slugs = new Set();
for (const name of names) {
  const { source, metadata } = postMetadata(await readFile(new URL(name, postsDir), 'utf8'), name);
  const slug = slugify(basename(name, '.md'));
  if (!slug || slugs.has(slug)) throw new Error(`文章文件名无法生成唯一网址：${name}`);
  slugs.add(slug);
  const leading = source.replace(/\r\n/g, '\n').trimStart().match(/^#\s+([^\n]+)(?:\n\s*\n#\s+([^\n]+))?/);
  if (!leading) throw new Error(`${name} 缺少开头的一级标题（# 标题）`);
  await validateImages(source, name);
  sources.push({ name, source, slug, leading, metadata });
}

await rm(out, { recursive: true, force: true });
await mkdir(new URL('assets/', out), { recursive: true });
await cp(new URL('../photo/', import.meta.url), new URL('photo/', out), { recursive: true });
await cp(new URL('../assets/site.css', import.meta.url), new URL('assets/site.css', out));
await cp(new URL('../assets/site.js', import.meta.url), new URL('assets/site.js', out));
await cp(new URL('../assets/theme.js', import.meta.url), new URL('assets/theme.js', out));
await cp(new URL('../assets/favicon.svg', import.meta.url), new URL('assets/favicon.svg', out));

const posts = [];
for (const { name, source, slug, leading, metadata } of sources) {
  const lines = source.replace(/\r\n/g, '\n').split('\n');
  const firstHeading = leading[1].trim();
  const secondHeading = leading[2]?.trim();
  const bilingual = secondHeading && /^[\x00-\x7F]+$/.test(firstHeading) && /[\u4e00-\u9fff]/.test(secondHeading);
  const title = bilingual ? secondHeading : firstHeading;
  const english = bilingual ? firstHeading : '';
  const firstText = lines.find((line) => line.trim() && !/^(#|>|-|<|\d+\.|\*)/.test(line.trim())) || '';
  const description = metadata.summary || firstText.slice(0, 90);
  const headingBlock = bilingual ? leading[0] : leading[0].match(/^#\s+[^\n]+/)?.[0];
  const body = source.trimStart().slice(headingBlock.length).trimStart();
  const toc = outline(body);
  const tocLinks = toc.map(({ text, id }) => {
    const numbered = text.match(/^(\d+)\.\s+(.+)$/);
    return `<a href="#${id}" data-toc-link><span class="toc-number">${numbered ? numbered[1].padStart(2, '0') : '—'}</span><span>${escapeHtml(numbered ? numbered[2] : text)}</span></a>`;
  }).join('');
  const content = `<article class="article-page"><a class="back-link" href="../"><span aria-hidden="true">←</span> 文章</a>
  <header class="article-header"><h1>${escapeHtml(title)}</h1>${english ? `<p class="article-subtitle">${escapeHtml(english)}</p>` : ''}${metadata.summary ? `<p class="article-summary">${escapeHtml(metadata.summary)}</p>` : ''}${metadataHtml(metadata, true)}</header>
  ${toc.length ? `<details class="toc-mobile"><summary>目录 <span>${toc.length} 节</span></summary><nav aria-label="文章目录">${tocLinks}</nav></details>` : ''}
  <div class="prose">${markdown(body, '../../', toc)}</div>
  <a class="end-link" href="../">← 返回文章列表</a></article>
  ${toc.length ? `<details class="toc-drawer"><summary>目录</summary><nav aria-label="文章目录">${tocLinks}</nav></details><nav class="toc-desktop" aria-label="文章目录"><p class="toc-heading">目录</p><div class="toc-list">${tocLinks}</div></nav>` : ''}`;
  const dir = new URL(`posts/${slug}/`, out);
  await mkdir(dir, { recursive: true });
  await writeFile(new URL('index.html', dir), shell({ title, description, content, prefix: '../../', page: 'article' }));
  posts.push({ slug, title, description, english, metadata });
}

posts.sort((a, b) => (b.metadata.published || '').localeCompare(a.metadata.published || '') || a.slug.localeCompare(b.slug, 'zh-CN'));
const cards = posts.map((post) => `<a class="post-row" href="./${post.slug}/"><span class="post-info"><span class="post-title">${escapeHtml(post.title)}</span>${post.english ? `<span class="post-subtitle">${escapeHtml(post.english)}</span>` : ''}${post.description ? `<span class="post-summary">${escapeHtml(post.description)}</span>` : ''}${metadataHtml(post.metadata)}</span></a>`).join('\n');
const listing = `<div class="index-page"><header class="intro"><p class="intro-label">Writing</p><h1>文章</h1></header>
<section class="posts-section" aria-label="文章列表"><div class="post-list">${cards || '<p class="empty">暂无文章</p>'}</div></section></div>`;
await mkdir(new URL('posts/', out), { recursive: true });
await writeFile(new URL('posts/index.html', out), shell({ title: '文章', description: '文章列表', content: listing, prefix: '../', page: 'index' }));
// 首页正文暂时留空，后续内容从这里添加。
const home = '';
await writeFile(new URL('index.html', out), shell({ title: '首页', description: 'Hero Journey', content: home, prefix: './', page: 'home' }));
console.log(`Built ${posts.length} article(s) in dist/`);
