import { describe, expect, it } from "vitest";
import { addressOf, parseAuthResults, parseMessage } from "../../src/gmail/parse.js";

const b64 = (s: string) => Buffer.from(s).toString("base64url");

describe("gmail parsing", () => {
  it("extracts addresses", () => {
    expect(addressOf("Jack Smith <Jack@ColEven.com>")).toBe("jack@coleven.com");
    expect(addressOf("plain@x.io")).toBe("plain@x.io");
  });

  it("reads SPF and DKIM results", () => {
    expect(parseAuthResults("mx.google.com; dkim=pass header.i=@x.io; spf=pass smtp.mailfrom=x.io")).toEqual({ spf: "pass", dkim: "pass" });
    expect(parseAuthResults("spf=softfail")).toEqual({ spf: "fail", dkim: "unknown" });
  });

  it("parses a multipart message, preferring text/plain, listing attachments", () => {
    const email = parseMessage({
      id: "abc",
      threadId: "t",
      snippet: "snip",
      payload: {
        mimeType: "multipart/mixed",
        headers: [
          { name: "From", value: "Jack <jack@coleven.com>" },
          { name: "To", value: "a@x.io, B <b@y.io>" },
          { name: "Subject", value: "Bug" },
          { name: "Authentication-Results", value: "spf=pass dkim=pass" },
        ],
        parts: [
          {
            mimeType: "multipart/alternative",
            parts: [
              { mimeType: "text/plain", body: { data: b64("The graph is broken") } },
              { mimeType: "text/html", body: { data: b64("<p>The graph is <b>broken</b></p>") } },
            ],
          },
          { mimeType: "image/png", filename: "screen.png", body: { attachmentId: "att1", size: 1234 } },
        ],
      },
    });
    expect(email.fromAddress).toBe("jack@coleven.com");
    expect(email.to).toEqual(["a@x.io", "b@y.io"]);
    expect(email.body).toBe("The graph is broken");
    expect(email.attachments).toEqual([{ filename: "screen.png", mimeType: "image/png", size: 1234 }]);
    expect(email.auth.spf).toBe("pass");
  });

  it("falls back to stripped HTML", () => {
    const email = parseMessage({
      id: "x",
      payload: { mimeType: "text/html", headers: [], body: { data: b64("<div>Hi<br>there</div><script>x()</script>") } },
    });
    expect(email.body).toBe("Hi\nthere");
  });
});
