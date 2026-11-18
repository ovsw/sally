import { Marked } from "marked";

/** A heading's anchor, as GitHub makes it, so links inside a document work in both places. */
export function slug(text: string): string {
  return text
    .toLowerCase()
    .trim()
    .replace(/[^\p{L}\p{N}\s-]/gu, "")
    .replace(/\s/g, "-");
}

const marked = new Marked({
  gfm: true,
  renderer: {
    heading({ tokens, depth, text }) {
      return `<h${depth} id="${slug(text)}">${this.parser.parseInline(tokens)}</h${depth}>\n`;
    },
  },
});

/** Renders Markdown from the repository's own files to HTML. */
export function renderMarkdown(markdown: string): string {
  return marked.parse(markdown, { async: false });
}

/** The "##" headings of a document, in order, with their anchors. */
export function sections(markdown: string): { id: string; label: string }[] {
  return [...markdown.matchAll(/^## (.+)$/gm)].map(([, label]) => ({ id: slug(label!), label: label! }));
}

/** A document from its first "##" heading down, leaving out its title and introduction. */
export function fromFirstSection(markdown: string): string {
  const start = markdown.search(/^## /m);
  return start === -1 ? markdown : markdown.slice(start);
}
