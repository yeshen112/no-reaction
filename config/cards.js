/**
 * 卡牌配置 —— 集中管理所有离子牌与道具牌的数量。
 * 调整数量只需修改本文件，引擎与 UI 会自动读取。
 *
 * 同时支持浏览器 (window.CARD_CONFIG) 与 Node (module.exports)。
 */

// 阳离子定义：key 为内部 id，symbol 为显示符号，name 为中文名，count 为张数
const CATIONS = {
  Ba:  { symbol: 'Ba²⁺',  name: '钡离子',   charge: 2, count: 2 },
  Ca:  { symbol: 'Ca²⁺',  name: '钙离子',   charge: 2, count: 2 },
  Cu:  { symbol: 'Cu²⁺',  name: '铜离子',   charge: 2, count: 2 },
  Fe:  { symbol: 'Fe³⁺',  name: '铁离子',   charge: 3, count: 2 },
  Ag:  { symbol: 'Ag⁺',   name: '银离子',   charge: 1, count: 2 },
  NH4: { symbol: 'NH₄⁺',  name: '铵根离子', charge: 1, count: 2 },
  H:   { symbol: 'H⁺',    name: '氢离子',   charge: 1, count: 4 },
  Na:  { symbol: 'Na⁺',   name: '钠离子',   charge: 1, count: 2 },
  Al:  { symbol: 'Al³⁺',  name: '铝离子',   charge: 3, count: 2 },
};

// 阴离子定义
const ANIONS = {
  SO4:  { symbol: 'SO₄²⁻', name: '硫酸根',   charge: -2, count: 2 },
  CO3:  { symbol: 'CO₃²⁻', name: '碳酸根',   charge: -2, count: 2 },
  OH:   { symbol: 'OH⁻',   name: '氢氧根',   charge: -1, count: 4 },
  Cl:   { symbol: 'Cl⁻',   name: '氯离子',   charge: -1, count: 2 },
  NO3:  { symbol: 'NO₃⁻',  name: '硝酸根',   charge: -1, count: 2 },
  PO4:  { symbol: 'PO₄³⁻', name: '磷酸根',   charge: -3, count: 2 },
  S:    { symbol: 'S²⁻',   name: '硫离子',   charge: -2, count: 2 },
  HCO3: { symbol: 'HCO₃⁻', name: '碳酸氢根', charge: -1, count: 2 },
};

// 道具牌定义
// kind: defense（防守）/ neutral（中性）/ attack（攻击）
const ITEMS = {
  filter:    { name: '过滤',   count: 3, kind: 'defense', desc: '移走反应区中一对沉淀离子（一个阳离子 + 一个阴离子）；每次只能移走一对' },
  heat:      { name: '加热',   count: 3, kind: 'defense', desc: '移走反应区中一个参与气体反应的离子（仅限气体反应触发时使用）' },
  extract:   { name: '萃取',   count: 2, kind: 'defense', desc: '将反应区中指定的一个离子取回自己手牌，可用于任意类型反应' },
  neutralize:{ name: '中和',   count: 2, kind: 'defense', desc: '手动移走反应区中一个 H⁺ 或一个 OH⁻（仅限 H⁺/OH⁻ 参与的反应）' },
  stir:      { name: '搅拌',   count: 2, kind: 'neutral', desc: '清空整个反应区，所有离子移入弃牌堆' },
  catalyst:  { name: '催化剂', count: 2, kind: 'attack',  desc: '当作离子牌打出（替代本回合的出牌）。不往反应区放任何东西，但使对手下一回合必须出两张离子牌（少于两张则尽力而为）。' },
};

// 初始与游戏设置
const SETTINGS = {
  initialHandSize: 7,
  drawPerTurn: 2,
  defaultPlayers: 2,
};

const CARD_CONFIG = { CATIONS, ANIONS, ITEMS, SETTINGS };

if (typeof module !== 'undefined' && module.exports) {
  module.exports = CARD_CONFIG;
}
if (typeof window !== 'undefined') {
  window.CARD_CONFIG = CARD_CONFIG;
}
