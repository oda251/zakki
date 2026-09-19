/**
 * 入力欄の吹き出しに既定（折り畳み時）で出す範囲を frozen 配列の [start, end) で返す。
 *
 * 選択ノードを「最新」とみなし、その直前の件と合わせて size 件を出す（次の投稿は選択ノードから
 * 数珠繋ぎにリンクされるので、続きを書く文脈が見える）。選択が無い・選択が保存済みの最後の
 * チャンクなら末尾を出す: Enter 直後は保存と選択の移動が遅れる（デバウンス）ので、
 * そのあいだも新しい吹き出しを隠さないため。
 */
export function historyWindow(
  params: { total: number; selectedIndex: number | null; savedCount: number },
  size = 2,
): [number, number] {
  const { total, selectedIndex, savedCount } = params;
  const end = selectedIndex === null || selectedIndex >= savedCount - 1 ? total : selectedIndex + 1;
  return [Math.max(0, end - size), end];
}
