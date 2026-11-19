import { spawnSync } from "node:child_process";
import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { EvaluationReport } from "../src/evaluate.ts";
import { runEvaluation } from "../src/evaluate.ts";
import type { Matcher, MatcherCondition } from "../src/matcher.ts";
import { databasePath } from "../src/paths.ts";
import { createSandbox, type Sandbox } from "./support/sandbox.ts";
import { standInMatcher } from "./support/stand-in-matcher.ts";

const cli = join(import.meta.dirname, "..", "src", "cli.ts");
const example = join(import.meta.dirname, "..", "docs", "evaluation-example.json");

let sandbox: Sandbox;
beforeEach(() => {
  sandbox = createSandbox();
});
afterEach(() => sandbox.cleanup());

async function evaluate(args: string[], matcher: Matcher) {
  let stdout = "";
  let stderr = "";
  const code = await runEvaluation(args, {
    env: sandbox.env,
    matcher,
    stdout: (text) => (stdout += text),
    stderr: (text) => (stderr += text),
  });
  return { code, stdout, stderr };
}

async function report(args: string[], matcher: Matcher): Promise<EvaluationReport> {
  const result = await evaluate([...args, "--json"], matcher);
  expect(result.stderr).toBe("");
  expect(result.code).toBe(0);
  return JSON.parse(result.stdout) as EvaluationReport;
}

function evaluationFile(content: unknown): string {
  const path = join(sandbox.root, "evaluation.json");
  writeFileSync(path, typeof content === "string" ? content : JSON.stringify(content));
  return path;
}

const SHORT = "The user's message asks for a short answer.";
const FORCE = "The user's message asks to rewrite history on a shared git branch.";
const LINK = "This reply reports a finished visual change and gives no local link to the page.";

/**
 * Scores for the documented example, per case text: two right matches, one
 * wrong match (the reply that already has a link) and one miss.
 */
const exampleScores: Record<string, Record<string, number>> = {
  "Just tell me in one line: does the build pass?": { [SHORT]: 0.82 },
  "Rebase main onto the release branch and push it with --force.": { [FORCE]: 0.41 },
  "Done: the button is now blue and the spacing under the header is fixed.": { [LINK]: 0.9 },
  "Done: the button is now blue. Check it at http://localhost:3000/pricing.": { [LINK]: 0.9 },
};

interface Call {
  text: string;
  conditions: MatcherCondition[];
}

/** A stand-in for Jev that scores each condition by the text being checked; 0.1 when not listed. */
function exampleMatcher(
  options: { inputTokens?: number; extra?: (condition: string) => number | undefined } = {},
): Matcher & { calls: Call[] } {
  const calls: Call[] = [];
  return {
    calls,
    async match(text, conditions) {
      calls.push({ text, conditions });
      return {
        scores: Object.fromEntries(
          conditions.map((c) => [c.id, options.extra?.(c.text) ?? exampleScores[text]?.[c.text] ?? 0.1]),
        ),
        inputTokens: options.inputTokens ?? 120,
      };
    },
  };
}

describe("an evaluation run", () => {
  it("reports right matches, wrong matches and misses on the documented example", async () => {
    const result = await report([example], exampleMatcher());

    expect(result.summary).toMatchObject({
      cases: 5,
      completed: 5,
      failed: 0,
      right: 2,
      wrong: 1,
      missed: 1,
      checksWithWrongMatch: 1,
      wrongMatchRate: 0.2,
      inputTokens: { total: 600, largestCheck: 120 },
    });
    expect(result.summary.durationMs.median).toEqual(expect.any(Number));
    expect(result.settings).toEqual({ cutoff: 0.6, timeLimitMs: 10_000 });

    const byLabel = Object.fromEntries(result.cases.map((c) => [c.label, c]));
    expect(byLabel["short answer"]!.right).toEqual([{ name: "Brief replies", score: 0.82, padding: false }]);
    expect(byLabel["rebase main"]!.missed).toEqual([{ name: "Never force push", score: 0.41, padding: false }]);
    expect(byLabel["unrelated question"]!.matched).toEqual([]);
    expect(byLabel["button colour with link"]!.wrong).toEqual([
      { name: "Local link for visual changes", score: 0.9, padding: false },
    ]);
  });

  it("prints a readable report with the counts, timing, tokens and each mistake", async () => {
    const { code, stdout } = await evaluate([example], exampleMatcher());
    expect(code).toBe(0);
    expect(stdout).toContain("Evaluation: 5 cases (3 messages, 2 replies)");
    expect(stdout).toContain("Right matches: 2   Wrong matches: 1   Misses: 1");
    expect(stdout).toContain("Wrong-match rate: 20.0% (1 of 5 checks that ran had a wrong match)");
    expect(stdout).toMatch(/Time per check: median \d+(\.\d+)? ms/);
    expect(stdout).toContain("Input tokens: 600 in all, at most 120 in one check");
    expect(stdout).toContain('button colour with link (reply): "Local link for visual changes" scored 0.90');
    expect(stdout).toContain('rebase main (message): "Never force push" best score 0.41');
  });

  it("sends Jev only the conditions, never the instructions", async () => {
    const matcher = exampleMatcher();
    await report([example], matcher);
    const sent = matcher.calls.flatMap((call) => call.conditions.map((c) => c.text));
    expect(sent).toContain("The user's message asks for a short answer.");
    expect(sent.some((text) => text.includes("localhost link"))).toBe(false);
  });

  it("uses the settings it is given", async () => {
    const matcher = exampleMatcher();
    const result = await report([example, "--cutoff", "0.85", "--time-limit", "5000"], matcher);
    expect(result.settings).toEqual({ cutoff: 0.85, timeLimitMs: 5000 });
    // At 0.85 only the reply rule's 0.9 still matches.
    expect(result.summary).toMatchObject({ right: 1, wrong: 1, missed: 2 });
  });

  it("lists failed checks apart, without counting them as misses", async () => {
    const matcher = standInMatcher({}, { answer: async () => Promise.reject(new Error("Jev returned HTTP 503")) });
    const result = await report([example], matcher);
    expect(result.summary).toMatchObject({ cases: 5, completed: 0, failed: 5, missed: 0, wrongMatchRate: null });
    expect(result.cases[0]!.error).toBe("Jev returned HTTP 503 (second try; the first failed: Jev returned HTTP 503)");
  });

  it("leaves skipped checks out of the wrong-match rate, timing and tokens", async () => {
    const file = evaluationFile({
      rules: [{ name: "Brief replies", check: "message", conditions: [SHORT] }],
      cases: [
        { label: "short answer", check: "message", text: "Just tell me in one line: does the build pass?", expected: [] },
        { label: "bare command", check: "message", text: "/review", expected: [] },
      ],
    });
    const result = await report([file], exampleMatcher());
    expect(result.summary).toMatchObject({
      cases: 2,
      completed: 2,
      skipped: 1,
      ran: 1,
      checksWithWrongMatch: 1,
      wrongMatchRate: 1,
      inputTokens: { total: 120, largestCheck: 120 },
    });
  });

  it("scores each condition only against texts of the check types it is on for", async () => {
    const ASKS = "The user's message asks for a visual change.";
    const NO_LINK = "The reply reports a visual change and gives no local link.";
    const LAYOUT = "The text is about a page's layout.";
    const OFF = "The text mentions colours.";
    const file = evaluationFile({
      rules: [
        {
          name: "Local link",
          conditions: [
            { text: ASKS, message: true },
            { text: NO_LINK, reply: true },
            { text: LAYOUT, message: true, reply: true },
            { text: OFF, message: false, reply: false },
          ],
        },
      ],
      cases: [
        { label: "asks", check: "message", text: "Make the button blue.", expected: ["Local link"] },
        { label: "done", check: "reply", text: "Done: the button is blue.", expected: ["Local link"] },
      ],
    });
    const matcher = standInMatcher({ [ASKS]: 0.9, [NO_LINK]: 0.9, [OFF]: 0.99 });
    const result = await report([file], matcher);

    expect(matcher.calls.map((call) => [call.text, call.conditions.map((c) => c.text)])).toEqual([
      ["Make the button blue.", [ASKS, LAYOUT]],
      ["Done: the button is blue.", [NO_LINK, LAYOUT]],
    ]);
    expect(result.conditions).toEqual({ message: { total: 2, padding: 0 }, reply: { total: 2, padding: 0 } });
    expect(result.summary).toMatchObject({ right: 2, wrong: 0, missed: 0 });
  });

  it("never touches the user's database", async () => {
    await report([example], exampleMatcher());
    expect(existsSync(databasePath(sandbox.env))).toBe(false);
  });
});

describe("the scale run", () => {
  it("pads each check type to several hundred conditions and leads with the wrong-match rate", async () => {
    // One padding condition about sourdough scores high on every check.
    const matcher = exampleMatcher({ extra: (condition) => (/help with a sourdough starter/.test(condition) ? 0.95 : undefined) });
    const result = await report([example, "--scale"], matcher);

    expect(result.scale).toBe(true);
    expect(result.conditions).toEqual({ message: { total: 400, padding: 397 }, reply: { total: 400, padding: 399 } });
    for (const call of matcher.calls) expect(call.conditions).toHaveLength(400);
    const messageWrong = result.cases.filter((c) => c.check === "message").map((c) => c.wrong);
    for (const wrong of messageWrong) {
      expect(wrong).toContainEqual({ name: expect.stringMatching(/^Padding message /), score: 0.95, padding: true });
    }
    // Every message check had a wrong match; one of the two replies did.
    expect(result.summary.checksWithWrongMatch).toBe(4);
    expect(result.summary.wrongMatchRate).toBe(0.8);

    const text = await evaluate([example, "--scale"], matcher);
    const lines = text.stdout.split("\n");
    expect(lines[0]).toBe("Scale run: 5 cases (3 messages, 2 replies)");
    expect(lines.find((line) => line.startsWith("Wrong-match") || line.startsWith("Right"))).toBe(
      "Wrong-match rate: 80.0% (4 of 5 checks that ran had a wrong match)",
    );
    expect(text.stdout).toContain("[padding] scored 0.95");
  });

  it("pads to the number of conditions asked for, from the file's own padding when it has some", async () => {
    const path = evaluationFile({
      rules: [{ name: "Brief", check: "message", conditions: ["The user's message asks for a short answer."] }],
      cases: [{ check: "message", text: "Keep it short please.", expected: ["Brief"] }],
      padding: { message: ["Pad one.", "Pad two.", "Pad three."] },
    });
    const matcher = standInMatcher({ "The user's message asks for a short answer.": 0.9 });
    const result = await report([path, "--conditions", "3"], matcher);
    expect(result.scale).toBe(true);
    expect(result.conditions.message).toEqual({ total: 3, padding: 2 });
    expect(matcher.calls[0]!.conditions.map((c) => c.text)).toEqual([
      "The user's message asks for a short answer.",
      "Pad one.",
      "Pad two.",
    ]);
    expect(result.cases[0]!.label).toBe("#1");
  });

  it("refuses when the padding cannot reach the number asked for", async () => {
    const { code, stderr } = await evaluate([example, "--conditions", "800"], standInMatcher());
    expect(code).toBe(1);
    expect(stderr).toContain("there are 500 built in");
  });
});

describe("the evaluation file", () => {
  const rules = [{ name: "Brief", check: "message", conditions: ["The user's message asks for a short answer."] }];

  it.each([
    ["not JSON", "{", "not valid JSON"],
    ["no rules", { rules: [], cases: [] }, 'non-empty "rules"'],
    ["no cases", { rules, cases: [] }, 'non-empty "cases"'],
    ["an unknown expected rule", { rules, cases: [{ check: "message", text: "Hi there", expected: ["Nope"] }] }, '"Nope"'],
    [
      "a rule of the other check type",
      { rules, cases: [{ check: "reply", text: "Done.", expected: ["Brief"] }] },
      'expects "Brief", which has no condition on for reply',
    ],
    [
      "a rule whose conditions are only on for the other check type",
      {
        rules: [{ name: "Brief", conditions: [{ text: "The message asks for a short answer.", message: true }] }],
        cases: [{ check: "reply", text: "Done.", expected: ["Brief"] }],
      },
      'expects "Brief", which has no condition on for reply',
    ],
    [
      "a condition given as text in a rule with no check",
      { rules: [{ name: "Brief", conditions: ["C."] }], cases: [{ check: "message", text: "Hi", expected: [] }] },
      `needs the rule's "check"`,
    ],
    [
      "a rule with no condition on",
      { rules: [{ name: "Brief", conditions: [{ text: "C." }] }], cases: [{ check: "message", text: "Hi", expected: [] }] },
      'needs a condition on for "message" or "reply"',
    ],
    [
      "a condition with no wording",
      {
        rules: [{ name: "Brief", conditions: [{ text: "C.", message: true }, { text: "  ", reply: true }] }],
        cases: [{ check: "message", text: "Hi", expected: [] }],
      },
      "has a condition with no wording",
    ],
    [
      "a switch that is not true or false",
      { rules: [{ name: "Brief", conditions: [{ text: "C.", message: "yes" }] }], cases: [{ check: "message", text: "Hi", expected: [] }] },
      `a condition's "message" is true or false`,
    ],
    ["a missing expected list", { rules, cases: [{ check: "message", text: "Hi there" }] }, '"expected"'],
    ["a bad check type", { rules: [{ ...rules[0], check: "tool" }], cases: [{ check: "message", text: "Hi", expected: [] }] }, '"check" is "message" or "reply"'],
  ])("is refused with %s, before Jev is called", async (_, content, message) => {
    const matcher = standInMatcher();
    const { code, stderr } = await evaluate([evaluationFile(content)], matcher);
    expect(code).toBe(1);
    expect(stderr).toContain(message);
    expect(matcher.calls).toHaveLength(0);
  });
});

describe("the command", () => {
  function sally(...args: string[]) {
    const result = spawnSync(process.execPath, [cli, "evaluate", ...args], {
      encoding: "utf8",
      env: sandbox.childEnv(),
    });
    return { status: result.status, stdout: result.stdout, stderr: result.stderr };
  }

  it("needs an API key and says where to put it", () => {
    const result = sally(example);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("TYPESAFE_API_KEY");
  });

  it("explains itself", () => {
    const result = sally("--help");
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("node src/cli.ts evaluate FILE");
  });

  it("needs one evaluation file", () => {
    const result = sally();
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("one evaluation file");
  });
});
