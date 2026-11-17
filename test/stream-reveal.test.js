import test from "node:test";
import assert from "node:assert/strict";
import { completeMarkdown } from "../web/assets/ui/stream-reveal.js";

test("a streaming reply never shows open markdown syntax", () => {
  // Inline code and bold close until their partner arrives.
  assert.equal(completeMarkdown("1. 增加 `--avg"), "1. 增加 `--avg`");
  assert.equal(completeMarkdown("累计**行数与"), "累计**行数与**");
  // An open fence closes, so the half block renders as code.
  assert.equal(completeMarkdown("```bash\nif [[ $1"), "```bash\nif [[ $1\n```");
  // A marker with nothing after it waits for its text.
  assert.equal(completeMarkdown("改动如下\n\n## "), "改动如下\n");
  assert.equal(completeMarkdown("步骤\n2."), "步骤");
});

test("a table shows once its separator row arrives, and only whole rows", () => {
  assert.equal(completeMarkdown("说明\n\n| 参数 | 含义 |"), "说明\n");
  assert.equal(
    completeMarkdown("| 参数 | 含义 |\n|---|---|\n| --avg | 输出平"),
    "| 参数 | 含义 |\n|---|---|"
  );
  const whole = "| 参数 | 含义 |\n|---|---|\n| --avg | 输出平均值 |";
  assert.equal(completeMarkdown(whole), whole);
});

test("finished markdown passes through unchanged", () => {
  const text = "完成。\n\n```js\nconst a = 1;\n```\n\n用 `--max` 看最大值。";
  assert.equal(completeMarkdown(text), text);
});
