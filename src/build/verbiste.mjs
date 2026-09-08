/**
 * Verbiste XML → 變位表
 *
 * 資料來源：Verbiste（verbs-fr.xml / conjugation-fr.xml），
 * Copyright (C) 2003-2016 Pierre Sarrazin，授權 GPL-2.0-or-later。
 *
 * **這些檔案不在本 repo 內，也不會被複製進來。** 建置時從本機 vault 讀取，
 * 產物寫進 gitignore 的 data/bank/。理由見 README「資料與授權」。
 *
 * XML 結構固定且淺，所以用手寫的小型掃描器而非通用 parser：
 *   <v><i>infinitif</i><t>模板名</t></v>
 *   <template name="aim:er"><indicative><present><p><i>詞尾</i></p>…
 * 模板名冒號後的長度決定詞幹切點：aim:er → parler 去掉尾端 2 字 → parl。
 */

import { readFile } from 'node:fs/promises';

/** 同一人稱有多套正規形式時的分隔（payer 的 paie ／ paye）。 */
export const VARIANT_SEP = ' ／ ';

const PRONOUNS = ['je', 'tu', 'il', 'nous', 'vous', 'ils'];

/**
 * 助動詞歸屬。Verbiste 的資料不含這項，必須人工指定。
 * 這份清單與 french-exam-generator/tools/conjugate.py 的 AUX_ETRE 一致。
 */
const AUX_ETRE = new Set([
  'aller', 'venir', 'partir', 'arriver', 'rester', 'mourir', 'naître',
  'tomber', 'entrer', 'sortir', 'descendre', 'monter', 'retourner',
  'devenir', 'revenir',
]);

/**
 * 雙助動詞：不及物用 être，及物用 avoir，兩種都對。
 * 本模組一律按 être 產出，並在卡片上掛註記，不讓使用者以為只有一種答案。
 */
const AUX_DUAL = new Set(['descendre', 'entrer', 'monter', 'retourner', 'sortir']);

export const AUX_DUAL_NOTE =
  '雙助動詞：不及物用 être 且過去分詞與主詞配合（elle est montée）；' +
  '及物時用 avoir 且不配合（elle a monté les valises）。此處只呈現 être 這套。';

/** 無人稱動詞：只有第三人稱單數。 */
const IMPERSONAL = new Set(['falloir', 'pleuvoir']);

/**
 * Verbiste 模板 abr:éger 只給了 1990 正字法的 è 形式，缺傳統的 é 形式。
 * 其餘四個 é_er 模板（c:éder／r:égler／réf:érer／décr:éter）都給兩套。
 * 依 fr.wiktionary 的 {{note-é-era}}／{{note-è-era}}，兩種拼法都有效
 * （arrêté Haby du 28 décembre 1976，1990 年正字法修訂確認），故補回傳統形式。
 * 這是有出處的補正，不是猜測。
 */
const TEMPLATE_PATCH = new Set(['abr:éger|indicative/future', 'abr:éger|conditional/present']);

/** 取出 <tag …>…</tag> 的內容，回傳每個出現位置的內文。 */
function blocks(xml, tag) {
  const out = [];
  const open = new RegExp(`<${tag}(?:\\s[^>]*)?>`, 'g');
  let m;
  while ((m = open.exec(xml))) {
    const start = m.index + m[0].length;
    const end = xml.indexOf(`</${tag}>`, start);
    if (end === -1) break;
    out.push({ inner: xml.slice(start, end), attrs: m[0] });
    open.lastIndex = end;
  }
  return out;
}

const textOf = (xml, tag) => {
  const b = blocks(xml, tag);
  return b.length ? b[0].inner.trim() : null;
};

/** verbs-fr.xml → Map<不定式, 模板名> */
export function parseVerbs(xml) {
  const map = new Map();
  for (const { inner } of blocks(xml, 'v')) {
    const inf = textOf(inner, 'i');
    const tpl = textOf(inner, 't');
    if (inf && tpl) map.set(inf, tpl);
  }
  return map;
}

/**
 * conjugation-fr.xml → Map<模板名, {path: [[變體…] × 人稱]}>
 *
 * 一個 <p> 底下可能有多個 <i>：同一人稱的多套正規形式，148 個模板中有 32 個如此。
 * 只取第一個會靜默丟掉第二套，讓變位表謊稱某形式不存在。
 */
export function parseTemplates(xml) {
  const paths = [
    ['indicative', 'present'], ['indicative', 'imperfect'],
    ['indicative', 'future'], ['indicative', 'simple-past'],
    ['conditional', 'present'],
    ['subjunctive', 'present'], ['subjunctive', 'imperfect'],
    ['imperative', 'imperative-present'],
    ['participle', 'present-participle'], ['participle', 'past-participle'],
    ['infinitive', 'infinitive-present'],
  ];
  const out = new Map();
  for (const { inner, attrs } of blocks(xml, 'template')) {
    const name = /name="([^"]+)"/.exec(attrs)?.[1];
    if (!name) continue;
    const t = {};
    for (const [group, leaf] of paths) {
      const g = blocks(inner, group)[0];
      if (!g) continue;
      const node = blocks(g.inner, leaf)[0];
      if (!node) continue;
      t[`${group}/${leaf}`] = blocks(node.inner, 'p').map(({ inner: p }) =>
        blocks(p, 'i').map((i) => i.inner).filter((s) => s.length > 0),
      );
    }
    out.set(name, t);
  }
  return out;
}

function applyPatch(templateName, path, variants) {
  if (!TEMPLATE_PATCH.has(`${templateName}|${path}`)) return variants;
  return variants.map((vs) => {
    const merged = [];
    for (const v of vs) {
      const traditional = v.replace('è', 'é');
      if (traditional !== v && !merged.includes(traditional)) merged.push(traditional);
      if (!merged.includes(v)) merged.push(v);
    }
    return merged;
  });
}

/** 單一時態的六個人稱形式；某人稱無形式時給空字串，絕不填假的。 */
function buildTense(stem, tmpl, templateName, path) {
  const variants = applyPatch(templateName, path, tmpl[path] ?? []);
  return variants.map((vs) => (vs.length ? vs.map((f) => stem + f).join(VARIANT_SEP) : ''));
}

/**
 * 變位一個動詞。查無此字或查無模板時回傳 null，不猜。
 *
 * @param {string} verb 不定式
 * @param {Map<string,string>} verbs
 * @param {Map<string,object>} templates
 */
export function conjugate(verb, verbs, templates) {
  const templateName = verbs.get(verb);
  if (!templateName) return null;
  const tmpl = templates.get(templateName);
  if (!tmpl) return null;

  const suffix = templateName.split(':')[1] ?? '';
  const stem = suffix ? verb.slice(0, verb.length - suffix.length) : verb;
  const b = (path) => buildTense(stem, tmpl, templateName, path);

  return {
    verb,
    template: templateName,
    stem,
    impersonal: IMPERSONAL.has(verb),
    aux: AUX_ETRE.has(verb) ? 'être' : 'avoir',
    auxDual: AUX_DUAL.has(verb),
    simple: {
      'présent': b('indicative/present'),
      'imparfait': b('indicative/imperfect'),
      'futur simple': b('indicative/future'),
      'passé simple': b('indicative/simple-past'),
      'conditionnel présent': b('conditional/present'),
      'subjonctif présent': b('subjunctive/present'),
      'impératif': b('imperative/imperative-present'),
    },
    pastParticiple: b('participle/past-participle'),
    presentParticiple: b('participle/present-participle'),
  };
}

/**
 * 以助動詞 + 過去分詞組出複合時態。Verbiste XML 不含這些。
 *
 * 缺格動詞（如 bruire）連過去分詞都沒有，此時整個複合時態留空，
 * 不組出「ai 」這種助動詞後面空一格的假形式。
 */
export function compound(data, auxTables) {
  const a = auxTables[data.aux].simple;
  const pp = data.pastParticiple.find((f) => f) ?? '';
  const combine = (tense) =>
    a[tense].map((f) => (pp && f ? `${f} ${pp}` : ''));
  return {
    'passé composé': combine('présent'),
    'plus-que-parfait': combine('imparfait'),
    'futur antérieur': combine('futur simple'),
    'conditionnel passé': combine('conditionnel présent'),
    'subjonctif passé': combine('subjonctif présent'),
  };
}

/** 人稱代名詞。impératif 只有 tu/nous/vous 三格，另行處理。 */
export function pronounFor(index) {
  return PRONOUNS[index];
}

export const IMPERATIVE_PRONOUNS = ['tu', 'nous', 'vous'];

/** 讀取 vault 內的 Verbiste 原始檔。找不到就丟錯，由呼叫端決定怎麼提示。 */
export async function loadVerbiste(dir) {
  const [verbsXml, tmplXml] = await Promise.all([
    readFile(`${dir}/verbs-fr.xml`, 'utf8'),
    readFile(`${dir}/conjugation-fr.xml`, 'utf8'),
  ]);
  return { verbs: parseVerbs(verbsXml), templates: parseTemplates(tmplXml) };
}

export { PRONOUNS, IMPERSONAL, AUX_ETRE };
