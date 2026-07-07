import { Fragment } from "react";
import { makeTitle } from "@zakki/core/chunk/chunker.ts";
import type { ChunkWithDate } from "@zakki/data/chunk/queries.ts";
import type { SearchHit } from "@zakki/tui/search/index.ts";
import { Chunk } from "./chunk.tsx";

/**
 * 検索ペインの表示（issue #57 で App.tsx から切り出し）。
 * 状態・キー処理は use-search.ts（useSearch）が担い、本コンポーネントは描画だけを担う。
 */
export function SearchPane({
  searchQuery,
  queryDisplay,
  bigramHits,
  extraSemantic,
}: {
  searchQuery: string;
  queryDisplay: { converted: string; pending: string };
  bigramHits: readonly SearchHit[];
  extraSemantic: readonly ChunkWithDate[];
}) {
  return (
    <box style={{ flexDirection: "column", width: "100%", height: "100%" }}>
      <box style={{ height: 1 }}>
        <text>
          検索: {queryDisplay.converted}
          <span fg="#777777">{queryDisplay.pending}</span>
          <span fg="#aaaaaa">▌</span>
        </text>
      </box>
      <Chunk.Surface focused>
        {bigramHits.length === 0 && extraSemantic.length === 0 ? (
          <text style={{ fg: "#888888" }}>
            {searchQuery === "" ? "ローマ字で入力すると絞り込まれます" : "該当なし"}
          </text>
        ) : (
          <Fragment>
            {bigramHits.map((hit) => (
              <box key={hit.id} style={{ flexDirection: "column", marginBottom: 1 }}>
                <text style={{ fg: "#88aaff" }}>{hit.date}</text>
                <text style={{ fg: "#aaaaaa", wrapMode: "word" }}>{hit.content}</text>
              </box>
            ))}
            {extraSemantic.length > 0 && (
              <Fragment>
                <text key="sem-head" style={{ fg: "#666666" }}>
                  ── 意味が近いもの ──
                </text>
                {extraSemantic.map((hit) => (
                  <box key={`sem-${hit.id}`} style={{ flexDirection: "column", marginBottom: 1 }}>
                    <text>
                      <span fg="#88aaff">{hit.date}</span> {makeTitle(hit.content)}
                    </text>
                  </box>
                ))}
              </Fragment>
            )}
          </Fragment>
        )}
      </Chunk.Surface>
      <box style={{ height: 1 }}>
        <text style={{ fg: "#888888" }}>Esc で戻る</text>
      </box>
    </box>
  );
}
