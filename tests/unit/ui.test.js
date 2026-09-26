import { test } from "node:test";
import assert from "node:assert/strict";
import { renderMarkdown } from "../../site/js/ui.js";

test("renderMarkdown: paragraphs, lists, emphasis, headings - with HTML escaped", () => {
  assert.equal(renderMarkdown("A was **warmer** by 1.4 °C.\n\nB got *more* rain."),
    "<p>A was <strong>warmer</strong> by 1.4 °C.</p><p>B got <em>more</em> rain.</p>");
  assert.equal(renderMarkdown("- one\n- two\n\n1. first\n2) second"),
    "<ul><li>one</li><li>two</li></ul><ol><li>first</li><li>second</li></ol>");
  assert.equal(renderMarkdown("## Temperature\ntext line 1\ntext line 2"), "<h4>Temperature</h4><p>text line 1 text line 2</p>");
  assert.equal(renderMarkdown("<b>x</b> & `a<b`"), "<p>&lt;b&gt;x&lt;/b&gt; &amp; <code>a&lt;b</code></p>");
  assert.equal(renderMarkdown("2 * 3 * 4"), "<p>2 * 3 * 4</p>");   // stray asterisks are not italics
});
