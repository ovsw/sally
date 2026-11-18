// The Guide screen, built on the shadcnblocks block blogpost3 (long-form
// article with sticky in-page navigation and a bordered side card).
//
// The advice on writing rules is not written here: it comes from
// docs/writing-rules.md, the one source the import skill reads too.
import { ArrowRight } from "lucide-react";
import { cn } from "cn";
import * as React from "react";

import writingRules from "../../../docs/writing-rules.md?raw";
import { Button } from "@/components/ui/button";
import { fromFirstSection, renderMarkdown, sections } from "@/lib/markdown";
import { followLink } from "@/lib/router";

const guidance = fromFirstSection(writingRules);
const guidanceHtml = renderMarkdown(guidance);

const allSections = [
  { id: "what-sally-does", label: "What Sally does on each turn" },
  ...sections(guidance),
  { id: "importing", label: "Importing your rules files" },
  { id: "wrong-matches-and-misses", label: "Wrong matches and misses" },
];

const prose = cn(
  "prose prose-neutral dark:prose-invert",
  "prose-headings:scroll-mt-8 prose-headings:font-semibold prose-headings:tracking-tight",
  "prose-code:rounded prose-code:bg-muted prose-code:px-1 prose-code:py-0.5 prose-code:font-normal",
  "prose-code:before:content-none prose-code:after:content-none",
);

function WhatSallyDoes() {
  return (
    <section>
      <h2 id="what-sally-does" className="mt-0">
        What Sally does on each turn
      </h2>
      <p>
        Sally keeps your rules and decides, on every turn, which of them apply. Each rule
        has one or more conditions and one instruction. Claude sees only the instructions
        of the rules that match.
      </p>
      <ol>
        <li>
          <strong>You send a message.</strong> Before Claude starts work, Sally runs a{" "}
          <em>message check</em>. It asks Jev how likely each condition of your
          message-check rules is to hold of your message. Jev gives each condition a score
          from 0 to 1.
        </li>
        <li>
          <strong>Rules that reach the cutoff are attached.</strong> A rule matches when
          any one of its conditions reaches the cutoff (0.6 unless you change it in
          Settings). Its name and instruction go with your message. When no rule matches,
          Sally adds nothing.
        </li>
        <li>
          <strong>Claude finishes its reply.</strong> Sally runs a <em>reply check</em> on
          the final reply against your reply-check rules. When one matches, the reply is
          sent back: Claude gets the instruction and one chance to revise before the turn
          ends.
        </li>
      </ol>
      <p>
        Only live versions count. A draft changes nothing until you publish it, and a
        rule switched off is left out. A rule scoped to named projects is checked only in
        those projects.
      </p>
      <p>
        Most turns match no rule, and that is the point. Because Sally is usually silent,
        Claude takes its output seriously when it appears. Every check is recorded, so
        you can see on the Activity screen what Sally did and why.
      </p>
    </section>
  );
}

function Importing() {
  return (
    <section>
      <h2 id="importing">Importing your rules files</h2>
      <p>
        Your rules probably exist already, as text in your rules files. An import turns
        the conditional rules in one rules file into drafts in Sally. Always-rules stay in
        the file.
      </p>
      <ol>
        <li>
          <strong>Start it in Claude Code.</strong> Type <code>/sally-import</code>, or ask
          plainly, for example "import my rules file into Sally". An import starts only
          when you ask for one.
        </li>
        <li>
          <strong>Pick a rules file.</strong> The import skill lists the rules files it
          found. Each import covers one file. Rules from your global rules file apply to
          all projects; rules from a project's rules file are scoped to that project.
        </li>
        <li>
          <strong>The skill proposes.</strong> It splits the file into passages. For each
          passage it gives a verdict (becomes a rule, stays as an always-rule, or stays
          because it is too vague to match on), a short reason, and, where it fits, one or
          more rules as drafts. Nothing is live yet.
        </li>
        <li>
          <strong>Review in Sally's Import screen.</strong> It shows one passage at a time:
          the original text, what it should become, and why. Edit a proposed rule, then
          publish it, keep it as a draft, or skip it. You can overrule a verdict either
          way. There is no "publish all".
        </li>
        <li>
          <strong>Finish in Claude Code.</strong> The skill shows the exact lines it would
          remove from the rules file and asks for your yes. It backs the file up first and
          tells you where the backup is. It removes only the rules you published; drafts
          and skipped passages stay in the file, where they still work.
        </li>
      </ol>
      <p>
        The import skill writes its proposals by the same advice as the sections above,
        so what it proposes and what you write yourself follow one set of rules.
      </p>
    </section>
  );
}

function WrongMatchesAndMisses() {
  return (
    <section>
      <h2 id="wrong-matches-and-misses">Wrong matches and misses</h2>
      <h3>Wrong matches</h3>
      <p>
        A wrong match is a rule that matched when it did not apply. It is the failure that
        matters most: each one teaches Claude to take Sally's output less seriously.
      </p>
      <ul>
        <li>
          Claude can report one itself. Sally's output tells it how:{" "}
          <code>sally wrong-match "&lt;rule name&gt;"</code>.
        </li>
        <li>
          You can flag a match as wrong or right on the rule's page, under Matches. Each
          flag keeps that message or reply as a saved case for the rule.
        </li>
        <li>
          To fix the rule, make the condition narrower: name the request or the failure,
          not the subject. Edits go into a draft. When you publish, Sally first scores the
          draft against the rule's saved cases, so you can see whether the new wording
          stops the wrong match and keeps the right ones.
        </li>
      </ul>
      <h3>Misses</h3>
      <p>
        A miss is a rule that applied and did not match. Look at the rule's near misses:
        scores just under the cutoff. A near miss usually means the situation showed up in
        a way no condition describes. Add a condition for that way, or reword one.
      </p>
      <p>
        The Needs attention screen lists rules worth a look: rules with wrong matches,
        rules that match very often, rules with weak matches, and rules that never match.
      </p>
      <h3>When a check fails</h3>
      <p>
        A check fails when Sally cannot get scores: Jev is slow or returns an error, or no
        API key is set. The turn then goes on untouched, with no rules attached and
        nothing sent back. Your conditional rules live only in Sally, not in a rules file,
        so a turn whose check failed goes without them. The Activity screen lists failed
        checks. If a rule must reach Claude on every turn, keep it in your rules file as
        an always-rule.
      </p>
    </section>
  );
}

function StartHere() {
  return (
    <div className="sticky top-8 hidden h-fit rounded-lg border p-6 lg:block">
      <h2 className="text-xl font-semibold">Start here</h2>
      <div className="my-6 space-y-3 text-sm text-muted-foreground">
        <p>Sally does nothing until it has rules.</p>
        <p>
          To bring in the rules you already have, type{" "}
          <code className="rounded bg-muted px-1 py-0.5 text-foreground">/sally-import</code> in
          Claude Code.
        </p>
        <p>To write a rule yourself, start from the Rules screen.</p>
      </div>
      <div className="flex flex-col gap-2">
        <Button asChild>
          <a href="/rules" onClick={followLink}>
            Write your first rule
            <ArrowRight />
          </a>
        </Button>
        <Button variant="outline" asChild>
          <a href="#importing">How to import</a>
        </Button>
      </div>
    </div>
  );
}

export function GuideScreen() {
  const [activeSection, setActiveSection] = React.useState<string | null>(null);

  // Arriving from another screen with an anchor, such as /guide#importing.
  React.useEffect(() => {
    const id = decodeURIComponent(window.location.hash.slice(1));
    if (id) document.getElementById(id)?.scrollIntoView();
  }, []);

  React.useEffect(() => {
    const elements = allSections
      .map((section) => document.getElementById(section.id))
      .filter((element): element is HTMLElement => element != null);
    const observer = new IntersectionObserver(
      (entries) => {
        const visible = entries.find((entry) => entry.isIntersecting);
        if (visible) setActiveSection(visible.target.id);
      },
      { rootMargin: "-20% 0px -60% 0px", threshold: 0 },
    );
    elements.forEach((element) => observer.observe(element));
    return () => observer.disconnect();
  }, []);

  return (
    <div className="w-full">
      <div className="mb-8 text-left">
        <h1 className="text-2xl font-bold tracking-tight">Guide</h1>
        <p className="mt-2 max-w-3xl text-muted-foreground">
          How Sally works, how to write rules that match well, how to import the rules you
          already have, and what to do when a rule misbehaves.
        </p>
      </div>
      <div className="relative grid max-w-6xl gap-8 lg:grid-cols-4">
        <div className="sticky top-8 hidden h-fit lg:block">
          <span className="text-sm font-medium">On this page</span>
          <nav className="mt-2" aria-label="Guide sections">
            <ul className="space-y-2">
              {allSections.map((section) => (
                <li key={section.id}>
                  <a
                    href={`#${section.id}`}
                    className={cn(
                      "block py-1 transition-colors duration-200",
                      activeSection === section.id
                        ? "font-medium text-primary"
                        : "text-muted-foreground hover:text-primary",
                    )}
                  >
                    {section.label}
                  </a>
                </li>
              ))}
            </ul>
          </nav>
        </div>
        <article className={cn(prose, "min-w-0 lg:col-span-2")}>
          <WhatSallyDoes />
          <div dangerouslySetInnerHTML={{ __html: guidanceHtml }} />
          <Importing />
          <WrongMatchesAndMisses />
        </article>
        <StartHere />
      </div>
    </div>
  );
}
