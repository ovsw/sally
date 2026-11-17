// Made-up conditions that pad the rule set for the evaluation's scale run.
// They are about everyday subjects far from software work, so none of them
// should hold of a message or reply from a coding session: any match of one
// is a wrong match. They are built from templates rather than listed, so the
// set is large and varied without being hand-written.
import type { CheckType } from "./rules.ts";

const SUBJECTS = [
  "a sourdough starter",
  "a vegetable garden",
  "houseplants",
  "a marathon training plan",
  "a wedding",
  "a family holiday abroad",
  "a used car",
  "a mortgage",
  "a tax return",
  "a retirement savings plan",
  "a new puppy",
  "a cat's diet",
  "a tropical aquarium",
  "a chess opening",
  "an acoustic guitar",
  "piano lessons",
  "a wine pairing",
  "a vegan dinner party",
  "a home espresso machine",
  "a kitchen renovation",
  "a leaking roof",
  "a bathroom tiling job",
  "a camping trip",
  "a ski holiday",
  "hiking boots",
  "a bicycle repair",
  "a yoga routine",
  "a sleep schedule",
  "a knee injury",
  "a head cold",
  "a job interview",
  "a resignation letter",
  "a birthday party",
  "a baby shower",
  "a poetry collection",
  "a novel's plot",
  "a watercolour painting",
  "a pottery class",
  "a knitting pattern",
  "a fishing trip",
  "a football team",
  "a tennis racket",
  "a golf swing",
  "a board game night",
  "a crossword puzzle",
  "a beehive",
  "a chicken coop",
  "a compost heap",
  "moving house",
  "a passport renewal",
];

const TEMPLATES: Record<CheckType, ((subject: string) => string)[]> = {
  message: [
    (s) => `The user's message asks for help with ${s}.`,
    (s) => `The user's message asks for a recommendation about ${s}.`,
    (s) => `The user's message reports a problem with ${s}.`,
    (s) => `The user's message asks how much ${s} costs.`,
    (s) => `The user's message asks to compare options for ${s}.`,
    (s) => `The user's message shares an opinion about ${s}.`,
    (s) => `The user's message asks for a schedule for ${s}.`,
    (s) => `The user's message asks what to buy for ${s}.`,
    (s) => `The user's message asks for safety advice about ${s}.`,
    (s) => `The user's message asks about the history of ${s}.`,
  ],
  reply: [
    (s) => `This reply gives advice about ${s}.`,
    (s) => `This reply recommends a product for ${s}.`,
    (s) => `This reply explains how to fix a problem with ${s}.`,
    (s) => `This reply quotes a price for ${s}.`,
    (s) => `This reply compares options for ${s}.`,
    (s) => `This reply gives a schedule for ${s}.`,
    (s) => `This reply warns about a safety risk with ${s}.`,
    (s) => `This reply tells the history of ${s}.`,
    (s) => `This reply lists what to buy for ${s}.`,
    (s) => `This reply shares an opinion about ${s}.`,
  ],
};

/** How many padding conditions there are for each check type. */
export const PADDING_AVAILABLE = SUBJECTS.length * TEMPLATES.message.length;

/**
 * The first `count` padding conditions for the check type, mixed so that
 * neighbouring conditions differ in both subject and template.
 */
export function paddingConditions(checkType: CheckType, count: number): string[] {
  if (count > PADDING_AVAILABLE) {
    throw new Error(`There are only ${PADDING_AVAILABLE} built-in padding conditions per check type.`);
  }
  const templates = TEMPLATES[checkType];
  const conditions: string[] = [];
  for (let i = 0; i < count; i++) {
    const subject = SUBJECTS[i % SUBJECTS.length]!;
    // Shift the template once per pass over the subjects, so every pair is used once.
    const template = templates[(i + Math.floor(i / SUBJECTS.length)) % templates.length]!;
    conditions.push(template(subject));
  }
  return conditions;
}
