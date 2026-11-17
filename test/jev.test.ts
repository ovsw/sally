import { createServer, type IncomingHttpHeaders, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { createJevMatcher } from "../src/jev.ts";
import { MalformedAnswerError } from "../src/matcher.ts";

// A local stand-in for Jev's HTTP endpoint: the real API is never called.
let server: Server | undefined;
afterEach(() => new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve())));

interface Received {
  headers: IncomingHttpHeaders;
  body: unknown;
}

async function fakeJev(reply: (body: unknown) => { status?: number; body: string }): Promise<{ url: string; received: Received[] }> {
  const received: Received[] = [];
  server = createServer((req, res) => {
    let raw = "";
    req.on("data", (chunk) => (raw += chunk));
    req.on("end", () => {
      const body = JSON.parse(raw);
      received.push({ headers: req.headers, body });
      const { status = 200, body: out } = reply(body);
      res.writeHead(status, { "Content-Type": "application/json" }).end(out);
    });
  });
  await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", resolve));
  return { url: `http://127.0.0.1:${(server!.address() as AddressInfo).port}/v1/systemone`, received };
}

const conditions = [
  { id: "c1", text: "The message asks for a visual change." },
  { id: "c2", text: "The message mentions a pull request." },
];
const signal = () => new AbortController().signal;

describe("Jev matcher", () => {
  it("sends the text as the state and each condition as one Noul question", async () => {
    const jev = await fakeJev(() => ({
      body: JSON.stringify({
        model: "jev-1.13.0",
        answers: { c1: { type: "noul", noul: 0.8 }, c2: { type: "noul", noul: 0.1 } },
        usage: { input_tokens: 120, output_tokens: 12 },
      }),
    }));

    const result = await createJevMatcher({ apiKey: "test-key", url: jev.url }).match("Make it blue", conditions, signal());

    expect(result).toEqual({ scores: { c1: 0.8, c2: 0.1 }, inputTokens: 120 });
    expect(jev.received[0]!.headers.authorization).toBe("Bearer test-key");
    expect(jev.received[0]!.body).toEqual({
      model: "jev-latest",
      state: "Make it blue",
      questions: {
        c1: { type: "noul", instructions: "The message asks for a visual change." },
        c2: { type: "noul", instructions: "The message mentions a pull request." },
      },
    });
  });

  it("ignores answers for IDs that were not sent", async () => {
    const jev = await fakeJev(() => ({
      body: JSON.stringify({
        answers: { c1: { noul: 0.5 }, c2: { noul: 0.5 }, c3: { noul: 0.99 } },
        usage: { input_tokens: 1 },
      }),
    }));
    const result = await createJevMatcher({ apiKey: "k", url: jev.url }).match("x", conditions, signal());
    expect(result.scores).toEqual({ c1: 0.5, c2: 0.5 });
  });

  it("rejects an answer missing a sent ID as malformed", async () => {
    const jev = await fakeJev(() => ({ body: JSON.stringify({ answers: { c1: { noul: 0.5 } } }) }));
    await expect(createJevMatcher({ apiKey: "k", url: jev.url }).match("x", conditions, signal())).rejects.toBeInstanceOf(
      MalformedAnswerError,
    );
  });

  it("rejects a body that is not JSON as malformed", async () => {
    const jev = await fakeJev(() => ({ body: "<html>" }));
    await expect(createJevMatcher({ apiKey: "k", url: jev.url }).match("x", conditions, signal())).rejects.toBeInstanceOf(
      MalformedAnswerError,
    );
  });

  it("rejects an HTTP error", async () => {
    const jev = await fakeJev(() => ({ status: 401, body: JSON.stringify({ detail: "bad key" }) }));
    await expect(createJevMatcher({ apiKey: "k", url: jev.url }).match("x", conditions, signal())).rejects.toThrow(
      "Jev returned HTTP 401",
    );
  });
});
