import { test } from "node:test";
import assert from "node:assert/strict";
import { parseHTML } from "linkedom";
import {
  clipboardHtmlText,
  createComposerClipboard,
  numberPastedImages
} from "../web/assets/controllers/composer-clipboard.js";

function fixture() {
  const listeners = new Map();
  const files = [];
  const events = [];
  const { document } = parseHTML("<html><body></body></html>");
  const input = {
    ownerDocument: document,
    value: "旧草稿尾部",
    selectionStart: 3,
    selectionEnd: 5,
    setRangeText(text, start, end) {
      this.value = this.value.slice(0, start) + text + this.value.slice(end);
    },
    dispatchEvent: (event) => events.push(event),
    addEventListener: (name, listener) => listeners.set(name, listener),
    removeEventListener: (name) => listeners.delete(name)
  };
  const controller = createComposerClipboard({ input, addFiles: (images) => files.push(...images) });
  const paste = (text, items, defaultPrevented = false, html = "") => {
    const event = {
      defaultPrevented,
      clipboardData: { getData: (type) => (type === "text/plain" ? text : html), items },
      preventDefault() {
        this.defaultPrevented = true;
      }
    };
    listeners.get("paste")(event);
    return event;
  };
  return { files, paste, controller, listeners, input, events };
}
const image = new File(["png bytes"], "image.png", { type: "image/png" });
const items = [{ kind: "file", type: "image/png", getAsFile: () => image }];

test("mixed clipboard text including whitespace keeps the native insertion path", () => {
  const f = fixture();
  for (const text of ["文字\n第二行", " \n "]) assert.equal(f.paste(text, items).defaultPrevented, false);
  assert.deepEqual(f.files, []);
});

test("image-only clipboard attaches files, ignores unavailable images and respects handled events", () => {
  const f = fixture();
  assert.equal(f.paste("", items).defaultPrevented, true);
  assert.deepEqual(
    f.files.map((file) => [file.name, file.type, file.size]),
    [["image-1.png", "image/png", image.size]]
  );
  assert.equal(
    f.paste("", [{ kind: "file", type: "image/png", getAsFile: () => null }]).defaultPrevented,
    false
  );
  f.paste("", items, true);
  assert.equal(f.files.length, 1);
  f.controller.dispose();
  assert.equal(f.listeners.has("paste"), false);
});

test("pasted images take the next numbers the draft has not used, so the same picture can be pasted twice", () => {
  const names = (images, attached) => numberPastedImages(images, attached).map((file) => file.name);
  const jpeg = new File(["jpeg bytes"], "image.jpeg", { type: "image/jpeg" });
  assert.deepEqual(names([image, image], []), ["image-1.png", "image-2.png"]);
  // A copied file with a name of its own keeps it and takes no number.
  const named = new File(["png bytes"], "设计稿.png", { type: "image/png" });
  assert.deepEqual(names([named, image], []), ["设计稿.png", "image-1.png"]);
  // A gap left by a removed attachment is filled before counting on; other names are not numbers.
  assert.deepEqual(names([image, jpeg], ["image-1.png", "image-3.png", "image.png", "报告.pdf"]), [
    "image-2.png",
    "image-4.jpg"
  ]);
});

test("inert HTML extraction preserves paragraphs and breaks without scripts or image placeholders", () => {
  const { document } = parseHTML("<html><body></body></html>");
  assert.equal(
    clipboardHtmlText(
      '<p>第一行<br>第二行</p><div>第三行</div><script>坏文本</script><style>坏样式</style><img src="https://example.org/remote.png">',
      document
    ),
    "第一行\n第二行\n第三行"
  );
  assert.equal(clipboardHtmlText('<img src="https://example.org/remote.png">', document), "");
});

test("HTML-only text replaces the selected draft and emits the shared saving input event", () => {
  const f = fixture();
  assert.equal(f.paste("", items, false, "<p>第一行<br>第二行</p>").defaultPrevented, true);
  assert.equal(f.input.value, "旧草稿第一行\n第二行");
  assert.deepEqual(f.files, []);
  assert.equal(f.events.length, 1);
  assert.equal(f.events[0].type, "input");
  assert.equal(f.events[0].bubbles, true);
});
