export type MatsuyaBeefYakinikuVariant =
  | 'regular_set'
  | 'rice_large'
  | 'rice_extra_large'
  | 'double_set'
  | 'a_la_carte';

export interface MatsuyaBeefYakinikuIntent {
  variant: MatsuyaBeefYakinikuVariant;
  label: string;
}

const hasExplicitDouble = (name: string): boolean =>
  /牛焼肉\s*(?:W|Ｗ|ダブル)\s*定食/i.test(name)
  || /(?:^|[\s　・（(])(?:W|Ｗ|ダブル)(?:定食)?(?=$|[\s　・）)])/i.test(name);

const isCurrentDoubleNutrition = (parsed: any): boolean => {
  const calories = Number(parsed?.calories);
  const protein = Number(parsed?.protein);
  const fat = Number(parsed?.fat);
  const carbs = Number(parsed?.carbs);
  return Math.abs(calories - 1209) <= 2
    && Math.abs(protein - 38.4) <= 1
    && Math.abs(fat - 80.5) <= 1
    && Math.abs(carbs - 88.1) <= 1;
};

export function detectMatsuyaBeefYakinikuIntent(name: string): MatsuyaBeefYakinikuIntent | null {
  if (!/松屋/.test(name) || !/牛焼肉/.test(name)) return null;

  if (hasExplicitDouble(name)) {
    return { variant: 'double_set', label: '牛焼肉W定食' };
  }
  if (/単品/.test(name)) {
    return { variant: 'a_la_carte', label: '牛焼肉の単品' };
  }
  if (/(?:ご飯|ライス)\s*特盛/.test(name)) {
    return { variant: 'rice_extra_large', label: '通常の牛焼肉定食＋ご飯特盛' };
  }
  if (/(?:ご飯|ライス)\s*大盛(?:り)?/.test(name)) {
    return { variant: 'rice_large', label: '通常の牛焼肉定食＋ご飯大盛' };
  }
  return { variant: 'regular_set', label: '通常の牛焼肉定食' };
}

export function buildMatsuyaIntentInstructions(intent: MatsuyaBeefYakinikuIntent | null): string {
  if (!intent) return '';

  const common = `
【松屋 牛焼肉商品の照合ルール（必須）】
- 今回照合する商品区分は「${intent.label}」、matchedVariantは"${intent.variant}"とする
- 「W定食」「W」「ダブル」が入力に明示された場合だけ肉量2倍のW定食を使う
- 「ご飯大盛」「ご飯特盛」「ライス大盛」「ライス特盛」の「大盛・特盛」はご飯量だけにかかり、肉量は通常のまま。W定食の行や数値を流用しない
- nameは入力に近い料理名だけにし、量・情報源を括弧で付け足さない`;

  if (intent.variant === 'rice_large' || intent.variant === 'rice_extra_large') {
    const riceSize = intent.variant === 'rice_extra_large' ? '特盛' : '大盛';
    return `${common}
- 公式表に「牛焼肉定食 ご飯${riceSize}」の完全一致行がある場合だけ、その行の4数値を転記しcalculationMethod:"exact_product_row"とする
- 完全一致行がない場合は、通常の牛焼肉定食とご飯${riceSize}の根拠を別々に確認して合算する。この場合はcalculationMethod:"combined_components"、sourceType:"web"とし、officialにはしない
- 合算時のnoteは「通常の牛焼肉定食にご飯${riceSize}分を加えた目安です。W定食ではありません。店舗・時期により変動する場合があります。」とする`;
  }

  return `${common}
- 公式栄養成分表の完全一致する商品行を使う場合はcalculationMethod:"exact_product_row"とする`;
}

export function isMatsuyaWebResultCompatible(parsed: any, intent: MatsuyaBeefYakinikuIntent | null): boolean {
  if (!intent) return true;
  if (parsed?.matchedVariant !== intent.variant) return false;

  const resultName = String(parsed?.name || '');
  if (intent.variant !== 'double_set' && hasExplicitDouble(resultName)) return false;
  if (intent.variant === 'double_set' && !hasExplicitDouble(resultName)) return false;
  // 2026-07-14更新の松屋公式値。区分ラベルだけ入力に合わせ、Wの数値を転記した誤照合も拒否する。
  if (intent.variant !== 'double_set' && isCurrentDoubleNutrition(parsed)) return false;

  if (
    (intent.variant === 'rice_large' || intent.variant === 'rice_extra_large')
    && !['exact_product_row', 'combined_components'].includes(parsed?.calculationMethod)
  ) {
    return false;
  }

  return true;
}

export function normalizeMatsuyaRiceResult(
  parsed: any,
  intent: MatsuyaBeefYakinikuIntent | null,
): { forceWeb: boolean; noteOverride?: string } {
  const isRiceSize = intent?.variant === 'rice_large' || intent?.variant === 'rice_extra_large';
  if (!isRiceSize || parsed?.calculationMethod !== 'combined_components') {
    return { forceWeb: false };
  }

  const riceSize = intent.variant === 'rice_extra_large' ? '特盛' : '大盛';
  return {
    forceWeb: true,
    noteOverride: `通常の牛焼肉定食にご飯${riceSize}分を加えた目安です。W定食ではありません。店舗・時期により変動する場合があります。`,
  };
}
