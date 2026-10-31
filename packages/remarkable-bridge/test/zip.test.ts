import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import { RmFormatError } from '../src/doc/json.ts';
import { openRmdoc, rmdocIds } from '../src/sources/rmdoc.ts';
import { readZip, writeZip, type ZipInput } from '../src/zip.ts';
import { decode, DOC_ID, FIXTURES, fixtureRmdocFiles, RM_HEADER, XOCHITL } from './helpers/fixture.ts';

const sample: ZipInput[] = [
  { name: 'hello.txt', bytes: 'hello, world\n'.repeat(50) },
  { name: 'empty', bytes: new Uint8Array() },
  { name: 'dir/binary.bin', bytes: Uint8Array.from({ length: 4096 }, (_, i) => (i * 7919) & 0xff) },
  { name: 'ünïcødé/名前.txt', bytes: 'names are UTF-8' },
];

const asBytes = (input: ZipInput['bytes']) => (typeof input === 'string' ? new TextEncoder().encode(input) : input);

/** Overwrites every occurrence of `from` in `bytes` with `to` (same length). */
function patchAll(bytes: Uint8Array, from: string, to: string): Uint8Array {
  assert.equal(from.length, to.length);
  const out = Uint8Array.from(bytes);
  const needle = Buffer.from(from);
  const buffer = Buffer.from(out.buffer);
  let found = 0;
  for (let at = buffer.indexOf(needle); at !== -1; at = buffer.indexOf(needle, at + 1)) {
    buffer.write(to, at, 'latin1');
    found++;
  }
  assert.ok(found > 0, `"${from}" not found`);
  return out;
}

const endRecord = (bytes: Uint8Array) => Buffer.from(bytes).lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
const centralRecord = (bytes: Uint8Array) => Buffer.from(bytes).indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]));

describe('writeZip and readZip', () => {
  for (const deflate of [false, true]) {
    it(`round-trips files ${deflate ? 'deflated' : 'stored'}`, () => {
      const zip = readZip(writeZip(sample, { deflate }));
      assert.deepEqual(zip.names, sample.map((file) => file.name));
      for (const file of sample) {
        assert.deepEqual(Buffer.from(zip.read(file.name)!), Buffer.from(asBytes(file.bytes)), file.name);
        assert.equal(zip.entry(file.name)!.method, deflate ? 8 : 0);
      }
      assert.equal(zip.read('missing.txt'), null);
      assert.equal(zip.has('hello.txt'), true);
    });
  }

  it('deflates by default, and the output is deterministic', () => {
    const a = writeZip(sample);
    assert.equal(readZip(a).entry('hello.txt')!.method, 8);
    assert.deepEqual(a, writeZip(sample));
    assert.ok(a.length < writeZip(sample, { deflate: false }).length);
  });

  it('reads an archive that sits at an offset inside a larger buffer', () => {
    const bytes = writeZip(sample);
    const padded = new Uint8Array(bytes.length + 100);
    padded.set(bytes, 37);
    assert.equal(decode(readZip(padded.subarray(37, 37 + bytes.length)).read('ünïcødé/名前.txt')), 'names are UTF-8');
  });

  it('catches a CRC mismatch in a stored file', () => {
    const bytes = writeZip([{ name: 'a.txt', bytes: 'hello world' }], { deflate: false });
    const damaged = patchAll(bytes, 'hello world', 'hellO world');
    const zip = readZip(damaged);
    assert.throws(() => zip.read('a.txt'), (error: unknown) => error instanceof RmFormatError && /checksum/.test(error.message));
  });

  it('catches damage inside a deflated file', () => {
    const bytes = writeZip([{ name: 'a.txt', bytes: 'the quick brown fox '.repeat(200) }], { deflate: true });
    const damaged = Uint8Array.from(bytes);
    damaged[30 + 'a.txt'.length + 10]! ^= 0xff;
    assert.throws(() => readZip(damaged).read('a.txt'), RmFormatError);
  });

  for (const [name, why] of [
    ['../evil.sh', /\.\./],
    ['a/../../b.sh', /\.\./],
    ['/etc/passwd', /absolute/],
    ['C:/evil.exe', /absolute/],
    ['a\\..\\b.txt', /backslash/],
  ] as const) {
    it(`rejects the name ${JSON.stringify(name)} when reading and writing`, () => {
      const placeholder = 'x'.repeat(name.length);
      const bytes = patchAll(writeZip([{ name: placeholder, bytes: 'payload' }]), placeholder, name);
      assert.throws(() => readZip(bytes), (error: unknown) => error instanceof RmFormatError && why.test(error.message));
      assert.throws(() => writeZip([{ name, bytes: 'payload' }]), RmFormatError);
    });
  }

  it('rejects duplicate names', () => {
    const bytes = patchAll(writeZip([{ name: 'a.txt', bytes: '1' }, { name: 'b.txt', bytes: '2' }]), 'b.txt', 'a.txt');
    assert.throws(() => readZip(bytes), /twice/);
    assert.throws(() => writeZip([{ name: 'a.txt', bytes: '1' }, { name: 'a.txt', bytes: '2' }]), /twice/);
  });

  it('refuses encryption, ZIP64 and truncation', () => {
    const bytes = writeZip([{ name: 'a.txt', bytes: 'secret' }]);

    const encrypted = Uint8Array.from(bytes);
    encrypted[centralRecord(bytes) + 8]! |= 0x01;
    assert.throws(() => readZip(encrypted), /encrypted/);

    const zip64 = Uint8Array.from(bytes);
    const end = endRecord(bytes);
    Buffer.from(zip64.buffer).writeUInt32LE(0xffffffff, end + 16);
    assert.throws(() => readZip(zip64), /ZIP64/);

    assert.throws(() => readZip(bytes.subarray(0, bytes.length - 5)), RmFormatError);
    assert.throws(() => readZip(bytes.subarray(10)), RmFormatError);
    assert.throws(() => readZip(new TextEncoder().encode('not a zip at all, just some text')), RmFormatError);
  });

  it('refuses a deflated file that claims more than deflate can produce', () => {
    const bytes = Uint8Array.from(writeZip([{ name: 'a.txt', bytes: 'tiny' }]));
    Buffer.from(bytes.buffer).writeUInt32LE(50_000_000, centralRecord(bytes) + 24);
    assert.throws(() => readZip(bytes), /claims more/);
  });

  it('reads a real .rmdoc made by macOS /usr/bin/zip (directory entry, extra fields)', () => {
    const zip = readZip(fs.readFileSync(path.join(FIXTURES, 'sample.rmdoc')));
    assert.ok(zip.names.includes(`${DOC_ID}.metadata`));
    assert.ok(zip.names.includes(`${DOC_ID}.content`));
    assert.ok(!zip.names.includes(`${DOC_ID}/`), 'directory entries are not files');
    const page = `${DOC_ID}/7e1fd0e7-0b74-428e-b174-e9efc8a22859.rm`;
    assert.deepEqual(Buffer.from(zip.read(page)!), fs.readFileSync(path.join(XOCHITL, page)));
  });
});

describe('openRmdoc', () => {
  it('opens the macOS-made sample lazily through openBundle', async () => {
    const bundle = await openRmdoc(fs.readFileSync(path.join(FIXTURES, 'sample.rmdoc')));
    assert.equal(bundle.id, DOC_ID);
    assert.equal(bundle.metadata.name, 'Test');
    assert.equal(bundle.content.pages.length, 12);
    assert.ok(decode(await bundle.page('7e1fd0e7-0b74-428e-b174-e9efc8a22859')).startsWith(RM_HEADER));
    // Listed in .content but not in this archive: a page without ink.
    assert.equal(await bundle.page('21187519-e91e-4c72-b3a1-035fac28e4d3'), null);
    assert.equal(await bundle.source(), null);
  });

  it('opens a deflated .rmdoc written by writeZip, every page intact', async () => {
    const files = fixtureRmdocFiles();
    const bundle = await openRmdoc(writeZip(files));
    assert.equal(bundle.content.pages.length, 12);
    for (const page of bundle.content.pages) {
      const bytes = await bundle.page(page.id);
      assert.ok(decode(bytes).startsWith(RM_HEADER), page.id);
      assert.deepEqual(Buffer.from(bytes!), Buffer.from(asBytes(files.find((f) => f.name === `${DOC_ID}/${page.id}.rm`)!.bytes)));
    }
  });

  it('needs an id when the archive holds several documents, and finds none in an empty one', async () => {
    const other = '00000000-0000-4000-8000-000000000001';
    const files = [...fixtureRmdocFiles(), { name: `${other}.metadata`, bytes: '{"visibleName":"Other","type":"DocumentType"}' }];
    const bytes = writeZip(files);
    assert.deepEqual(rmdocIds(bytes).sort(), [DOC_ID, other].sort());
    await assert.rejects(openRmdoc(bytes), /2 documents/);
    assert.equal((await openRmdoc(bytes, { id: other })).metadata.name, 'Other');
    await assert.rejects(openRmdoc(bytes, { id: '00000000-0000-4000-8000-000000000002' }), /does not contain/);
    await assert.rejects(openRmdoc(writeZip([{ name: 'readme.txt', bytes: 'hi' }])), /no document/);
  });
});
