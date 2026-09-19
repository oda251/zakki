/**
 * 入力欄の吹き出しに既定（折り畳み時）で出す範囲を frozen 配列の [start, end) で返す。
 *
 * アンカー（選択中のチャンク。次の投稿はその直後に入り、そこから数珠繋ぎにリンクされる）を
 * 「最新」とみなし、その直前の件と合わせて size 件を出す。アンカーが無ければ末尾。
 */
export function historyWindow(
  params: { total: number; anchorIndex: number | null },
  size = 2,
): [number, number] {
  const end = params.anchorIndex === null ? params.total : params.anchorIndex + 1;
  return [Math.max(0, end - size), end];
}
