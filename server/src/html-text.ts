/**
 * 轻量 HTML → Markdown 转换器（web_fetch 专用，无第三方依赖）。
 *
 * 设计取舍：
 * - 用一个容错的标签分词器 + 栈式解析成节点树，而不是完整 HTML5 解析：真实网页绝大多数标签
 *   是闭合的，未闭合标签按「遇到对应闭合标签或父级闭合时收回」处理；
 * - 输出面向模型阅读：保留标题层级、列表、链接、图片、表格（GFM）、代码块与强调，
 *   去掉脚本/样式/注释/表单等对阅读无意义的部分；
 * - 不做正文智能抽取（readability）：整页转换，广告等噪声交给模型自行忽略。
 */

export interface HtmlToMarkdownResult {
  title: string;
  markdown: string;
  /** 输入超出上限被截断时为 true（此时转换结果可能不完整）。 */
  truncatedInput: boolean;
}

interface HtmlNode {
  type: 'element' | 'text';
  tag?: string;
  attrs?: Record<string, string>;
  children?: HtmlNode[];
  text?: string;
}

const VOID_TAGS = new Set([
  'area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'param', 'source', 'track', 'wbr',
]);

/** 整个移除（含内容）的标签。 */
const DROP_TAGS = new Set([
  'script', 'style', 'noscript', 'template', 'svg', 'head', 'iframe', 'object', 'embed',
  'form', 'button', 'select', 'textarea', 'input', 'option', 'datalist', 'dialog', 'canvas', 'audio', 'video',
]);

/** 透明容器：直接渲染子节点。 */
const CONTAINER_TAGS = new Set([
  'div', 'section', 'article', 'main', 'header', 'footer', 'aside', 'nav', 'figure', 'figcaption',
  'details', 'summary', 'center', 'span', 'font', 'small', 'big', 'body', 'html', 'dl', 'dt', 'dd',
  'u', 'ins', 'abbr', 'cite', 'q', 'time', 'mark', 'sub', 'sup', 'label',
]);

const NAMED_ENTITIES: Record<string, string> = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', copy: '©', reg: '®', trade: '™',
  hellip: '…', mdash: '—', ndash: '–', lsquo: '\u2018', rsquo: '\u2019', ldquo: '\u201c', rdquo: '\u201d',
  times: '×', divide: '÷', laquo: '«', raquo: '»', deg: '°', middot: '·', plusmn: '±', micro: 'µ',
  sect: '§', para: '¶', bull: '•', dagger: '†', permil: '‰', prime: '′', Prime: '″', larr: '←',
  uarr: '↑', rarr: '→', darr: '↓', harr: '↔', minus: '−', lowast: '∗', oline: '‾', frasl: '⁄',
  weierp: '℘', image: 'ℑ', real: 'ℜ', alefsym: 'ℵ', lceil: '⌈', rceil: '⌉', lfloor: '⌊', rfloor: '⌋',
};

export function decodeEntities(input: string): string {
  if (!input.includes('&')) return input;
  return input.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z][a-zA-Z0-9]{1,30});/g, (raw, body: string) => {
    if (body.startsWith('#x') || body.startsWith('#X')) {
      const code = Number.parseInt(body.slice(2), 16);
      return Number.isFinite(code) ? safeCodePoint(code) : raw;
    }
    if (body.startsWith('#')) {
      const code = Number.parseInt(body.slice(1), 10);
      return Number.isFinite(code) ? safeCodePoint(code) : raw;
    }
    const named = NAMED_ENTITIES[body] ?? NAMED_ENTITIES[body.toLowerCase()];
    return named ?? raw;
  });
}

function safeCodePoint(code: number): string {
  if (!Number.isFinite(code) || code < 0 || code > 0x10ffff) return '';
  // 代理区与控制字符（保留换行/制表）直接丢弃，避免产出非法文本。
  if (code >= 0xd800 && code <= 0xdfff) return '';
  if (code < 32 && code !== 9 && code !== 10 && code !== 13) return '';
  return String.fromCodePoint(code);
}

function parseAttrs(raw: string): Record<string, string> {
  const attrs: Record<string, string> = {};
  const attrPattern = /([a-zA-Z_:][a-zA-Z0-9_:.-]*)\s*(?:=\s*("([^"]*)"|'([^']*)'|[^\s"'>]+))?/g;
  for (const match of raw.matchAll(attrPattern)) {
    const name = match[1].toLowerCase();
    const value = match[3] ?? match[4] ?? match[2] ?? '';
    if (!attrs[name]) attrs[name] = decodeEntities(value);
  }
  return attrs;
}

function isHidden(attrs: Record<string, string> | undefined): boolean {
  if (!attrs) return false;
  if (attrs.hidden !== undefined) return true;
  const style = (attrs.style ?? '').replace(/\s+/g, '').toLowerCase();
  return /display:none/.test(style) || /visibility:hidden/.test(style);
}

/** 容错的标签分词器：产出节点树。未闭合的标签在最靠近的祖先闭合时收回。 */
function parseHtml(html: string): HtmlNode {
  const root: HtmlNode = { type: 'element', tag: '#root', children: [] };
  const stack: HtmlNode[] = [root];
  const tagPattern = /<!--[\s\S]*?-->|<!\[CDATA\[[\s\S]*?\]\]>|<!DOCTYPE[^>]*>|<\/?([a-zA-Z][a-zA-Z0-9-]*)((?:[^>"']|"[^"]*"|'[^']*')*)>|([^<]+)/g;
  let match: RegExpExecArray | null;
  while ((match = tagPattern.exec(html)) !== null) {
    const [raw, tagName, attrText, text] = match;
    if (text !== undefined) {
      const top = stack[stack.length - 1];
      if (top.children) top.children.push({ type: 'text', text });
      continue;
    }
    if (raw.startsWith('<!--') || raw.startsWith('<!')) continue;
    if (!tagName) continue;
    const tag = tagName.toLowerCase();
    if (raw.startsWith('</')) {
      // 闭合：从栈顶向下找同名标签；找不到则忽略。
      for (let i = stack.length - 1; i > 0; i -= 1) {
        if (stack[i].tag === tag) {
          stack.length = i;
          break;
        }
      }
      continue;
    }
    if (DROP_TAGS.has(tag) && !VOID_TAGS.has(tag) && !raw.endsWith('/>')) {
      // 跳过整个元素（含内容）：找到它的闭合标签为止。注意 input 等空元素没有闭合标签，
      // 绝不能走这里，否则找不到 </input> 会把文档剩余部分全部吞掉。
      const closing = new RegExp(`</${tag}\\s*>`, 'i');
      const rest = html.slice(tagPattern.lastIndex);
      const closeMatch = closing.exec(rest);
      tagPattern.lastIndex = closeMatch
        ? tagPattern.lastIndex + closeMatch.index + closeMatch[0].length
        : html.length;
      continue;
    }
    const attrs = parseAttrs(attrText ?? '');
    if (VOID_TAGS.has(tag) || raw.endsWith('/>')) {
      // 空元素（含 DROP 里的 input/embed）：只丢弃标签本身，不影响后续内容。
      if (!DROP_TAGS.has(tag)) {
        const top = stack[stack.length - 1];
        if (top.children) top.children.push({ type: 'element', tag, attrs, children: [] });
      }
      continue;
    }
    const node: HtmlNode = { type: 'element', tag, attrs, children: [] };
    const top = stack[stack.length - 1];
    if (top.children) top.children.push(node);
    if (!isHidden(attrs)) stack.push(node);
  }
  return root;
}

function absoluteUrl(raw: string | undefined, baseUrl?: string): string {
  const value = (raw ?? '').trim();
  if (!value || value.startsWith('#') || /^(javascript|data|mailto|tel):/i.test(value)) return '';
  if (!baseUrl) return value;
  try {
    return new URL(value, baseUrl).href;
  } catch {
    return value;
  }
}

function collapseWhitespace(text: string): string {
  return text.replace(/\s+/g, ' ');
}

/** 行内渲染：返回单行（不含换行）的 Markdown 片段。 */
function renderInline(nodes: HtmlNode[], baseUrl?: string): string {
  let out = '';
  const visit = (node: HtmlNode): void => {
    if (node.type === 'text') {
      out += collapseWhitespace(decodeEntities(node.text ?? ''));
      return;
    }
    const tag = node.tag ?? '';
    const children = node.children ?? [];
    switch (tag) {
      case 'br':
        out += '  \n';
        return;
      case 'img': {
        const src = absoluteUrl(node.attrs?.src, baseUrl);
        const alt = collapseWhitespace(decodeEntities(node.attrs?.alt ?? '')).replace(/[\[\]]/g, '');
        if (src) out += `![${alt}](${src})`;
        else if (alt) out += alt;
        return;
      }
      case 'a': {
        const inner = renderInline(children, baseUrl).trim();
        const href = absoluteUrl(node.attrs?.href, baseUrl);
        if (!href) out += inner;
        else if (!inner) out += `[${href}](${href})`;
        else out += `[${inner.replace(/[\[\]]/g, '')}](${href})`;
        return;
      }
      case 'strong':
      case 'b': {
        const inner = renderInline(children, baseUrl).trim();
        out += inner ? `**${inner}**` : '';
        return;
      }
      case 'em':
      case 'i': {
        const inner = renderInline(children, baseUrl).trim();
        out += inner ? `*${inner}*` : '';
        return;
      }
      case 'del':
      case 's':
      case 'strike': {
        const inner = renderInline(children, baseUrl).trim();
        out += inner ? `~~${inner}~~` : '';
        return;
      }
      case 'code': {
        const inner = collapseWhitespace(decodeEntities(rawText(children))).trim();
        if (!inner) return;
        const fence = inner.includes('`') ? '``' : '`';
        out += `${fence}${inner}${fence}`;
        return;
      }
      default: {
        if (CONTAINER_TAGS.has(tag)) {
          for (const child of children) visit(child);
          return;
        }
        // 未知标签：按透明容器处理，尽量不丢内容。
        for (const child of children) visit(child);
      }
    }
  };
  for (const child of nodes) visit(child);
  return out.replace(/[ \t]{2,}/g, ' ').trim();
}

function rawText(nodes: HtmlNode[]): string {
  let out = '';
  const visit = (node: HtmlNode): void => {
    if (node.type === 'text') {
      out += node.text ?? '';
      return;
    }
    if ((node.tag ?? '') === 'br') {
      out += '\n';
      return;
    }
    for (const child of node.children ?? []) visit(child);
  };
  for (const node of nodes) visit(node);
  return out;
}

/** 块级渲染：返回 Markdown 块列表（每个块是若干行）。 */
function renderBlocks(nodes: HtmlNode[], baseUrl: string | undefined, depth: number): string[] {
  const blocks: string[] = [];
  const pushBlock = (text: string): void => {
    const trimmed = text.replace(/\n{3,}/g, '\n\n').trim();
    if (trimmed) blocks.push(trimmed);
  };

  const visit = (node: HtmlNode): void => {
    if (node.type === 'text') {
      const text = collapseWhitespace(decodeEntities(node.text ?? '')).trim();
      if (text) pushBlock(text);
      return;
    }
    const tag = node.tag ?? '';
    const children = node.children ?? [];
    switch (tag) {
      case 'h1': case 'h2': case 'h3': case 'h4': case 'h5': case 'h6': {
        const level = Number(tag[1]);
        const inner = renderInline(children, baseUrl);
        if (inner) pushBlock(`${'#'.repeat(level)} ${inner}`);
        return;
      }
      case 'p':
        pushBlock(renderInline(children, baseUrl));
        return;
      case 'hr':
        pushBlock('---');
        return;
      case 'pre': {
        const code = decodeEntities(rawText(children)).replace(/\n+$/, '');
        if (code.trim()) pushBlock(`\`\`\`\n${code}\n\`\`\``);
        return;
      }
      case 'blockquote': {
        const inner = renderBlocks(children, baseUrl, depth);
        const quoted = inner.map((block) => block.split('\n').map((line) => `> ${line}`.trimEnd()).join('\n'));
        pushBlock(quoted.join('\n>\n'));
        return;
      }
      case 'ul':
      case 'ol': {
        const lines = renderList(children, tag === 'ol', baseUrl, depth);
        if (lines.length > 0) pushBlock(lines.join('\n'));
        return;
      }
      case 'table':
        pushBlock(renderTable(node, baseUrl));
        return;
      case 'li':
        // 游离的 li（规范外）：按列表项文本渲染。
        pushBlock(`- ${renderInline(children, baseUrl)}`);
        return;
      default: {
        if (CONTAINER_TAGS.has(tag)) {
          for (const child of children) visit(child);
          return;
        }
        const inner = renderInline(children, baseUrl);
        if (inner) pushBlock(inner);
      }
    }
  };

  for (const child of nodes) visit(child);
  return blocks;
}

/** 渲染 ul/ol 的子级，返回带缩进的行（嵌套列表递归缩进）。 */
function renderList(items: HtmlNode[], ordered: boolean, baseUrl: string | undefined, depth: number): string[] {
  const lines: string[] = [];
  let index = 0;
  for (const item of items) {
    if (item.type === 'text') continue;
    const tag = item.tag ?? '';
    if (tag !== 'li') {
      // ul/ol 直接嵌套等规范外结构：递归渲染。
      if (tag === 'ul' || tag === 'ol') {
        lines.push(...renderList(item.children ?? [], tag === 'ol', baseUrl, depth + 1));
      }
      continue;
    }
    index += 1;
    const marker = ordered ? `${index}. ` : '- ';
    const indent = '  '.repeat(depth);
    const innerBlocks: string[] = [];
    const inlineNodes: HtmlNode[] = [];
    for (const child of item.children ?? []) {
      const childTag = child.tag ?? '';
      if (child.type === 'element' && (childTag === 'ul' || childTag === 'ol' || childTag === 'p' || childTag === 'pre' || childTag === 'blockquote' || childTag === 'table')) {
        innerBlocks.push(...renderBlocks([child], baseUrl, depth));
      } else {
        inlineNodes.push(child);
      }
    }
    const head = renderInline(inlineNodes, baseUrl);
    lines.push(`${indent}${marker}${head}`);
    for (const block of innerBlocks) {
      for (const line of block.split('\n')) {
        lines.push(line.trim() ? `${indent}  ${line}` : '');
      }
    }
  }
  return lines;
}

function renderTable(node: HtmlNode, baseUrl: string | undefined): string {
  const rows: string[][] = [];
  let caption = '';
  const collect = (tableNode: HtmlNode): void => {
    for (const child of tableNode.children ?? []) {
      const tag = child.tag ?? '';
      if (tag === 'caption') caption = renderInline(child.children ?? [], baseUrl);
      else if (tag === 'colgroup') continue;
      else if (tag === 'tr') rows.push(rowCells(child, baseUrl));
      else if (tag === 'thead' || tag === 'tbody' || tag === 'tfoot') {
        for (const tr of child.children ?? []) {
          if ((tr.tag ?? '') === 'tr') rows.push(rowCells(tr, baseUrl));
        }
      } else collect(child);
    }
  };
  collect(node);
  if (rows.length === 0) return caption;
  const width = Math.max(...rows.map((row) => row.length));
  const normalized = rows.map((row) => {
    const cells = [...row];
    while (cells.length < width) cells.push('');
    return cells.map((cell) => cell.replace(/\|/g, '\\|').replace(/\n/g, ' '));
  });
  const header = normalized[0];
  const separator = Array.from({ length: width }, () => '---');
  const bodyLines = normalized.slice(1).map((row) => `| ${row.join(' | ')} |`);
  const table = [`| ${header.join(' | ')} |`, `| ${separator.join(' | ')} |`, ...bodyLines].join('\n');
  return caption ? `**${caption}**\n\n${table}` : table;
}

function rowCells(tr: HtmlNode, baseUrl: string | undefined): string[] {
  const cells: string[] = [];
  for (const cell of tr.children ?? []) {
    const tag = cell.tag ?? '';
    if (tag === 'td' || tag === 'th') {
      // 单元格里的块级内容（列表等）压平成一行，保证表格合法。
      const blocks = renderBlocks(cell.children ?? [], baseUrl, 0);
      const flat = blocks.join(' ').split('\n').map((line) => line.trim()).filter(Boolean).join('；');
      cells.push(flat || renderInline(cell.children ?? [], baseUrl));
    }
  }
  return cells;
}

export function htmlToMarkdown(
  html: string,
  options: { baseUrl?: string; maxInputChars?: number } = {},
): HtmlToMarkdownResult {
  const maxInputChars = options.maxInputChars ?? 2_000_000;
  const truncatedInput = html.length > maxInputChars;
  const input = truncatedInput ? html.slice(0, maxInputChars) : html;

  const titleMatch = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(input);
  const title = collapseWhitespace(decodeEntities(titleMatch?.[1] ?? '')).trim();

  const root = parseHtml(input);
  const blocks = renderBlocks(root.children ?? [], options.baseUrl, 0);
  const markdown = blocks.join('\n\n');
  return { title, markdown, truncatedInput };
}
