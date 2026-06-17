/**
 * 离子反应判定表 —— 中和 / 沉淀 / 气体。
 * 独立于引擎，可单独更新。键使用 config/cards.js 中的离子 id。
 *
 * 同时支持浏览器 (window.REACTIONS) 与 Node (module.exports)。
 */

// 中和反应：自动处理，不判负。两张牌同时进弃牌区。
// 形如 { a, b }，a/b 为离子 id（无序）。
const NEUTRALIZE = [
  { a: 'H', b: 'OH' },
];

// 沉淀反应：cation + anion -> 产物。触发道具阶段。
const PRECIPITATES = [
  { cation: 'Ba', anion: 'SO4', product: 'BaSO₄↓',      note: '白色沉淀' },
  { cation: 'Ba', anion: 'CO3', product: 'BaCO₃↓',      note: '白色沉淀' },
  { cation: 'Ca', anion: 'SO4', product: 'CaSO₄↓',      note: '白色沉淀' },
  { cation: 'Ca', anion: 'CO3', product: 'CaCO₃↓',      note: '白色沉淀' },
  { cation: 'Cu', anion: 'OH',  product: 'Cu(OH)₂↓',    note: '蓝色沉淀' },
  { cation: 'Fe', anion: 'OH',  product: 'Fe(OH)₃↓',    note: '红褐色沉淀' },
  { cation: 'Al', anion: 'OH',  product: 'Al(OH)₃↓',    note: '白色沉淀' },
  { cation: 'Al', anion: 'CO3', product: '—',            note: '双水解，不共存' },
  { cation: 'Ag', anion: 'Cl',  product: 'AgCl↓',        note: '白色沉淀' },
  { cation: 'Ag', anion: 'SO4', product: 'Ag₂SO₄↓',      note: '微溶，白色沉淀' },
  { cation: 'Ba', anion: 'PO4', product: 'Ba₃(PO₄)₂↓',  note: '白色沉淀' },
  { cation: 'Ca', anion: 'PO4', product: 'Ca₃(PO₄)₂↓',  note: '白色沉淀' },
  { cation: 'Ag', anion: 'PO4', product: 'Ag₃PO₄↓',      note: '黄色沉淀' },
  { cation: 'Cu', anion: 'S',   product: 'CuS↓',         note: '黑色沉淀' },
  { cation: 'Ag', anion: 'S',   product: 'Ag₂S↓',        note: '黑色沉淀' },
];

// 气体反应：两离子相遇产生气体。触发道具阶段（加热可解）。
const GASES = [
  { cation: 'H',   anion: 'CO3',  product: 'CO₂↑' },
  { cation: 'H',   anion: 'HCO3', product: 'CO₂↑' },
  { cation: 'H',   anion: 'S',    product: 'H₂S↑' },
  { cation: 'NH4', anion: 'OH',   product: 'NH₃↑' },
];

/**
 * 判定两个离子之间的反应类型。
 * @param {string} x 离子 id
 * @param {string} y 离子 id
 * @returns {null | {type:'neutralize'} | {type:'precipitate'|'gas', cation, anion, product, note}}
 */
function checkPair(x, y) {
  // 中和（无序匹配）
  for (const n of NEUTRALIZE) {
    if ((n.a === x && n.b === y) || (n.a === y && n.b === x)) {
      return { type: 'neutralize' };
    }
  }
  // 沉淀
  for (const p of PRECIPITATES) {
    if ((p.cation === x && p.anion === y) || (p.cation === y && p.anion === x)) {
      return { type: 'precipitate', cation: p.cation, anion: p.anion, product: p.product, note: p.note };
    }
  }
  // 气体
  for (const g of GASES) {
    if ((g.cation === x && g.anion === y) || (g.cation === y && g.anion === x)) {
      return { type: 'gas', cation: g.cation, anion: g.anion, product: g.product };
    }
  }
  return null;
}

const REACTIONS = { NEUTRALIZE, PRECIPITATES, GASES, checkPair };

if (typeof module !== 'undefined' && module.exports) {
  module.exports = REACTIONS;
}
if (typeof window !== 'undefined') {
  window.REACTIONS = REACTIONS;
}
