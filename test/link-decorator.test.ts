// The link decorator against DOM captured from bb's timeline (sanitized
// fixtures in test/fixtures), parsed with linkedom.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import {
  createLinkDecorator,
  findMediaLinks,
  messageSeqFromRowId,
  OWNED_ATTRIBUTE,
  playerAnchorFor,
  threadIdFromLocation,
  threadIdFromRowId,
} from "../lib/link-decorator.ts";

// Loaded untyped: linkedom's own .d.ts files don't type-check against lib.dom (skipLibCheck is off).
const { parseHTML } = createRequire(import.meta.url)("linkedom") as {
  parseHTML(html: string): { document: Document & { getElementById(id: string): HTMLElement | null } };
};

const here = path.dirname(fileURLToPath(import.meta.url));
const fixture = (name: string) => readFileSync(path.join(here, "fixtures", name), "utf8");

function load(...names: string[]) {
  const html = `<!doctype html><html><body>${names.map(fixture).join("\n")}</body></html>`;
  const { document } = parseHTML(html);
  return document as unknown as Document;
}

function snapshotAnchors(doc: Document): string[] {
  return Array.from(doc.querySelectorAll("a")).map((a) => a.outerHTML);
}

describe("row id helpers", () => {
  it("reads the thread id and user message seq", () => {
    assert.equal(threadIdFromRowId("thr_example:assistant:kind:assistant|turn:t1"), "thr_example");
    assert.equal(threadIdFromRowId("thr_example:user-seed:42"), "thr_example");
    assert.equal(messageSeqFromRowId("thr_example:user-seed:42"), 42);
    assert.equal(messageSeqFromRowId("thr_example:assistant:kind:assistant|turn:t1"), null);
    assert.equal(threadIdFromRowId(null), null);
    assert.equal(threadIdFromRowId("bad id!:x"), null);
  });
  it("reads the thread id from the URL", () => {
    assert.equal(threadIdFromLocation("/projects/proj_x/threads/thr_abc"), "thr_abc");
    assert.equal(threadIdFromLocation("/settings"), null);
  });
});

describe("findMediaLinks on captured timeline markup", () => {
  it("finds media file: links in an agent reply and ignores other links", () => {
    const doc = load("timeline-assistant-links.html");
    const matches = findMediaLinks(doc);
    assert.deepEqual(
      matches.map((m) => [m.path, m.kind, m.threadId, m.messageSeq]),
      [
        ["/Users/example/project/out/demo.mp4", "video", "thr_example", null],
        ["/Users/example/Movies/My Clip #1.mov", "video", "thr_example", null],
        ["/Users/example/project/voice/take-2.M4A", "audio", "thr_example", null],
      ],
    );
    assert.equal(matches[1]?.name, "My Clip #1.mov");
  });
  it("finds links in a user message with its message seq", () => {
    const doc = load("timeline-user-link.html");
    const matches = findMediaLinks(doc);
    assert.deepEqual(matches.map((m) => [m.path, m.kind, m.messageSeq]), [["/Users/example/Downloads/voice-memo.m4a", "audio", 42]]);
  });
  it("ignores file links outside message bodies and markup without bb's signals", () => {
    const { document } = parseHTML(`<!doctype html><html><body>
      <nav><a href="file:///Users/example/a.mp4">sidebar</a></nav>
      <div data-timeline-row-id="thr_x:assistant"><a href="file:///Users/example/b.mp4">not in a body</a></div>
      <div data-markdown-preview=""><a href="file:///Users/example/c.mp4">not in a row</a></div>
      <div class="message"><p><a href="file:///Users/example/d.mp4">renamed markup</a></p></div>
    </body></html>`);
    assert.deepEqual(findMediaLinks(document as unknown as ParentNode), []);
  });
  it("ignores remote hosts, bad encodings and non-media links inside bodies", () => {
    const { document } = parseHTML(`<!doctype html><html><body>
      <div data-timeline-row-id="thr_x:assistant"><div data-markdown-preview="">
        <a href="file://server/share/x.mp4">b</a>
        <a href="file:///Users/example/notes.txt">c</a>
        <a href="file:///Users/example/%zz.mp4">d</a>
      </div></div>
    </body></html>`);
    assert.equal(findMediaLinks(document as unknown as ParentNode).length, 0);
  });
  it("takes the path the file: URL resolves to (dot segments collapse; the server checks the rest)", () => {
    const { document } = parseHTML(`<!doctype html><html><body>
      <div data-timeline-row-id="thr_x:assistant"><div data-markdown-preview=""><a href="file:///Users/example/../secret.mp4">a</a></div></div>
    </body></html>`);
    assert.deepEqual(findMediaLinks(document as unknown as ParentNode).map((m) => m.path), ["/Users/secret.mp4"]);
  });
  it("uses the fallback thread id when the row id has none", () => {
    const { document } = parseHTML(`<!doctype html><html><body>
      <div data-timeline-row-id="??"><div data-markdown-preview=""><p><a href="file:///x/a.mp4">a</a></p></div></div>
    </body></html>`);
    assert.equal(findMediaLinks(document as unknown as ParentNode).length, 0);
    assert.equal(findMediaLinks(document as unknown as ParentNode, "thr_url")[0]?.threadId, "thr_url");
  });
});

describe("createLinkDecorator", () => {
  function setup(names = ["timeline-assistant-links.html", "timeline-user-link.html"]) {
    const doc = load(...names);
    const opened: { path: string; container: HTMLElement }[] = [];
    const closed: HTMLElement[] = [];
    const controller = new AbortController();
    const decorator = createLinkDecorator({
      root: doc.body,
      document: doc,
      signal: controller.signal,
      open: (match, container) => opened.push({ path: match.path, container }),
      close: (container) => closed.push(container),
    });
    return { doc, decorator, controller, opened, closed };
  }

  it("inserts one ▶ button right after each media link, without changing bb's nodes", () => {
    const doc = load("timeline-assistant-links.html", "timeline-user-link.html");
    const before = snapshotAnchors(doc);
    const decorator = createLinkDecorator({
      root: doc.body,
      document: doc,
      signal: new AbortController().signal,
      open: () => undefined,
      close: () => undefined,
    });
    assert.equal(decorator.count, 4);
    assert.deepEqual(snapshotAnchors(doc), before);
    const buttons = Array.from(doc.querySelectorAll(`button[${OWNED_ATTRIBUTE}="toggle"]`));
    assert.equal(buttons.length, 4);
    for (const button of buttons) {
      const link = button.previousSibling as Element;
      assert.equal(link.tagName, "A");
      assert.match(link.getAttribute("href") ?? "", /^file:/);
      assert.equal(button.getAttribute("aria-expanded"), "false");
    }
    // A rescan doesn't add duplicates.
    decorator.scan();
    assert.equal(doc.querySelectorAll(`button[${OWNED_ATTRIBUTE}="toggle"]`).length, 4);
    decorator.dispose();
  });

  it("opens a player container under the link's paragraph and closes it again", () => {
    const { doc, decorator, opened, closed } = setup(["timeline-user-link.html"]);
    const button = doc.querySelector(`button[${OWNED_ATTRIBUTE}="toggle"]`) as HTMLButtonElement;
    button.dispatchEvent(new (doc.defaultView as unknown as typeof globalThis).Event("click"));
    assert.equal(opened.length, 1);
    assert.equal(opened[0]?.path, "/Users/example/Downloads/voice-memo.m4a");
    const container = opened[0]!.container;
    assert.equal(container.getAttribute(OWNED_ATTRIBUTE), "player");
    const paragraph = button.closest("p")!;
    assert.equal(paragraph.nextElementSibling, container);
    assert.equal(button.getAttribute("aria-expanded"), "true");
    button.dispatchEvent(new (doc.defaultView as unknown as typeof globalThis).Event("click"));
    assert.deepEqual(closed, [container]);
    assert.equal(container.isConnected, false);
    assert.equal(button.getAttribute("aria-expanded"), "false");
    decorator.dispose();
  });

  it("removes a button when bb re-renders its link, then decorates the new link", () => {
    const { doc, decorator } = setup(["timeline-user-link.html"]);
    const link = doc.querySelector('a[href^="file:"]')!;
    const replacement = link.cloneNode(true) as Element;
    link.replaceWith(replacement);
    decorator.scan();
    const buttons = Array.from(doc.querySelectorAll(`button[${OWNED_ATTRIBUTE}="toggle"]`));
    assert.equal(buttons.length, 1);
    assert.equal(buttons[0]?.previousSibling, replacement);
    decorator.dispose();
  });

  it("cleans up every inserted element on abort", () => {
    const { doc, controller, opened, closed } = setup();
    const before = snapshotAnchors(doc);
    const button = doc.querySelector(`button[${OWNED_ATTRIBUTE}="toggle"]`) as HTMLButtonElement;
    button.dispatchEvent(new (doc.defaultView as unknown as typeof globalThis).Event("click"));
    assert.equal(opened.length, 1);
    controller.abort();
    assert.equal(doc.querySelectorAll(`[${OWNED_ATTRIBUTE}]`).length, 0);
    assert.deepEqual(closed, [opened[0]!.container]);
    assert.deepEqual(snapshotAnchors(doc), before);
  });

  it("does nothing on markup without bb's signals, and on an aborted signal", () => {
    const { document } = parseHTML(`<!doctype html><html><body><p><a href="file:///x/a.mp4">a</a></p></body></html>`);
    const doc = document as unknown as Document;
    const quiet = createLinkDecorator({ root: doc.body, document: doc, signal: new AbortController().signal, open: () => undefined, close: () => undefined });
    assert.equal(quiet.count, 0);
    const aborted = new AbortController();
    aborted.abort();
    const fixtureDoc = load("timeline-assistant-links.html");
    const none = createLinkDecorator({ root: fixtureDoc.body, document: fixtureDoc, signal: aborted.signal, open: () => undefined, close: () => undefined });
    assert.equal(none.count, 0);
    assert.equal(fixtureDoc.querySelectorAll(`[${OWNED_ATTRIBUTE}]`).length, 0);
  });

  it("survives callbacks that throw", () => {
    const doc = load("timeline-user-link.html");
    const decorator = createLinkDecorator({
      root: doc.body,
      document: doc,
      signal: new AbortController().signal,
      open: () => {
        throw new Error("boom");
      },
      close: () => {
        throw new Error("boom");
      },
    });
    const button = doc.querySelector(`button[${OWNED_ATTRIBUTE}="toggle"]`) as HTMLButtonElement;
    assert.doesNotThrow(() => button.dispatchEvent(new (doc.defaultView as unknown as typeof globalThis).Event("click")));
    assert.doesNotThrow(() => decorator.dispose());
    assert.equal(doc.querySelectorAll(`[${OWNED_ATTRIBUTE}]`).length, 0);
  });

  it("puts the player after the list item or paragraph, else after the link", () => {
    const { document } = parseHTML(`<!doctype html><html><body>
      <div data-markdown-preview=""><ul><li><a id="a" href="#">x</a></li></ul><a id="b" href="#">y</a></div>
    </body></html>`);
    assert.equal(playerAnchorFor(document.getElementById("a")!).tagName, "LI");
    assert.equal(playerAnchorFor(document.getElementById("b")!).id, "b");
  });
});
