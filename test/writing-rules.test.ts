import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { fromFirstSection, renderMarkdown, sections } from "../web/src/lib/markdown.ts";

// docs/writing-rules.md is the one source of guidance on writing rules: the
// Guide page renders it and the import skill reads it.
const guidance = readFileSync(new URL("../docs/writing-rules.md", import.meta.url), "utf8");

describe("the guidance on writing rules", () => {
  it("gives the Guide page its two sections on rules", () => {
    expect(sections(fromFirstSection(guidance)).map((s) => s.label)).toEqual([
      "Always-rules and conditional rules",
      "Writing a condition that matches well",
    ]);
  });

  it("has a working target for every link inside it, in what the Guide renders", () => {
    // The Guide leaves out everything before the first section.
    const html = renderMarkdown(fromFirstSection(guidance));
    const ids = new Set([...html.matchAll(/ id="([^"]+)"/g)].map(([, id]) => id));
    const anchors = [...html.matchAll(/ href="#([^"]+)"/g)].map(([, anchor]) => anchor);
    expect(anchors.length).toBeGreaterThan(0);
    for (const anchor of anchors) expect(ids, `#${anchor}`).toContain(anchor);
  });

  it("is what the import skill's instructions point to, by headings that exist", () => {
    const instructions = readFileSync(new URL("../skill/import.md", import.meta.url), "utf8");
    // The step that has the agent read it, not only a mention.
    expect(instructions).toMatch(/^- Read `docs\/writing-rules\.md`/m);
    const headings = new Set([...guidance.matchAll(/^#+ (.+)$/gm)].map(([, heading]) => heading));
    const cited = [...instructions.matchAll(/"([^"]+)" in the guide/g)].map(([, heading]) => heading);
    expect(cited.length).toBeGreaterThan(0);
    for (const heading of cited) expect(headings, heading).toContain(heading);
  });
});
