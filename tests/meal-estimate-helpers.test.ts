import assert from 'node:assert/strict';
import test from 'node:test';
import {
  detectMatsuyaBeefYakinikuIntent,
  isMatsuyaWebResultCompatible,
  normalizeMatsuyaRiceResult,
} from '../src/server/meal-estimate-helpers.ts';

test('松屋 牛焼肉定食の入力区分を混同しない', () => {
  const cases = [
    ['松屋 牛焼肉定食', 'regular_set'],
    ['松屋 牛焼肉定食 ご飯大盛', 'rice_large'],
    ['松屋 牛焼肉定食 ライス大盛り', 'rice_large'],
    ['松屋 牛焼肉定食 ご飯特盛', 'rice_extra_large'],
    ['松屋 牛焼肉定食 ライス特盛', 'rice_extra_large'],
    ['松屋 牛焼肉W定食', 'double_set'],
    ['松屋 牛焼肉定食 ダブル', 'double_set'],
    ['松屋 牛焼肉定食 単品', 'a_la_carte'],
  ] as const;

  for (const [input, expected] of cases) {
    assert.equal(detectMatsuyaBeefYakinikuIntent(input)?.variant, expected, input);
  }
  assert.equal(detectMatsuyaBeefYakinikuIntent('うどん'), null);
});

test('ご飯特盛の検索結果としてW定食を拒否する', () => {
  const intent = detectMatsuyaBeefYakinikuIntent('松屋 牛焼肉定食 ご飯特盛');
  assert.equal(isMatsuyaWebResultCompatible({
    name: '松屋 牛焼肉W定食',
    matchedVariant: 'double_set',
    calculationMethod: 'exact_product_row',
  }, intent), false);
  assert.equal(isMatsuyaWebResultCompatible({
    name: '松屋 牛焼肉定食 ご飯特盛',
    matchedVariant: 'rice_extra_large',
    calculationMethod: 'combined_components',
    calories: 1209,
    protein: 38.4,
    fat: 80.5,
    carbs: 88.1,
  }, intent), false);
  assert.equal(isMatsuyaWebResultCompatible({
    name: '松屋 牛焼肉定食 ご飯特盛',
    matchedVariant: 'rice_extra_large',
    calculationMethod: 'combined_components',
    calories: 1100,
    protein: 26,
    fat: 42,
    carbs: 150,
  }, intent), true);
});

test('通常定食とご飯を合算した場合はWeb参照用の注記を付ける', () => {
  const intent = detectMatsuyaBeefYakinikuIntent('松屋 牛焼肉定食 ご飯特盛');
  const normalized = normalizeMatsuyaRiceResult({ calculationMethod: 'combined_components' }, intent);
  assert.equal(normalized.forceWeb, true);
  assert.match(normalized.noteOverride || '', /W定食ではありません/);
});
