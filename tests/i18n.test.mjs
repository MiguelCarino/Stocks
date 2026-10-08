// Every UI string the code can hand to the dictionary has a translation in each
// locale. The extraction rules live in i18n-coverage.mjs; run that file directly
// for a readable report of what is missing.
import test from 'node:test';
import assert from 'node:assert/strict';
import { coverage, LOCALES, loadDictionary } from './i18n-coverage.mjs';

test('i18n: every extracted UI key is translated in es, pt-BR, ja and ru', () => {
  const { keys, missing } = coverage();
  assert.ok(keys.size > 500, 'the extractor found the UI strings (' + keys.size + ')');
  for (const lc of LOCALES) {
    assert.deepEqual(missing[lc].slice(0, 20), [], lc + ' is missing ' + missing[lc].length + ' keys, e.g. the ones listed');
  }
});

test('i18n: translations keep their {placeholders} and are not empty', () => {
  const { dict } = loadDictionary();
  for (const lc of LOCALES) {
    for (const [k, v] of Object.entries(dict[lc])) {
      assert.equal(typeof v, 'string', lc + ': ' + k);
      assert.ok(v.trim().length > 0, lc + ' has an empty translation for ' + JSON.stringify(k));
      const want = (k.match(/\{\w+\}/g) || []).sort().join(',');
      const got = (v.match(/\{\w+\}/g) || []).sort().join(',');
      assert.equal(got, want, lc + ' placeholders differ for ' + JSON.stringify(k));
    }
  }
});

test('i18n: Japanese says PC, not コンピューター', () => {
  const { dict } = loadDictionary();
  for (const [k, v] of Object.entries(dict.ja)) assert.ok(!v.includes('コンピューター'), 'ja: ' + k);
});
