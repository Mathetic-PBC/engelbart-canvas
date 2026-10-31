# Third-party notices

## rmscene

The v6 block layouts (`src/rm/blocks.ts`), the CRDT ordering (`src/rm/crdt.ts`) and the typed-text reading
(`src/rm/text.ts`) follow the structure of rmscene, ported to TypeScript.
<https://github.com/ricklupton/rmscene>

```
MIT License

Copyright (c) 2023 Rick Lupton

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

## Test fixtures (not published)

- `test/fixtures/pages/*.rm`: rmscene's test data, MIT, as above (`test/fixtures/pages/LICENSE-rmscene`).
- `test/fixtures/xochitl/`: a notebook from notable by Robin Berjon, Apache-2.0
  (`test/fixtures/xochitl/LICENSE-notable`). <https://tangled.org/robin.berjon.com/notable>

## Not used

The pen rendering here is written from what the tablet stores per point, not from rmc's pen model, which descends from
LGPL-3.0 code (maxio). No GPL or AGPL code (remarks, Scrybble, rmapi, rmfakecloud, inkstone) was copied.
