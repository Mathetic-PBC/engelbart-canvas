import XCTest
import JavaScriptCore
@testable import EngelbartStage

// The page script's pure parts, tested in JavaScriptCore against the very file a page runs (Resources/page.js). The test
// bodies are test/web-page-marks.test.cjs, test/web-live-stage.test.cjs, test/web-boxes.test.cjs and
// test/selection-card.test.cjs, as they were written (assert → a small harness).

final class PageScriptTests: XCTestCase {
    private func run(_ name: String, _ body: String, file: StaticString = #filePath, line: UInt = #line) {
        let context = JSContext()!
        var failure: String?
        context.exceptionHandler = { _, value in failure = value?.toString() }
        context.evaluateScript(StageResources.pageScript)
        context.evaluateScript(Self.harness)
        context.evaluateScript("(function () { 'use strict';\n\(body)\n})();")
        if let failure { XCTFail("\(name): \(failure)", file: file, line: line) }
    }

    private static let harness = #"""
    var PAGE = globalThis.__engelbartPagePure;
    function same(a, b) {
      if (a === b) return true;
      if (a == null || b == null || typeof a !== 'object' || typeof b !== 'object') return false;
      if (Array.isArray(a) !== Array.isArray(b)) return false;
      const ka = Object.keys(a).filter((k) => a[k] !== undefined), kb = Object.keys(b).filter((k) => b[k] !== undefined);
      if (ka.length !== kb.length) return false;
      return ka.every((k) => same(a[k], b[k]));
    }
    var assert = {
      equal(a, b, m) { if (a !== b) throw new Error((m || 'equal') + ': ' + JSON.stringify(a) + ' !== ' + JSON.stringify(b)); },
      notEqual(a, b, m) { if (a === b) throw new Error((m || 'notEqual') + ': ' + JSON.stringify(a)); },
      deepEqual(a, b, m) { if (!same(a, b)) throw new Error((m || 'deepEqual') + ': ' + JSON.stringify(a) + ' vs ' + JSON.stringify(b)); },
      ok(v, m) { if (!v) throw new Error(m || 'ok'); },
      match(s, re, m) { if (!re.test(s)) throw new Error((m || 'match') + ': ' + s + ' !~ ' + re); },
    };
    var node = (data) => ({ data });
    """#

    func testPageTextAndQuotes() {
        run("page text", #"""
        const text = (...parts) => PAGE.textMap(parts.map(node)).text;
        assert.equal(text('  Hello\n\n  ', '  world ', 'again'), 'Hello world again');
        const map = PAGE.textMap(['a  b', '', ' c'].map(node));
        assert.equal(map.text, 'a b c');
        assert.equal(map.segs.length, 2);
        assert.deepEqual(map.segs[0].map, [0, 1, 3]);
        """#)
        run("anchors", #"""
        function found(page, quote) {
          const at = PAGE.anchor(PAGE.textMap([node(page)]).text, quote);
          return at && { before: PAGE.textMap([node(page)]).text.slice(0, at.start), exact: PAGE.textMap([node(page)]).text.slice(at.start, at.end) };
        }
        const quote = { exact: 'the quick  brown\nfox', prefix: 'once ', suffix: ' jumped' };
        assert.deepEqual(found('Once upon a time the quick brown fox jumped.', quote), { before: 'Once upon a time ', exact: 'the quick brown fox' });
        assert.equal(found('Nothing to see here.', quote), null);
        assert.equal(PAGE.anchor('anything', { exact: '   ', prefix: '', suffix: '' }), null);
        const page = 'Alice said the cat sat on the mat. Later Bob said the cat sat by the door. Then Carol said the cat sat in a box.';
        assert.match(found(page, { exact: 'the cat sat', prefix: 'Later Bob said ', suffix: ' by the door.' }).before, /Later Bob said $/);
        assert.match(found(page, { exact: 'the cat sat', prefix: 'Then Carol said ', suffix: ' in a box.' }).before, /Carol said $/);
        assert.match(found(page, { exact: 'the cat sat', prefix: 'Alice said ', suffix: ' on the mat.' }).before, /^Alice said $/);
        assert.match(found(page, { exact: 'the cat sat', prefix: '', suffix: ' in a box.' }).before, /Carol said $/);
        assert.match(found(page, { exact: 'the cat sat', prefix: '', suffix: '' }).before, /^Alice said $/);
        const q2 = { exact: 'the cat sat', prefix: 'Later Bob said ', suffix: ' by the door.' };
        assert.match(found('Alice said the cat sat on the mat. Later on, Robert said the cat sat by the front door. Then Carol said the cat sat in a box.', q2).before, /Robert said $/);
        assert.match(found('A new opening. Then Carol said the cat sat in a box. Alice said the cat sat on the mat. Later Bob says the cat sat by the door!', q2).before, /Later Bob says $/);
        assert.equal(found('Later Bob said the dog sat by the door.', q2), null);
        """#)
        run("selection to quote", #"""
        const nodes = ['Intro text here. ', 'The ', 'important', ' claim is made. More text follows after it.'].map(node);
        const map = PAGE.textMap(nodes);
        const got = PAGE.quoteOf(map, 1, 0, 3, 6);
        assert.deepEqual(got.quote, { exact: 'The important claim', prefix: 'Intro text here. ', suffix: ' is made. More text follows afte' });
        assert.equal(got.quote.suffix.length, PAGE.CONTEXT);
        const range = PAGE.rangeOf(map, got.start, got.end);
        assert.equal(range.startNode, nodes[1]); assert.equal(range.startOffset, 0);
        assert.equal(range.endNode, nodes[3]); assert.equal(range.endOffset, 6);
        assert.equal(PAGE.quoteOf(map, 0, 16, 1, 4).quote.exact, 'The');
        assert.deepEqual(PAGE.anchor(map.text, got.quote), { start: got.start, end: got.end });
        assert.equal(PAGE.quoteOf(map, 0, 16, 0, 17), null);
        const long = PAGE.textMap([node('x'.repeat(PAGE.MAX_EXACT + 1))]);
        assert.equal(PAGE.quoteOf(long, 0, 0, 0, PAGE.MAX_EXACT + 1), null);
        """#)
    }

    func testWholeWordsAndTextAround() {
        run("whole words", #"""
        const map = PAGE.textMap([node('Once upon a time the future was bright.')]);
        const at = (from, to) => PAGE.quoteOf(map, 0, from, 0, to);
        assert.equal(at(18, 26).quote.exact, 'the future');
        assert.deepEqual(at(18, 26).quote, { exact: 'the future', prefix: 'Once upon a time ', suffix: ' was bright.' });
        assert.equal(at(18, 20).quote.exact, 'the');
        assert.equal(at(17, 24).quote.exact, 'the future');
        assert.equal(at(17, 27).quote.exact, 'the future');
        assert.equal(at(16, 29).quote.exact, 'the future was');
        assert.equal(at(35, 37).quote.exact, 'bright');
        const got = at(18, 26), range = PAGE.rangeOf(map, got.start, got.end);
        assert.deepEqual([range.startOffset, range.endOffset], [17, 27]);
        const words = PAGE.textMap([node("They don't know the café menu.")]);
        assert.equal(PAGE.quoteOf(words, 0, 7, 0, 22).quote.exact, "don't know the café");
        const nodes = ['end', 'Start here', ' and so on'].map(node);
        const m2 = PAGE.textMap(nodes);
        assert.equal(m2.text, 'endStart here and so on');
        assert.equal(PAGE.quoteOf(m2, 1, 0, 1, 8).quote.exact, 'Start here');
        assert.equal(PAGE.quoteOf(m2, 1, 2, 2, 3).quote.exact, 'Start here and');
        const long = PAGE.textMap([node('x'.repeat(PAGE.MAX_EXACT + 10))]);
        assert.equal(PAGE.quoteOf(long, 0, 5, 0, PAGE.MAX_EXACT), null);
        """#)
        run("text around", #"""
        const words = Array.from({ length: 2000 }, (_, i) => `w${i}`).join(' ');
        const start = words.indexOf('w1000 '), end = start + 'w1000'.length;
        const around = PAGE.textAround(words, start, end);
        assert.ok(around.length <= PAGE.PAGE_TEXT && around.length > PAGE.PAGE_TEXT - 20, String(around.length));
        assert.ok(around.includes('w1000'));
        const middle = around.indexOf('w1000') / around.length;
        assert.ok(middle > 0.45 && middle < 0.55, String(middle));
        assert.match(around, /^w\d+ /);
        assert.match(around, / w\d+$/);
        assert.equal(PAGE.textAround('A short page.', 2, 7), 'A short page.');
        assert.ok(PAGE.textAround(words, 100, 100 + 5000).length >= 5200);
        """#)
    }

    func testSections() {
        run("sections", #"""
        assert.equal(PAGE.CHANNELS.section, 'engelbart-page:section');
        assert.equal(PAGE.SECTION, 'engelbart-web-section');
        const text = 'How Users Read on the Web Measuring the Effect of Improved Web Writing To measure the effect of some of the content guidelines, we tested. Results Concise text helped.';
        const start = PAGE.findWords(text, 'to  MEASURE the effect\nof some of the content guidelines');
        assert.equal(start, text.indexOf('To measure'));
        assert.equal(PAGE.findWords(text, 'not on the page'), -1);
        assert.equal(PAGE.findWords(text, '   '), -1);
        const headings = [{ at: 0, level: 1 }, { at: 26, level: 2 }, { at: 120, level: 3 }, { at: text.indexOf('Results'), level: 2 }];
        assert.equal(PAGE.sectionEnd(headings, start), text.indexOf('Results'));
        assert.equal(PAGE.sectionEnd([{ at: 0, level: 2 }, { at: 400, level: 1 }], 10), 400);
        assert.equal(PAGE.sectionEnd([{ at: 50, level: 4 }], 10), 50);
        assert.equal(PAGE.sectionEnd([{ at: 0, level: 2 }], 10), -1);
        assert.equal(PAGE.sectionEnd([{ at: 0, level: 2 }, { at: PAGE.SECTION_MAX + 20, level: 2 }], 10), -1);
        assert.ok(PAGE.SECTION_WAIT >= 2000 && PAGE.SECTION_WAIT <= 4000);
        const twice = 'Menu The target passage. Intro. The target passage lives far below.';
        assert.deepEqual(PAGE.matchWords(twice, 'the TARGET passage').map((m) => m.start), [5, twice.lastIndexOf('The target')]);
        const curly = 'Intro. It’s the target passage — far below “the fold”.';
        const got = PAGE.matchWords(curly, 'It\'s the target passage - far below "the fold"');
        assert.equal(got.length, 1);
        assert.equal(curly.slice(got[0].start, got[0].end), 'It’s the target passage — far below “the fold”');
        const cells = 'Intro. The target passagelives far below. Next.';
        const run = PAGE.matchWords(cells, 'The target passage lives far below');
        assert.equal(cells.slice(run[0].start, run[0].end), 'The target passagelives far below');
        assert.deepEqual(PAGE.matchWords('a b and ab', 'a b').map((m) => m.start), [0]);
        assert.deepEqual(PAGE.matchWords(cells, 'not on the page'), []);
        assert.deepEqual(PAGE.matchWords(cells, ' \n '), []);
        assert.equal(PAGE.findWords(curly, 'the target passage - far'), curly.indexOf('the target'));
        """#)
    }

    func testBoxesInThePage() {
        run("anchor", #"""
        const box = { left: 100, top: 100, width: 200, height: 100 };
        const el = (tag, left, top, width, height) => ({ tag, rect: { left, top, width, height } });
        const html = el('html', 0, 0, 1200, 5000), para = el('p', 90, 90, 230, 130), figure = el('figure', 50, 50, 600, 400), img = el('img', 95, 95, 210, 110);
        assert.equal(PAGE.chooseAnchor([para, html], box), para);
        assert.equal(PAGE.chooseAnchor([para, figure, html], box), figure);
        assert.equal(PAGE.chooseAnchor([img, para, figure, html], box), img);
        assert.equal(PAGE.chooseAnchor([el('span', 100, 100, 20, 10), html], box).tag, 'html');
        assert.equal(PAGE.chooseAnchor([], box), null);
        const f = PAGE.fractionsOf(box, { left: 50, top: 50, width: 400, height: 400 });
        assert.deepEqual(f, { x: 0.125, y: 0.125, w: 0.5, h: 0.25 });
        assert.deepEqual(PAGE.placeIn(f, { x: 0, y: 1000, w: 800, h: 800 }), { x: 100, y: 1100, w: 400, h: 200 });
        """#)
        run("refind", #"""
        const anchor = { selector: 'div:nth-of-type(2) > img:nth-of-type(1)', tag: 'img', src: '/chart.png', text: 'A chart of the results' };
        const box = { anchor, doc: { x: 100, y: 900, w: 300, h: 200, width: 1200 } };
        const same = { id: 'same' }, other = { id: 'other' }, image = { id: 'image' };
        const described = new Map([[same, { tag: 'img', src: '/chart.png', text: 'A chart of the results' }], [other, { tag: 'img', src: '/ad.png', text: 'Buy now' }]]);
        const look = (found, { bySrc = null, width = 1200 } = {}) => ({ bySelector: () => found, describe: (x) => described.get(x), bySrc: (src) => (src === '/chart.png' ? bySrc : null), width });
        assert.deepEqual(PAGE.refind(box, look(same, { bySrc: image })), { how: 'selector', el: same });
        assert.deepEqual(PAGE.refind(box, look(other, { bySrc: image })), { how: 'src', el: image });
        assert.deepEqual(PAGE.refind(box, look(null, { bySrc: image })), { how: 'src', el: image });
        assert.deepEqual(PAGE.refind(box, look(other, { width: 1210 })), { how: 'doc', el: null });
        assert.deepEqual(PAGE.refind(box, look(null, { width: 800 })), { how: 'none', el: null });
        assert.equal(PAGE.refind(box, { ...look(null), bySelector: () => { throw new SyntaxError('bad'); } }).how, 'doc');
        assert.equal(PAGE.refind({ anchor: null, doc: box.doc }, look(same)).how, 'doc');
        assert.ok(PAGE.sameElement(anchor, { tag: 'img', src: '/chart.png', text: 'A chart of the results ' }));
        assert.ok(PAGE.sameElement({ ...anchor, src: '', tag: 'p', text: 'Results improved by 12 percent this year' }, { tag: 'p', src: '', text: 'Results improved by 13 percent this year' }));
        assert.ok(!PAGE.sameElement(anchor, { tag: 'div', src: '/chart.png', text: 'A chart of the results' }));
        assert.ok(!PAGE.sameElement({ ...anchor, src: '', tag: 'p', text: 'Results improved' }, { tag: 'p', src: '', text: 'Something else entirely' }));
        """#)
        run("edges and handles", #"""
        const rects = [{ id: 'big', x: 0, y: 0, w: 400, h: 400 }, { id: 'small', x: 100, y: 100, w: 100, h: 100 }];
        assert.equal(PAGE.boxAt(rects, 0, 200), 'big');
        assert.equal(PAGE.boxAt(rects, -6, 200), 'big');
        assert.equal(PAGE.boxAt(rects, 300, 300), null);
        assert.equal(PAGE.boxAt(rects, 150, 150), null);
        assert.equal(PAGE.boxAt(rects, 100, 150), 'small');
        assert.equal(PAGE.boxAt(rects, 600, 600), null);
        const r = { x: 100, y: 100, w: 200, h: 100 };
        assert.equal(PAGE.handleAt(r, 100, 100), 'nw');
        assert.equal(PAGE.handleAt(r, 304, 203), 'se');
        assert.equal(PAGE.handleAt(r, 200, 96), 'n');
        assert.equal(PAGE.handleAt(r, 299, 150), 'e');
        assert.equal(PAGE.handleAt(r, 150, 150), null);
        assert.equal(PAGE.handleAt(r, 100 + PAGE.HANDLE_HIT + 1, 100), null);
        assert.equal(PAGE.handleAt(null, 0, 0), null);
        const view = { x: 0, y: 0, w: 800, h: 600 };
        assert.deepEqual(PAGE.resizeRect(r, 'se', 50, 20, view), { x: 100, y: 100, w: 250, h: 120 });
        assert.deepEqual(PAGE.resizeRect(r, 'nw', -50, -20, view), { x: 50, y: 80, w: 250, h: 120 });
        assert.deepEqual(PAGE.resizeRect(r, 'e', 30, 99, view), { x: 100, y: 100, w: 230, h: 100 });
        assert.deepEqual(PAGE.resizeRect(r, 's', 99, -30, view), { x: 100, y: 100, w: 200, h: 70 });
        assert.deepEqual(PAGE.resizeRect(r, 'w', 500, 0, view), { x: 300 - PAGE.MIN_BOX, y: 100, w: PAGE.MIN_BOX, h: 100 });
        assert.deepEqual(PAGE.resizeRect(r, 'se', 900, 900, view), { x: 100, y: 100, w: 700, h: 500 });
        assert.deepEqual(PAGE.resizeRect(r, 'nw', -500, -500, view), { x: 0, y: 0, w: 300, h: 200 });
        assert.deepEqual(PAGE.resizeRect({ x: -40, y: 550, w: 200, h: 100 }, 'e', 10, 0, view), { x: 0, y: 550, w: 170, h: 50 });
        assert.deepEqual(Object.keys(PAGE.CURSORS).sort(), PAGE.HANDLES.map(([name]) => name).sort());
        assert.equal(PAGE.EDGE_CURSOR, 'pointer');
        assert.equal(PAGE.cursorFor(null, 'a'), 'pointer');
        assert.equal(PAGE.cursorFor('se', 'a'), 'nwse-resize');
        assert.equal(PAGE.cursorFor(null, null), '');
        const one = [{ id: 'a', x: 100, y: 100, w: 200, h: 100 }];
        assert.equal(PAGE.cursorFor(null, PAGE.boxAt(one, 100 + PAGE.EDGE - 1, 150)), 'pointer');
        assert.equal(PAGE.cursorFor(null, PAGE.boxAt(one, 200, 150)), '');
        """#)
        run("what shows", #"""
        const box = { left: 100, top: 100, width: 300, height: 200 }, viewport = { width: 800, height: 600 };
        const word = (left, top) => ({ left, top, width: 40, height: 16 });
        const calls = [];
        const probe = (visible = true, hits = true) => ({ visible: () => { calls.push('visible'); return visible; }, hits: (x, y) => { calls.push(['hits', x, y]); return hits; } });
        assert.equal(PAGE.shows(word(150, 150), box, viewport, probe()), true);
        assert.deepEqual(calls[calls.length - 1], ['hits', 170, 158]);
        assert.equal(PAGE.shows(word(150, 150), box, viewport, probe(false, true)), false);
        assert.equal(PAGE.shows(word(150, 150), box, viewport, probe(true, false)), false);
        calls.length = 0;
        assert.equal(PAGE.shows(word(385, 150), box, viewport, probe()), false);
        assert.deepEqual(calls, []);
        assert.equal(PAGE.shows(word(150, 650), { left: 100, top: 500, width: 300, height: 400 }, viewport, probe()), false);
        assert.equal(PAGE.shows({ left: 150, top: 150, width: 0, height: 16 }, box, viewport, probe()), false);
        const img = { left: 0, top: 0, width: 160, height: 160 };
        assert.equal(PAGE.shows(img, box, viewport, probe()), false);
        calls.length = 0;
        assert.equal(PAGE.shows(img, box, viewport, probe(), { part: true }), true);
        assert.deepEqual(calls[calls.length - 1], ['hits', 130, 130]);
        assert.equal(PAGE.shows({ left: 500, top: 0, width: 100, height: 100 }, box, viewport, probe(), { part: true }), false);
        assert.deepEqual(PAGE.VISIBILITY, { opacityProperty: true, visibilityProperty: true, contentVisibilityAuto: true });
        """#)
    }

    func testSelectionBoxesAndHighlights() {
        run("selection boxes", #"""
        const at = PAGE.selectionBoxes([
          { left: 40, top: 100, width: 300, height: 16 },
          { left: 40, top: 118, width: 120, height: 16 },
          { left: 160, top: 119, width: 30, height: 14 },
          { left: 0, top: 0, width: 0, height: 0 },
        ]);
        assert.deepEqual(at, { line: { x: 40, y: 118, w: 150, h: 16 }, rect: { x: 40, y: 100, w: 300, h: 34 } });
        assert.equal(PAGE.selectionBoxes([{ left: 1, top: 1, width: 0, height: 0 }]), null);
        assert.ok(PAGE.inRects([{ x: 0, y: 0, w: 10, h: 10 }], 5, 5));
        assert.ok(!PAGE.inRects([{ left: 0, top: 0, width: 10, height: 10 }], 13, 5));
        assert.ok(PAGE.inRects([{ left: 0, top: 0, width: 10, height: 10 }], 13, 5, PAGE.CHIP_SLOP));
        assert.equal(PAGE.highlightAt([{ id: 'a', rects: [{ x: 0, y: 0, w: 10, h: 10 }] }, { id: 'b', rects: [{ x: 5, y: 5, w: 10, h: 10 }] }], 7, 7), 'b');
        assert.deepEqual(PAGE.symbolPlace([{ left: 10, top: 100, width: 200, height: 20 }]), { x: 204.8, y: 91, size: 15 });
        assert.equal(PAGE.symbolPlace([]), null);
        assert.equal(PAGE.SELECTION_SETTLE_MS, 450);
        assert.equal(PAGE.CHIP, 15);
        """#)
    }

    func testPageScriptIsTheElectronOnes() throws {
        // the same channels and names as the Electron preload and main (views.cjs)
        let context = JSContext()!
        context.evaluateScript(StageResources.pageScript)
        let channels = context.evaluateScript("JSON.stringify(globalThis.__engelbartPagePure.CHANNELS)")!.toString()!
        for name in ["engelbart-page:marks", "engelbart-page:quote", "engelbart-page:box-resize", "engelbart-page:selection-card", "engelbart-page:unmark"] {
            XCTAssertTrue(channels.contains(name), name)
        }
        XCTAssertEqual(context.evaluateScript("globalThis.__engelbartPagePure.HIGHLIGHT")?.toString(), BrowserRules.highlightName)
        XCTAssertEqual(context.evaluateScript("globalThis.__engelbartPagePure.MAX_EXACT")?.toInt32(), Int32(BrowserRules.maxExact))
        XCTAssertEqual(context.evaluateScript("globalThis.__engelbartPagePure.PAGE_TEXT")?.toInt32(), Int32(BrowserRules.pageText))
        XCTAssertTrue(BrowserRules.markCSS.contains("::highlight(engelbart-web-mark){background-color:rgba(255,214,0,.22) !important"))
        XCTAssertTrue(BrowserRules.markCSS.contains("text-underline-offset:3px !important}"))
    }
}
